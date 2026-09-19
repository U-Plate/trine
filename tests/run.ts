import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
import type { FoodItem } from "../shared/types/foods.ts";
import type { MealItem } from "../shared/types/meals.ts";
import type { HallResult } from "../shared/types/school.ts";
import { School } from "../shared/types/school.ts";
import school from "../src/school.ts";
import { hooks } from "../shared/d1/index.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dir, "report.html");

const NUTRITION_FIELDS: (keyof FoodItem)[] = [
  "calories",
  "protein",
  "carbs",
  "totalFat",
  "sodium",
  "sugar",
  "servingSize",
  "saturatedFat",
  "dietaryFiber",
  "cholesterol",
];
const KEY_FIELDS: (keyof FoodItem)[] = ["calories", "protein", "carbs", "totalFat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── In-memory mock DB ─────────────────────────────────────────────────────────
// Mirrors the real D1 tables in boiler_fuel_backend/d1: foods is an upsert-by-id
// table with sentinel defaults; meals is an append-only version history keyed
// (dining_hall, date, meal_time, last_updated); metadata upserts on (school, name).
interface DbFood extends FoodItem {
  school: string;
  isFavoritable?: boolean;
}
interface DbMealRow {
  diningHall: string;
  date: string;
  mealTime: string;
  school: string;
  items: MealItem[];
  hours: string; // stored exactly as production does: JSON.stringify(mealTimeHours)
  lastUpdated: number; // version counter
  unixUpdateTime: number;
}
interface DbMeta {
  _key: string;
  school: string;
  diningHall: string;
  address: string;
  latitude: string;
  longitude: string;
  type: string;
  schedule: string;
}

const db: { foods: DbFood[]; meals: DbMealRow[]; metadata: DbMeta[] } = { foods: [], meals: [], metadata: [] };
const kv = new Map<string, string>(); // mock KV_MENUS storage
const logs: { time: string; msg: string; level: string }[] = [];

function log(msg: string, level = "info") {
  const time = new Date().toLocaleTimeString();
  logs.push({ time, msg, level });
  const prefix = level === "error" ? "✖" : level === "warn" ? "⚠" : level === "success" ? "✔" : "·";
  console.log(`  ${prefix} ${msg}`);
}

// ── Contract checks ───────────────────────────────────────────────────────────
// Each check mirrors something the production backend (boiler_fuel_backend)
// actually does with a school instance. A new school that passes all of these
// can be wired into schools/registry.ts with confidence.
interface ContractCheck {
  name: string;
  ok: boolean;
  detail: string;
}
const contractChecks: ContractCheck[] = [];

function check(name: string, ok: boolean, detail = "") {
  contractChecks.push({ name, ok, detail });
  log(`${name}${detail ? ` — ${detail}` : ""}`, ok ? "success" : "error");
  return ok;
}

// ── Mock environment (what production hands to processMenus) ─────────────────
const kvNamespace = {
  list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
    keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
  }),
  delete: async (name: string) => {
    kv.delete(name);
  },
  get: async (name: string) => kv.get(name) ?? null,
  put: async (name: string, value: string) => {
    kv.set(name, value);
  },
};
const mockEnv: any = { DB: {}, KV_MENUS: kvNamespace, QUEUE: null };

// ── Sentinel helpers ──────────────────────────────────────────────────────────
// The real storeFoodsInD1 binds sentinel defaults instead of NULL, so the harness
// stores the same values and treats them as "missing" during analysis.
function isMissing(f: DbFood, k: keyof FoodItem): boolean {
  const v = f[k];
  if (v == null || v === "") return true;
  if (typeof v === "number" && v === -1) return true;
  if (k === "servingSize" && v === "Unknown") return true;
  if (k === "labels" && v === "[]") return true;
  return false;
}

function displayVal(f: DbFood, k: keyof FoodItem): unknown {
  return isMissing(f, k) ? null : f[k];
}

function applyFoodDefaults(food: FoodItem, schoolCode: string): DbFood {
  // Same defaults the real storeFoodsInD1 binds into the INSERT.
  return {
    id: food.id,
    name: food.name,
    carbs: food.carbs ?? -1,
    protein: food.protein ?? -1,
    sugar: food.sugar ?? -1,
    totalFat: food.totalFat ?? -1,
    calories: food.calories ?? -1,
    servingSize: food.servingSize ?? "Unknown",
    saturatedFat: food.saturatedFat ?? -1,
    addedSugars: food.addedSugars ?? -1,
    ingredients: food.ingredients ?? "",
    labels: food.labels ?? "[]",
    sodium: food.sodium ?? -1,
    dietaryFiber: food.dietaryFiber ?? -1,
    cholesterol: food.cholesterol ?? -1,
    caloriesFromFat: food.caloriesFromFat ?? -1,
    calcium: food.calcium ?? -1,
    iron: food.iron ?? -1,
    isFavoritable: food.isFavoritable != null ? food.isFavoritable : true,
    school: schoolCode,
  };
}

// ── Mock D1 functions (mirror boiler_fuel_backend/d1/{foods,meals,metadata}.ts) ──
const writeStats = {
  foodSchoolCodes: new Set<string>(),
  mealSchoolCodes: new Set<string>(),
  metaSchoolCodes: new Set<string>(),
  mealDates: new Set<string>(),
};

function mockStoreFoodsInD1(foods: FoodItem[], schoolCode: string): boolean {
  if (!foods || foods.length === 0) {
    log(`storeFoodsInD1(): no foods to store for ${schoolCode}`, "warn");
    return false;
  }
  writeStats.foodSchoolCodes.add(schoolCode);
  let inserted = 0,
    updated = 0;
  for (const food of foods) {
    const row = applyFoodDefaults(food, schoolCode);
    const idx = db.foods.findIndex((f) => f.id === food.id);
    if (idx >= 0) {
      db.foods[idx] = row;
      updated++;
    } else {
      db.foods.push(row);
      inserted++;
      trackFoodInserts?.push(String(food.id));
    }
  }
  log(`storeFoodsInD1: inserted=${inserted} updated=${updated} school=${schoolCode}`, "success");
  return true;
}

function latestMealRow(diningHall: string, date: string, mealTime: string): DbMealRow | undefined {
  let best: DbMealRow | undefined;
  for (const r of db.meals) {
    if (r.diningHall !== diningHall || r.date !== date || r.mealTime !== mealTime) continue;
    if (!best || r.lastUpdated > best.lastUpdated) best = r;
  }
  return best;
}

function latestMealRows(): DbMealRow[] {
  const byKey = new Map<string, DbMealRow>();
  for (const r of db.meals) {
    const key = `${r.school}|${r.diningHall}|${r.date}|${r.mealTime}`;
    const cur = byKey.get(key);
    if (!cur || r.lastUpdated > cur.lastUpdated) byKey.set(key, r);
  }
  return [...byKey.values()];
}

function activeCount(row: DbMealRow): number {
  return row.items.filter((i) => !i.deleted).length;
}

// When non-null, mockStoreMealsInD1 records every slot it actually re-inserts.
// Used by the second processMenus pass to detect version churn.
let trackInserts: string[] | null = null;

// When non-null, mockStoreFoodsInD1 records ids it INSERTS (not updates).
// New ids appearing on the second back-to-back run mean the school's food ids
// are not stable, which grows the foods table and strands old meal references.
let trackFoodInserts: string[] | null = null;

function mockStoreMealsInD1(
  diningHall: string,
  date: string,
  meals: MealItem[],
  schoolCode: string,
  mealTime: string,
  mealTimeHours: any,
): boolean {
  if (!diningHall || !date || !schoolCode || !mealTime) {
    log("storeMealsInD1(): missing required parameter", "warn");
    return false;
  }
  writeStats.mealSchoolCodes.add(schoolCode);
  writeStats.mealDates.add(date);

  // 1. Fetch existing data to preserve "deleted" items and check version
  const currentRow = latestMealRow(diningHall, date, mealTime);
  let oldMeals: MealItem[] | null = null;
  let currentVersion = 0;
  if (currentRow) {
    oldMeals = JSON.parse(JSON.stringify(currentRow.items));
    currentVersion = currentRow.lastUpdated > 946684800 ? 0 : currentRow.lastUpdated;
  }

  // 2. Merge: mark items missing from the new fetch as deleted and carry them forward
  if (oldMeals) {
    const newKeys = new Set(meals.map((i) => `${i.id}|${i.station}`));
    for (const oldItem of oldMeals) {
      if (!newKeys.has(`${oldItem.id}|${oldItem.station}`)) {
        oldItem.deleted = true;
        meals.push(oldItem);
      }
    }
  }

  // 3. Skip the insert entirely when nothing changed
  const newMealsStr = JSON.stringify(meals);
  const oldMealsStr = oldMeals ? JSON.stringify(oldMeals) : "";
  if (newMealsStr === oldMealsStr && currentVersion > 0) {
    log(`storeMealsInD1: no changes for ${diningHall}/${mealTime} on ${date} — skipped`);
    return false;
  }

  // Simulate a cached read-path entry (same key format as handlers/menus.ts)
  // so we can verify storeMealsInD1's invalidation prefix actually clears it on
  // every real write. Slots skipped by the no-change check keep their cache.
  const readKey = `school:${schoolCode}-menu-date:${date}-halls:${diningHall}-mealTime:${mealTime}-v:4`;
  kv.set(readKey, "cached");

  const newVersion = currentVersion + 1;
  db.meals.push({
    diningHall,
    date,
    mealTime,
    school: schoolCode,
    items: JSON.parse(newMealsStr),
    // Production stringifies mealTimeHours even though callers already pass a JSON
    // string, so the stored value is double-encoded. Replicate that faithfully.
    hours: JSON.stringify(mealTimeHours),
    lastUpdated: newVersion,
    unixUpdateTime: Math.floor(Date.now() / 1000),
  });
  trackInserts?.push(`${diningHall}/${mealTime}`);

  // 4. Invalidate KV cache entries using the same prefix production uses
  const listPrefix = `school:${schoolCode}-menu-date:${date}-halls:${diningHall}-mealTime:${mealTime}`;
  let invalidated = 0;
  for (const key of [...kv.keys()]) {
    if (key.startsWith(listPrefix)) {
      kv.delete(key);
      invalidated++;
    }
  }

  const active = meals.filter((m) => !m.deleted).length;
  const deleted = meals.length - active;
  log(
    `storeMealsInD1: ${diningHall}/${mealTime} v${newVersion} — ${active} items` +
      (deleted ? `, ${deleted} deleted` : "") +
      (invalidated ? `, invalidated ${invalidated} KV entries` : ""),
    "success",
  );
  return true;
}

function mockStoreMetadataInD1(
  schoolCode: string,
  diningHall: string,
  address: string,
  latitude: string,
  longitude: string,
  type: string,
  schedule: string,
) {
  writeStats.metaSchoolCodes.add(schoolCode);
  const key = `${schoolCode}|${diningHall}`;
  const entry: DbMeta = { _key: key, school: schoolCode, diningHall, address, latitude, longitude, type, schedule };
  const idx = db.metadata.findIndex((m) => m._key === key);
  if (idx >= 0) db.metadata[idx] = entry;
  else db.metadata.push(entry);
  log(`storeMetadataInD1: ${diningHall}`, "success");
}

// Hook into the D1 functions exported by the shared module. The school code
// under test imports these from @uplate/d1/index, so every write it makes in
// production flows through here unchanged.
hooks.storeFoodsInD1 = async (dbInstance, foods, schoolCode) => {
  mockStoreFoodsInD1(foods, schoolCode);
};

hooks.storeMealsInD1 = async (env, menu) => {
  return mockStoreMealsInD1(menu.diningHall, menu.date, menu.meals, menu.school, menu.mealTime, menu.mealTimeHours);
};

hooks.storeMetadataInD1 = async (dbInstance, metadata) => {
  mockStoreMetadataInD1(
    metadata.school,
    metadata.diningHall,
    metadata.address,
    metadata.latitude,
    metadata.longitude,
    metadata.type,
    metadata.schedule,
  );
};

// ── Format validators ─────────────────────────────────────────────────────────
// Production stores hours double-encoded (JSON string of a JSON string); unwrap both layers.
function parseHoursDeep(raw: string): any {
  try {
    let v: any = JSON.parse(raw);
    if (typeof v === "string") v = JSON.parse(v);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// Validates the canonical generalSchedule format:
// { "Breakfast": { "Sunday": { Start: "08:00", End: "10:00" } | null, ... } | null, ... }
// Returns a problem description, or null if the schedule is valid.
function scheduleFormatProblem(raw: string): string | null {
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return "schedule is not valid JSON";
  }
  if (Array.isArray(v)) return "schedule is a raw API array, expected the generalSchedule object format";
  if (v == null || typeof v !== "object") return "schedule is not an object";
  for (const [mealTime, days] of Object.entries(v)) {
    if (days == null) continue;
    if (typeof days !== "object" || Array.isArray(days)) return `"${mealTime}" must be an object or null`;
    const keys = Object.keys(days as object);
    if (keys.some((k) => k === "__typename" || k === "menu_type_id" || k.endsWith("_start") || k.endsWith("_enabled")))
      return `"${mealTime}" contains raw API fields instead of day names`;
    for (const [day, hours] of Object.entries(days as Record<string, any>)) {
      if (!DAY_NAMES.includes(day)) return `unknown day "${day}" under "${mealTime}" (expected Sunday..Saturday)`;
      if (hours == null) continue;
      if (typeof hours.Start !== "string" || typeof hours.End !== "string")
        return `"${mealTime}"/"${day}" is missing Start/End strings`;
    }
  }
  return null;
}

// Validates the HallData shape of a successful pullRawData result. Production
// debugging tools consume this structure directly, so a school that fetches
// fine but returns malformed HallData still breaks the contract.
function hallDataProblem(r: Record<string, any>): string | null {
  if (!Array.isArray(r.foods)) return "foods is not an array";
  for (const f of r.foods) {
    if (!f || typeof f.id !== "string" || !f.id || typeof f.name !== "string" || !f.name.trim())
      return "foods contain entries without a non-empty string id/name";
  }
  if (!r.meals || typeof r.meals !== "object" || Array.isArray(r.meals)) return "meals is not a Record<mealTime, MealItem[]>";
  for (const [mt, items] of Object.entries(r.meals)) {
    if (!Array.isArray(items)) return `meals["${mt}"] is not an array`;
    for (const i of items as any[]) {
      if (!i || i.id == null || i.id === "") return `meals["${mt}"] has items without an id`;
    }
  }
  if (!r.mealTimeHours || typeof r.mealTimeHours !== "object") return "mealTimeHours is missing";
  for (const [mt, hours] of Object.entries(r.mealTimeHours)) {
    if (typeof hours !== "string") return `mealTimeHours["${mt}"] is not a JSON string`;
    try {
      JSON.parse(hours);
    } catch {
      return `mealTimeHours["${mt}"] is not valid JSON`;
    }
  }
  const meta = r.metadata;
  if (!meta || ["address", "latitude", "longitude", "schedule"].some((k) => typeof meta[k] !== "string"))
    return "metadata is missing address/latitude/longitude/schedule strings";
  return null;
}

// ── Warning detection ─────────────────────────────────────────────────────────
interface Warning {
  level: "error" | "warn" | "info";
  category: string;
  title: string;
  detail: string;
}

function detectWarnings(
  run2Changes: string[],
  kvLeftovers: string[],
  rawHalls: HallResult[],
  run2FoodInserts: string[],
): Warning[] {
  const warnings: Warning[] = [];
  const latest = latestMealRows();
  const expectedCode = school.getSchoolCode();

  // Contract check failures become errors so the harness exit code reflects them
  for (const c of contractChecks) {
    if (!c.ok) warnings.push({ level: "error", category: "contract", title: c.name, detail: c.detail });
  }

  // ── Write consistency ──
  const wrongCodes = [
    ...writeStats.foodSchoolCodes,
    ...writeStats.mealSchoolCodes,
    ...writeStats.metaSchoolCodes,
  ].filter((c) => c !== expectedCode);
  if (wrongCodes.length)
    warnings.push({
      level: "error",
      category: "contract",
      title: `D1 writes used school code(s) ${[...new Set(wrongCodes)].join(", ")} but getSchoolCode() is "${expectedCode}"`,
      detail: "The app routes every read by school code; mismatched writes are invisible to users.",
    });

  const badDates = [...writeStats.mealDates].filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
  if (badDates.length)
    warnings.push({
      level: "error",
      category: "contract",
      title: `Meals stored with non-YYYY-MM-DD date(s): ${badDates.join(", ")}`,
      detail: "The read path and cache keys assume YYYY-MM-DD.",
    });

  // processMenus(env, 0) must store today's menu. A well-formed but wrong date
  // (timezone/offset arithmetic bug) passes the format check, so verify the
  // stored dates actually sit near the current date.
  const farDates = [...writeStats.mealDates].filter((d) => {
    const t = Date.parse(`${d}T12:00:00Z`);
    return !Number.isNaN(t) && Math.abs(t - Date.now()) > 2 * 86400e3;
  });
  if (farDates.length)
    warnings.push({
      level: "error",
      category: "contract",
      title: `Meals stored under date(s) far from today: ${farDates.join(", ")}`,
      detail: "processMenus(env, 0) should store the current date — check the school's timezone/offset math.",
    });

  // ── Meal item shape (the merge/versioning logic keys on id|station) ──
  const missingId = latest.filter((m) => m.items.some((i) => !i.deleted && (i.id == null || i.id === "")));
  if (missingId.length)
    warnings.push({
      level: "error",
      category: "meals",
      title: `${missingId.length} slot(s) contain items without an id`,
      detail: missingId.map((m) => `${m.diningHall}/${m.mealTime}`).join(", "),
    });

  const missingStation = latest.filter((m) => m.items.some((i) => !i.deleted && i.station == null));
  if (missingStation.length)
    warnings.push({
      level: "warn",
      category: "meals",
      title: `${missingStation.length} slot(s) contain items without a station`,
      detail:
        "The deleted-item merge keys on id|station; missing stations weaken it: " +
        missingStation.map((m) => `${m.diningHall}/${m.mealTime}`).join(", "),
    });

  const dupSlots: string[] = [];
  for (const m of latest) {
    const seen = new Set<string>();
    for (const i of m.items) {
      if (i.deleted) continue;
      const k = `${i.id}|${i.station}`;
      if (seen.has(k)) {
        dupSlots.push(`${m.diningHall}/${m.mealTime}`);
        break;
      }
      seen.add(k);
    }
  }
  if (dupSlots.length)
    warnings.push({
      level: "error",
      category: "meals",
      title: `${dupSlots.length} slot(s) stored duplicate id|station entries`,
      detail:
        "Production's deleted-item merge assumes unique keys; dedupe before storing: " + dupSlots.join(", "),
    });

  // ── Referential integrity: meal items should point at stored foods ──
  const foodIds = new Set(db.foods.map((f) => f.id));
  const orphanIds = new Set<string>();
  let totalItems = 0;
  for (const m of latest) {
    for (const i of m.items) {
      if (i.deleted) continue;
      totalItems++;
      if (i.id != null && !foodIds.has(String(i.id))) orphanIds.add(String(i.id));
    }
  }
  if (orphanIds.size) {
    const pct = totalItems ? Math.round((orphanIds.size / totalItems) * 100) : 0;
    warnings.push({
      level: pct > 30 ? "error" : "warn",
      category: "meals",
      title: `${orphanIds.size} meal item id(s) have no matching row in foods`,
      detail: `The app cannot show nutrition for these. Examples: ${[...orphanIds].slice(0, 5).join(", ")}`,
    });
  }

  // ── Meals halls should have metadata (catches slug-vs-display-name drift) ──
  const metaHalls = new Set(db.metadata.map((m) => m.diningHall));
  const hallsWithMeals = [...new Set(latest.filter((m) => activeCount(m) > 0).map((m) => m.diningHall))];
  const orphanHalls = hallsWithMeals.filter((h) => !metaHalls.has(h));
  if (orphanHalls.length)
    warnings.push({
      level: "warn",
      category: "metadata",
      title: `${orphanHalls.length} hall(s) have meals but no metadata row`,
      detail:
        "Meals and metadata must use the same hall name (slug vs display name?): " + orphanHalls.join(", "),
    });

  // ── Foods data quality ──
  const noNutrition = db.foods.filter((f) => NUTRITION_FIELDS.every((k) => isMissing(f, k)));
  if (noNutrition.length)
    warnings.push({
      level: "error",
      category: "foods",
      title: `${noNutrition.length} food(s) have zero nutrition data`,
      detail:
        (noNutrition.length === db.foods.length
          ? "ALL foods are empty — the nutrition endpoint is likely returning empty/unauthorized payloads that the school code swallows silently. "
          : "") +
        noNutrition
          .slice(0, 5)
          .map((f) => f.name)
          .join(", ") +
        (noNutrition.length > 5 ? ` +${noNutrition.length - 5} more` : ""),
    });

  const missingKey = db.foods.filter((f) => KEY_FIELDS.every((k) => isMissing(f, k)));
  if (missingKey.length)
    warnings.push({
      level: "warn",
      category: "foods",
      title: `${missingKey.length} food(s) missing all key fields (cal/protein/carbs/fat)`,
      detail:
        missingKey
          .slice(0, 4)
          .map((f) => f.name)
          .join(", ") + (missingKey.length > 4 ? ` +${missingKey.length - 4} more` : ""),
    });

  const noServing = db.foods.filter((f) => isMissing(f, "servingSize"));
  const noServingPct = db.foods.length ? Math.round((noServing.length / db.foods.length) * 100) : 0;
  if (noServingPct > 0)
    warnings.push({
      level: noServingPct > 50 ? "warn" : "info",
      category: "foods",
      title: `${noServing.length} food(s) (${noServingPct}%) missing serving size`,
      detail: noServing
        .slice(0, 4)
        .map((f) => f.name)
        .join(", "),
    });

  const noIngPct = db.foods.length
    ? Math.round((db.foods.filter((f) => isMissing(f, "ingredients")).length / db.foods.length) * 100)
    : 0;
  if (noIngPct > 60)
    warnings.push({
      level: "info",
      category: "foods",
      title: `${noIngPct}% of foods have no ingredients string`,
      detail: "May be expected; verify API is returning ingredients.",
    });

  // ── Meal slot coverage ──
  const emptySlots = latest.filter((m) => activeCount(m) === 0);
  if (emptySlots.length)
    warnings.push({
      level: "warn",
      category: "meals",
      title: `${emptySlots.length} meal slot(s) stored with 0 items`,
      detail: emptySlots.map((m) => `${m.diningHall}/${m.mealTime}`).join(", "),
    });

  const hallGroups: Record<string, DbMealRow[]> = {};
  for (const m of latest) {
    if (!hallGroups[m.diningHall]) hallGroups[m.diningHall] = [];
    hallGroups[m.diningHall].push(m);
  }
  for (const [hall, entries] of Object.entries(hallGroups)) {
    if (entries.every((e) => activeCount(e) === 0))
      warnings.push({
        level: "error",
        category: "meals",
        title: `${hall}: no items across all meal times`,
        detail: "API returned empty data or the hall is closed.",
      });
  }

  const tinySlots = latest.filter((m) => activeCount(m) > 0 && activeCount(m) < 3);
  if (tinySlots.length)
    warnings.push({
      level: "info",
      category: "meals",
      title: `${tinySlots.length} meal slot(s) have fewer than 3 items`,
      detail: tinySlots.map((m) => `${m.diningHall}/${m.mealTime}: ${activeCount(m)}`).join(", "),
    });

  const noHours = latest.filter((m) => {
    if (activeCount(m) === 0) return false;
    const h = parseHoursDeep(m.hours);
    return !h || !h.Start || !h.End;
  });
  if (noHours.length)
    warnings.push({
      level: "warn",
      category: "meals",
      title: `${noHours.length} open meal slot(s) missing hours`,
      detail: noHours.map((m) => `${m.diningHall}/${m.mealTime}`).join(", "),
    });

  const badHours = latest.filter((m) => {
    const h = parseHoursDeep(m.hours);
    if (!h?.Start || !h?.End) return false;
    return Number.isNaN(Date.parse(h.Start)) || Number.isNaN(Date.parse(h.End));
  });
  if (badHours.length)
    warnings.push({
      level: "error",
      category: "meals",
      title: `${badHours.length} slot(s) have unparseable hours`,
      detail:
        "Start/End must be Date-parseable strings: " +
        badHours.map((m) => `${m.diningHall}/${m.mealTime}`).join(", "),
    });

  // ── Versioning behavior ──
  if (run2Changes.length)
    warnings.push({
      level: "error",
      category: "meals",
      title: `${run2Changes.length} slot(s) re-inserted a new version on the second processMenus run`,
      detail:
        "Every cron run would write a new history row. Likely non-deterministic item ordering or merge instability (could be transient if the API changed between runs): " +
        run2Changes.slice(0, 6).join(", ") +
        (run2Changes.length > 6 ? ` +${run2Changes.length - 6} more` : ""),
    });

  const withDeleted = latest.filter((m) => m.items.some((i) => i.deleted));
  if (withDeleted.length)
    warnings.push({
      level: "warn",
      category: "meals",
      title: `${withDeleted.length} slot(s) carry deleted items after back-to-back runs`,
      detail:
        "The merge marked items deleted across two immediate runs — check id|station key stability: " +
        withDeleted.map((m) => `${m.diningHall}/${m.mealTime}`).join(", "),
    });

  // ── Hours semantics (a parseable timestamp can still be wrong) ──
  const reversedHours: string[] = [];
  const offDateHours: string[] = [];
  for (const m of latest) {
    const h = parseHoursDeep(m.hours);
    if (!h?.Start || !h?.End) continue;
    const start = Date.parse(h.Start);
    const end = Date.parse(h.End);
    if (Number.isNaN(start) || Number.isNaN(end)) continue; // unparseable hours flagged above
    if (end <= start) reversedHours.push(`${m.diningHall}/${m.mealTime}`);
    const slotNoon = Date.parse(`${m.date}T12:00:00Z`);
    if (!Number.isNaN(slotNoon) && Math.abs(start - slotNoon) > 36 * 3600 * 1000)
      offDateHours.push(`${m.diningHall}/${m.mealTime} (${h.Start})`);
  }
  if (reversedHours.length)
    warnings.push({
      level: "error",
      category: "meals",
      title: `${reversedHours.length} slot(s) have hours that end before they start`,
      detail: reversedHours.join(", "),
    });
  if (offDateHours.length)
    warnings.push({
      level: "warn",
      category: "meals",
      title: `${offDateHours.length} slot(s) have hours that fall on a different date than the slot`,
      detail: "Likely a timezone-offset bug when building mealTimeHours: " + offDateHours.slice(0, 4).join(", "),
    });

  // ── Foods: structural quality ──
  const badIdFoods = db.foods.filter(
    (f) => typeof f.id !== "string" || !f.id || typeof f.name !== "string" || !f.name.trim(),
  );
  if (badIdFoods.length)
    warnings.push({
      level: "error",
      category: "foods",
      title: `${badIdFoods.length} food(s) stored without a non-empty string id/name`,
      detail: "D1 upserts key on id and the app displays name; both must be non-empty strings.",
    });

  const badLabelFoods = db.foods.filter((f) => {
    try {
      const v = JSON.parse(f.labels || "[]");
      return !Array.isArray(v) || v.some((x: unknown) => typeof x !== "string");
    } catch {
      return true;
    }
  });
  if (badLabelFoods.length)
    warnings.push({
      level: "error",
      category: "foods",
      title: `${badLabelFoods.length} food(s) have labels that are not a JSON string array`,
      detail:
        "The app JSON.parses labels and renders each as a tag: " +
        badLabelFoods.slice(0, 4).map((f) => `${f.name}=${String(f.labels).slice(0, 40)}`).join(", "),
    });

  if (db.foods.length > 0 && db.foods.every((f) => isMissing(f, "labels")))
    warnings.push({
      level: "info",
      category: "foods",
      title: "No food has any trait/allergen labels",
      detail: "May be expected, but verify the trait/allergen pipeline is wired up.",
    });

  // ── Foods: value plausibility (catches parsing the wrong number, e.g. a
  // % Daily Value column instead of grams, or sign/unit mix-ups) ──
  const NUMERIC_FIELDS: (keyof FoodItem)[] = [...NUTRITION_FIELDS.filter((k) => k !== "servingSize"), "caloriesFromFat", "calcium", "iron", "addedSugars"];
  const MAXIMA: Partial<Record<keyof FoodItem, number>> = {
    calories: 3000,
    protein: 500,
    carbs: 1000,
    totalFat: 500,
    sodium: 20000,
  };
  const implausible: string[] = [];
  for (const f of db.foods) {
    for (const k of NUMERIC_FIELDS) {
      const v = f[k];
      if (typeof v !== "number" || isMissing(f, k)) continue;
      if (v < 0 || (MAXIMA[k] != null && v > MAXIMA[k]!)) {
        implausible.push(`${f.name}: ${String(k)}=${v}`);
        break;
      }
    }
  }
  if (implausible.length)
    warnings.push({
      level: "warn",
      category: "foods",
      title: `${implausible.length} food(s) have implausible nutrition values`,
      detail: implausible.slice(0, 5).join(", "),
    });

  // Macro consistency: calories should roughly equal 4·(carbs+protein) + 9·fat.
  // Very loose bounds — fiber, alcohol and rounding all add noise — so a hit
  // usually means the parser read the wrong column or unit.
  const inconsistent: string[] = [];
  for (const f of db.foods) {
    if (KEY_FIELDS.some((k) => isMissing(f, k))) continue;
    const cal = Number(f.calories);
    if (!(cal >= 50)) continue;
    const est = 4 * (Number(f.carbs) + Number(f.protein)) + 9 * Number(f.totalFat);
    if (est > cal * 1.75 + 120 || est < cal * 0.35 - 120)
      inconsistent.push(`${f.name} (${cal} cal vs ~${Math.round(est)} from macros)`);
  }
  if (inconsistent.length)
    warnings.push({
      level: "warn",
      category: "foods",
      title: `${inconsistent.length} food(s) have calories inconsistent with their macros`,
      detail: inconsistent.slice(0, 5).join(", "),
    });

  // ── Cross-phase consistency: items seen in pullRawData should survive the
  // processMenus → storeMealsInD1 path (catches silent per-hall error
  // swallowing inside processMenus) ──
  const storedHallsWithItems = new Set(latest.filter((m) => activeCount(m) > 0).map((m) => m.diningHall));
  const lostHalls: string[] = [];
  for (const r of rawHalls) {
    if (!r.ok || !r.meals || typeof r.meals !== "object") continue;
    const rawCount = Object.values(r.meals).reduce((n, items) => n + (Array.isArray(items) ? items.length : 0), 0);
    if (rawCount > 0 && !storedHallsWithItems.has(r.hall)) lostHalls.push(`${r.hall} (${rawCount} raw items)`);
  }
  if (lostHalls.length)
    warnings.push({
      level: "warn",
      category: "meals",
      title: `${lostHalls.length} hall(s) returned items in pullRawData but stored none via processMenus`,
      detail:
        "Could be a transient API change between phases, or processMenus is swallowing a per-hall failure: " +
        lostHalls.join(", "),
    });

  // ── Food id stability across back-to-back runs ──
  if (run2FoodInserts.length)
    warnings.push({
      level: "warn",
      category: "foods",
      title: `${run2FoodInserts.length} new food id(s) appeared on the second processMenus run`,
      detail:
        "Unstable ids grow the foods table and strand older meal references: " +
        run2FoodInserts.slice(0, 5).join(", "),
    });

  // ── Every declared hall should have a metadata row after fetchMetadata ──
  const declaredMissingMeta = (school.getDiningHalls() ?? []).filter((h: string) => !metaHalls.has(h));
  if (db.metadata.length > 0 && declaredMissingMeta.length)
    warnings.push({
      level: "warn",
      category: "metadata",
      title: `${declaredMissingMeta.length} hall(s) from getDiningHalls() have no metadata row`,
      detail: "fetchMetadata should cover every declared hall: " + declaredMissingMeta.join(", "),
    });

  if (kvLeftovers.length)
    warnings.push({
      level: "error",
      category: "cache",
      title: `${kvLeftovers.length} KV cache entries were NOT invalidated by storeMealsInD1`,
      detail:
        "The invalidation prefix no longer matches the read-path cache key format: " + kvLeftovers.slice(0, 3).join(", "),
    });

  // ── Metadata quality ──
  for (const meta of db.metadata) {
    if (!meta.latitude || !meta.longitude)
      warnings.push({
        level: "warn",
        category: "metadata",
        title: `${meta.diningHall} missing coordinates`,
        detail: "lat/long required for map display.",
      });
    else if (Number.isNaN(parseFloat(meta.latitude)) || Number.isNaN(parseFloat(meta.longitude)))
      warnings.push({
        level: "error",
        category: "metadata",
        title: `${meta.diningHall} has non-numeric coordinates`,
        detail: `latitude="${meta.latitude}" longitude="${meta.longitude}"`,
      });
    if (!meta.address)
      warnings.push({ level: "info", category: "metadata", title: `${meta.diningHall} has no address`, detail: "" });

    const problem = scheduleFormatProblem(meta.schedule || "{}");
    if (problem)
      warnings.push({
        level: "error",
        category: "metadata",
        title: `${meta.diningHall}: schedule is not in the canonical generalSchedule format`,
        detail: problem,
      });
  }

  if (db.metadata.length === 0) {
    warnings.push({
      level: "error",
      category: "metadata",
      title: "No dining hall metadata was stored in D1",
      detail: "Neither processMenus nor fetchMetadata stored metadata.",
    });
  }

  if (db.foods.length === 0) {
    warnings.push({
      level: "error",
      category: "foods",
      title: "No food items were stored in D1",
      detail: "processMenus never called storeFoodsInD1 (or it failed).",
    });
  }

  if (db.meals.length === 0) {
    warnings.push({
      level: "error",
      category: "meals",
      title: "No meals were stored in D1",
      detail: "processMenus never called storeMealsInD1 (or it failed).",
    });
  }

  return warnings;
}

// ── HTML generation ───────────────────────────────────────────────────────────
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateReport(date: string, hallResults: HallResult[], warnings: Warning[]): string {
  const latest = latestMealRows();
  const errors = warnings.filter((w) => w.level === "error").length;
  const warns = warnings.filter((w) => w.level === "warn").length;
  const emptySlots = latest.filter((m) => activeCount(m) === 0).length;
  const missingNutrition = db.foods.filter((f) => KEY_FIELDS.every((k) => isMissing(f, k))).length;
  const contractFails = contractChecks.filter((c) => !c.ok).length;

  const statusBadge =
    errors > 0
      ? `<span class="badge badge-error">${errors} Error${errors > 1 ? "s" : ""}</span>`
      : warns > 0
        ? `<span class="badge badge-warn">${warns} Warning${warns > 1 ? "s" : ""}</span>`
        : `<span class="badge badge-ok">All Clear</span>`;

  const contractRows = contractChecks
    .map(
      (c) =>
        `<tr class="${c.ok ? "ok" : "fail"}"><td class="status-cell">${c.ok ? "✔" : "✖"}</td><td><strong>${esc(c.name)}</strong>${c.detail ? `<br><small>${esc(c.detail)}</small>` : ""}</td></tr>`,
    )
    .join("");

  const fetchRows = hallResults
    .map(
      (r) =>
        `<tr class="${r.ok ? "ok" : "fail"}"><td>${esc(r.hall)}</td><td class="status-cell">${r.ok ? "✔" : "✖"}</td><td>${esc(r.ok ? "ok" : r.error)}</td></tr>`,
    )
    .join("");

  const warningRows =
    warnings.length === 0
      ? `<tr><td colspan="3" class="empty-cell">No issues detected</td></tr>`
      : warnings
          .map((w) => {
            const icon = w.level === "error" ? "✖" : w.level === "warn" ? "⚠" : "ℹ";
            return `<tr class="warning-${w.level}">
          <td><span class="icon-${w.level}">${icon}</span></td>
          <td><strong>${esc(w.title)}</strong>${w.detail ? `<br><small>${esc(w.detail)}</small>` : ""}</td>
          <td><span class="tag tag-${w.level === "info" ? "blue" : w.level === "warn" ? "yellow" : "red"}">${w.category}</span></td>
        </tr>`;
          })
          .join("");

  const foodCell = (v: unknown, warn = false, err = false) =>
    v == null || v === ""
      ? `<td class="missing">—</td>`
      : `<td class="${err ? "err" : warn ? "warn" : ""}">${esc(v)}</td>`;

  const nutritionCells = (f: DbFood) => `
          ${foodCell(displayVal(f, "calories"), false, isMissing(f, "calories"))}
          ${foodCell(displayVal(f, "protein"))}${foodCell(displayVal(f, "carbs"))}${foodCell(displayVal(f, "totalFat"))}${foodCell(displayVal(f, "sodium"))}${foodCell(displayVal(f, "sugar"))}
          ${foodCell(displayVal(f, "servingSize"), isMissing(f, "servingSize"))}
          ${foodCell(displayVal(f, "saturatedFat"))}${foodCell(displayVal(f, "dietaryFiber"))}${foodCell(displayVal(f, "cholesterol"))}`;

  const coverageCell = (f: DbFood) => {
    const present = NUTRITION_FIELDS.filter((k) => !isMissing(f, k)).length;
    const pct = Math.round((present / NUTRITION_FIELDS.length) * 100);
    const barColor = pct >= 80 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
    return `<td><div class="bar-wrap"><span style="color:${barColor};font-weight:600;font-size:11px;min-width:32px">${pct}%</span><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor}"></div></div></div></td>`;
  };

  const labelsCell = (f: DbFood) => {
    const labels: string[] = (() => {
      try {
        return JSON.parse(f.labels || "[]");
      } catch {
        return [];
      }
    })();
    return `<td>${labels.length ? labels.map((l) => `<span class="tag tag-blue">${esc(l)}</span>`).join(" ") : '<span class="missing">none</span>'}</td>`;
  };

  const foodRows =
    db.foods.length === 0
      ? `<tr><td colspan="17" class="empty-cell">No food data</td></tr>`
      : db.foods
          .map(
            (f) => `<tr>
          <td class="id-cell" title="${esc(f.id)}">${esc(f.id.substring(0, 12))}…</td>
          <td class="name-cell">${esc(f.name)}</td>
          ${nutritionCells(f)}
          ${foodCell(displayVal(f, "caloriesFromFat"))}${foodCell(displayVal(f, "calcium"))}${foodCell(displayVal(f, "iron"))}
          ${labelsCell(f)}
          ${coverageCell(f)}
        </tr>`,
          )
          .join("");

  const mealRows =
    latest.length === 0
      ? `<tr><td colspan="8" class="empty-cell">No meal data</td></tr>`
      : latest
          .map((m) => {
            let hoursStr = "—";
            const h = parseHoursDeep(m.hours);
            if (h?.Start && h?.End) {
              const fmt = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              hoursStr = `${fmt(h.Start)} – ${fmt(h.End)}`;
            }
            const act = activeCount(m);
            const del = m.items.length - act;
            const statusTag =
              act === 0
                ? `<span class="tag tag-red">empty</span>`
                : act < 3
                  ? `<span class="tag tag-yellow">low (${act})</span>`
                  : `<span class="tag tag-green">ok (${act})</span>`;
            return `<tr class="${act === 0 ? "row-empty" : ""}"><td>${esc(m.diningHall)}</td><td><span class="tag tag-blue">${esc(m.mealTime)}</span></td><td>${act}</td><td>${del ? `<span class="tag tag-red">${del}</span>` : "0"}</td><td>v${m.lastUpdated}</td><td>${hoursStr}</td><td>${esc(m.school)}</td><td>${statusTag}</td></tr>`;
          })
          .join("");

  const metaRows =
    db.metadata.length === 0
      ? `<tr><td colspan="5" class="empty-cell">No metadata</td></tr>`
      : db.metadata
          .map((m) => {
            const schedProblem = scheduleFormatProblem(m.schedule || "{}");
            const schedTag = schedProblem
              ? `<span class="tag tag-red" title="${esc(schedProblem)}">invalid</span>`
              : m.schedule && m.schedule !== "{}"
                ? '<span class="tag tag-green">present</span>'
                : '<span class="tag tag-gray">empty</span>';
            return `<tr>
        <td>${esc(m.diningHall)}</td>
        <td>${m.address || '<span class="missing">—</span>'}</td>
        <td class="${!m.latitude ? "warn" : ""}">${m.latitude || '<span class="missing">—</span>'}</td>
        <td class="${!m.longitude ? "warn" : ""}">${m.longitude || '<span class="missing">—</span>'}</td>
        <td>${schedTag}</td>
      </tr>`;
          })
          .join("");

  const foodById = new Map(db.foods.map((f) => [f.id, f]));
  const hallFoodIds: Record<string, Set<string>> = {};
  for (const meal of latest) {
    if (!hallFoodIds[meal.diningHall]) hallFoodIds[meal.diningHall] = new Set();
    for (const item of meal.items) if (!item.deleted) hallFoodIds[meal.diningHall].add(String(item.id));
  }

  const hallFoodsSections = Object.entries(hallFoodIds)
    .map(([hall, idSet]) => {
      const foods = [...idSet].map((id) => foodById.get(id)).filter(Boolean) as DbFood[];
      const mealSlots = latest.filter((m) => m.diningHall === hall && activeCount(m) > 0);
      const mealTimes = mealSlots.map((m) => `<span class="tag tag-blue">${esc(m.mealTime)}</span>`).join(" ");
      if (foods.length === 0) {
        return `<details class="section hall-section">
        <summary>${esc(hall)} <span class="section-count">0 foods</span> ${mealTimes}</summary>
        <div style="padding:24px;text-align:center;color:var(--muted)">No food items stored for this hall</div>
      </details>`;
      }
      const rows = foods
        .map(
          (f) => `<tr>
        <td class="name-cell">${esc(f.name)}</td>
        ${nutritionCells(f)}
        ${labelsCell(f)}
        ${coverageCell(f)}
      </tr>`,
        )
        .join("");
      return `<details class="section hall-section">
      <summary>${esc(hall)} <span class="section-count">${foods.length} foods</span> ${mealTimes}</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Cal</th><th>Protein</th><th>Carbs</th><th>Fat</th><th>Sodium</th><th>Sugar</th><th>Serving</th><th>Sat Fat</th><th>Fiber</th><th>Chol</th><th>Labels</th><th>Coverage</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`;
    })
    .join("\n");

  const logRows = logs
    .map((l) => `<div class="log-${l.level}"><span class="log-time">${l.time}</span>${esc(l.msg)}</div>`)
    .join("");
  const generatedAt = new Date().toLocaleString();
  const storedDates = [...writeStats.mealDates].join(", ") || "none";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>D1 Test Report — ${esc(date)}</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d27;--surface2:#242736;--border:#2e3147;--text:#e2e4f0;--muted:#6b7280;--accent:#7c6af7;--green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
  header{background:var(--surface);border-bottom:1px solid var(--border);padding:18px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
  header h1{font-size:18px;font-weight:700;color:var(--accent)}
  header .meta{color:var(--muted);font-size:12px}
  .main{padding:28px;max-width:1500px;margin:0 auto}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:24px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px}
  .card-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
  .card-value{font-size:26px;font-weight:700}
  .cv-accent{color:var(--accent)}.cv-blue{color:var(--blue)}.cv-red{color:var(--red)}.cv-yellow{color:var(--yellow)}.cv-green{color:var(--green)}
  .section{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:24px;overflow:hidden}
  .section-count{font-size:12px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:2px 10px;margin-left:8px}
  .table-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse}
  th{background:var(--surface2);padding:9px 13px;text-align:left;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;border-bottom:1px solid var(--border)}
  td{padding:8px 13px;border-bottom:1px solid var(--border);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr.ok td:first-child{color:var(--green)} tr.fail td:first-child{color:var(--red)}
  tr.row-empty{background:rgba(239,68,68,.04)}
  td.missing{color:var(--muted);font-style:italic} td.warn{background:rgba(245,158,11,.07);color:var(--yellow)} td.err{background:rgba(239,68,68,.07);color:var(--red)}
  td.empty-cell{text-align:center;padding:32px;color:var(--muted)} td.id-cell{font-family:monospace;font-size:11px;color:var(--muted)}
  td.name-cell{max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} td.status-cell{font-size:16px}
  .tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;font-weight:500;white-space:nowrap}
  .tag-green{background:rgba(34,197,94,.15);color:var(--green)} .tag-yellow{background:rgba(245,158,11,.15);color:var(--yellow)}
  .tag-red{background:rgba(239,68,68,.15);color:var(--red)} .tag-blue{background:rgba(59,130,246,.15);color:var(--blue)} .tag-gray{background:rgba(107,114,128,.2);color:var(--muted)}
  .badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
  .badge-ok{background:rgba(34,197,94,.15);color:var(--green)} .badge-warn{background:rgba(245,158,11,.15);color:var(--yellow)} .badge-error{background:rgba(239,68,68,.15);color:var(--red)}
  .warning-error td{background:rgba(239,68,68,.04)} .warning-warn td{background:rgba(245,158,11,.04)} .warning-info td{background:rgba(59,130,246,.04)}
  .icon-error{color:var(--red)} .icon-warn{color:var(--yellow)} .icon-info{color:var(--blue)}
  .bar-wrap{display:flex;align-items:center;gap:6px;min-width:90px}
  .bar-bg{flex:1;height:4px;background:var(--surface2);border-radius:2px;overflow:hidden} .bar-fill{height:100%;border-radius:2px}
  .log-area{background:#0a0d14;padding:16px 20px;font-family:'Courier New',monospace;font-size:12px;max-height:300px;overflow-y:auto}
  .log-info{color:#94a3b8;margin-bottom:3px} .log-success{color:var(--green);margin-bottom:3px} .log-warn{color:var(--yellow);margin-bottom:3px} .log-error{color:var(--red);margin-bottom:3px}
  .log-time{color:var(--muted);margin-right:8px}
  small{color:var(--muted);font-size:12px}
  details summary{cursor:pointer;padding:14px 20px;font-weight:600;list-style:none}
  details summary::-webkit-details-marker{display:none}
  details[open] summary{border-bottom:1px solid var(--border)}
  .hall-section{background:var(--surface2);border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .hall-section summary{padding:10px 16px;font-size:13px}
</style>
</head>
<body>
<header>
  <div>
    <h1>D1 Storage Test Report — ${esc(school.getSchoolCode())}</h1>
    <div class="meta">Date: ${esc(date)} &nbsp;·&nbsp; Stored dates: ${esc(storedDates)} &nbsp;·&nbsp; Generated: ${esc(generatedAt)} &nbsp;·&nbsp; Halls: ${hallResults.filter((r) => r.ok).length}/${hallResults.length} fetched &nbsp;·&nbsp; Sentinel values (-1, "Unknown") shown as —</div>
  </div>
  ${statusBadge}
</header>
<div class="main">
  <div class="cards">
    <div class="card"><div class="card-label">Contract Checks</div><div class="card-value ${contractFails ? "cv-red" : "cv-green"}">${contractChecks.length - contractFails}/${contractChecks.length}</div></div>
    <div class="card"><div class="card-label">Foods Stored</div><div class="card-value cv-accent">${db.foods.length}</div></div>
    <div class="card"><div class="card-label">Meal Slots</div><div class="card-value cv-blue">${latest.length}</div></div>
    <div class="card"><div class="card-label">Errors</div><div class="card-value cv-red">${errors}</div></div>
    <div class="card"><div class="card-label">Warnings</div><div class="card-value cv-yellow">${warns}</div></div>
    <div class="card"><div class="card-label">Missing Nutrition</div><div class="card-value cv-yellow">${missingNutrition}</div></div>
    <div class="card"><div class="card-label">Empty Meal Slots</div><div class="card-value cv-red">${emptySlots}</div></div>
    <div class="card"><div class="card-label">Fetch Failures</div><div class="card-value cv-red">${hallResults.filter((r) => !r.ok).length}</div></div>
  </div>
  <details class="section" open>
    <summary>Production Contract Checks <span class="section-count">${contractChecks.length - contractFails}/${contractChecks.length} passed</span></summary>
    <div class="table-wrap"><table><thead><tr><th>Status</th><th>Check</th></tr></thead><tbody>${contractRows}</tbody></table></div>
  </details>
  <details class="section" open>
    <summary>Fetch Results (pullRawData)</summary>
    <div class="table-wrap"><table><thead><tr><th>Dining Hall</th><th>Status</th><th>Detail</th></tr></thead><tbody>${fetchRows}</tbody></table></div>
  </details>
  <details class="section" ${warnings.length > 0 ? "open" : ""}>
    <summary>Detected Issues <span class="section-count">${warnings.length}</span></summary>
    <div class="table-wrap"><table><thead><tr><th></th><th>Issue</th><th>Category</th></tr></thead><tbody>${warningRows}</tbody></table></div>
  </details>
  <details class="section">
    <summary>Foods Table <span class="section-count">${db.foods.length}</span></summary>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Name</th><th>Cal</th><th>Protein</th><th>Carbs</th><th>Fat</th><th>Sodium</th><th>Sugar</th><th>Serving</th><th>Sat Fat</th><th>Fiber</th><th>Chol</th><th>Cal/Fat</th><th>Ca</th><th>Fe</th><th>Labels</th><th>Coverage</th></tr></thead>
      <tbody>${foodRows}</tbody>
    </table></div>
  </details>
  <details class="section" open>
    <summary>Meals Table <span class="section-count">${latest.length} slots · ${db.meals.length} rows</span></summary>
    <div class="table-wrap"><table><thead><tr><th>Dining Hall</th><th>Meal Time</th><th>Items</th><th>Deleted</th><th>Version</th><th>Hours</th><th>School</th><th>Status</th></tr></thead><tbody>${mealRows}</tbody></table></div>
  </details>
  <details class="section" open>
    <summary>Foods by Dining Hall <span class="section-count">${Object.keys(hallFoodIds).length} halls</span></summary>
    <div style="padding:16px 20px;display:flex;flex-direction:column;gap:12px">${hallFoodsSections}</div>
  </details>
  <details class="section">
    <summary>Metadata Table <span class="section-count">${db.metadata.length}</span></summary>
    <div class="table-wrap"><table><thead><tr><th>Dining Hall</th><th>Address</th><th>Latitude</th><th>Longitude</th><th>Schedule</th></tr></thead><tbody>${metaRows}</tbody></table></div>
  </details>
  <details class="section">
    <summary>Run Logs <span class="section-count">${logs.length}</span></summary>
    <div class="log-area">${logRows}</div>
  </details>
</div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // TEMP: override to a mid-school-year date (spring semester) for richer data
  const date = "2026-02-10";

  console.log(`\nD1 Storage Test Harness — ${school.getSchoolCode()}`);
  console.log(`Date: ${date}\n`);

  // ── Phase 0: static contract ──
  console.log(`Checking School contract...`);
  check("Default export extends the shared School class", school instanceof School);
  const code = school.getSchoolCode?.();
  check(
    "getSchoolCode() returns a lowercase identifier",
    typeof code === "string" && /^[a-z0-9_-]+$/.test(code),
    `got "${code}"`,
  );
  const halls = school.getDiningHalls?.();
  check(
    "getDiningHalls() returns a non-empty list",
    Array.isArray(halls) && halls.length > 0,
    `${halls?.length ?? 0} halls`,
  );
  const hasProcessMenus = typeof (school as any).processMenus === "function";
  check(
    "processMenus(env, dateOffset, isRecursive) is implemented",
    hasProcessMenus,
    hasProcessMenus ? "" : "production's cron trigger and ?fetchMenus route call this — the school cannot run without it",
  );
  check(
    "addSodasIfMissing(env) is callable",
    typeof (school as any).addSodasIfMissing === "function",
    "production's ?fetchSodas admin route calls this on every school",
  );

  // ── Phase 1: pullRawData (fetch/parse diagnostics, no writes) ──
  console.log(`\nFetching ${halls?.length ?? 0} dining halls via pullRawData()...`);
  let hallResults: HallResult[] = [];
  try {
    hallResults = await school.pullRawData(date);
    const okCount = hallResults.filter((r) => r.ok).length;
    check(
      "pullRawData() returns per-hall results without throwing",
      Array.isArray(hallResults) && hallResults.every((r) => typeof r?.ok === "boolean" && typeof r?.hall === "string"),
      `${okCount}/${hallResults.length} halls fetched`,
    );
    for (const r of hallResults) console.log(`  ${r.ok ? "✔" : "✖"} ${r.hall}${r.ok ? "" : ` — ${r.error}`}`);

    const shapeProblems = hallResults
      .filter((r) => r.ok)
      .map((r) => ({ hall: r.hall, problem: hallDataProblem(r) }))
      .filter((r) => r.problem);
    check(
      "pullRawData() returns well-formed HallData for fetched halls",
      shapeProblems.length === 0,
      shapeProblems
        .slice(0, 3)
        .map((r) => `${r.hall}: ${r.problem}`)
        .join("; "),
    );
    check(
      "pullRawData() performs no D1 writes",
      db.foods.length === 0 && db.meals.length === 0 && db.metadata.length === 0,
      "it is a read-only diagnostic; all writes belong to processMenus/fetchMetadata",
    );
  } catch (err: any) {
    check("pullRawData() returns per-hall results without throwing", false, String(err?.stack ?? err));
  }

  // ── Phase 2: processMenus — the exact call production's cron makes ──
  // TEMP: dateOffset targets 2026-02-10 from today (2026-07-13)
  const dateOffset = Math.floor((new Date("2026-02-10T12:00:00Z").getTime() - Date.now()) / 86400e3);
  console.log(`\nRunning processMenus(env, ${dateOffset}, false) — the production ingest path...`);
  let processOk = false;
  if (hasProcessMenus) {
    try {
      const responses = await (school as any).processMenus(mockEnv, dateOffset, false);
      processOk = true;
      check("processMenus() completes without throwing", true, `${db.meals.length} meal rows written`);
      const shapeOk =
        Array.isArray(responses) &&
        responses.every((r: any) => Array.isArray(r) && r.every((b: any) => typeof b === "boolean"));
      check(
        "processMenus() returns boolean[][] statuses",
        shapeOk,
        shapeOk ? "" : `got ${JSON.stringify(responses)?.slice(0, 120)}`,
      );
    } catch (err: any) {
      check("processMenus() completes without throwing", false, String(err?.stack ?? err).slice(0, 600));
    }
  }

  // ── Phase 3: second processMenus run — must skip unchanged slots ──
  const run2Changes: string[] = [];
  const run2FoodInserts: string[] = [];
  if (processOk) {
    console.log(`\nRunning processMenus a second time to verify version stability...`);
    trackInserts = run2Changes;
    trackFoodInserts = run2FoodInserts;
    try {
      await (school as any).processMenus(mockEnv, dateOffset, false);
      check(
        "Second processMenus run skips unchanged slots (no version churn)",
        run2Changes.length === 0,
        run2Changes.length ? `${run2Changes.length} slot(s) re-inserted` : "all slots skipped",
      );
    } catch (err: any) {
      check("Second processMenus run skips unchanged slots (no version churn)", false, String(err).slice(0, 300));
    }
    trackInserts = null;
    trackFoodInserts = null;
  }

  // ── Phase 4: fetchMetadata (production refreshes metadata through this) ──
  console.log(`\nRunning fetchMetadata()...`);
  try {
    await school.fetchMetadata(mockEnv);
    check("fetchMetadata() completes without throwing", true, `${db.metadata.length} metadata rows`);
  } catch (err: any) {
    check("fetchMetadata() completes without throwing", false, String(err?.stack ?? err).slice(0, 300));
  }

  // ── Phase 5: addSodasIfMissing (production's ?fetchSodas route) ──
  if (typeof (school as any).addSodasIfMissing === "function") {
    try {
      await (school as any).addSodasIfMissing(mockEnv);
    } catch (err: any) {
      check("addSodasIfMissing() completes without throwing", false, String(err).slice(0, 300));
    }
  }

  // ── Analysis ──
  console.log(`\nAnalyzing data...`);
  const kvLeftovers = [...kv.keys()].filter((k) => k.startsWith("school:"));
  const warnings = detectWarnings(run2Changes, kvLeftovers, hallResults, run2FoodInserts);
  const errors = warnings.filter((w) => w.level === "error").length;
  const warns = warnings.filter((w) => w.level === "warn").length;
  const latest = latestMealRows();
  console.log(
    `  Foods: ${db.foods.length}  Meal slots: ${latest.length} (${db.meals.length} rows)  Metadata: ${db.metadata.length}`,
  );
  console.log(`  Contract: ${contractChecks.filter((c) => c.ok).length}/${contractChecks.length} passed`);
  console.log(`  Errors: ${errors}  Warnings: ${warns}`);

  console.log(`\nGenerating report...`);
  const html = generateReport(date, hallResults, warnings);
  writeFileSync(OUTPUT_PATH, html, "utf8");
  console.log(`  Written: ${OUTPUT_PATH}`);

  const opener = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [OUTPUT_PATH], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();

  if (errors > 0) {
    console.log(`\nFailed with ${errors} error(s). See tests/report.html for details.\n`);
    process.exit(1);
  } else {
    console.log(`\nDone. Report opened in your browser.\n`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
