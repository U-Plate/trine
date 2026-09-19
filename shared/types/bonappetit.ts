import { storeMealsInD1, storeFoodsInD1, storeMetadataInD1 } from "../d1/index";
import { School } from "./school";
import type { HallResult, HallData } from "./school";
import type { FoodItem } from "./foods";
import type { MealItem } from "./meals";
import { Env } from "./env";

export { BonAppetit };

// A browser-like UA is REQUIRED. The cafebonappetit CDN returns 403 to the
// default fetch/curl UA and 200 to a real browser UA.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Library base class for Bon Appétit Management Company dining sites (the
 * `*.cafebonappetit.com` family, e.g. Trine's Whitney Commons Cafe).
 *
 * There is no usable public JSON API — the legacy `legacy.cafebonappetit.com`
 * endpoints now 403 unauthenticated. Instead the entire menu, including full
 * per-item nutrition, is embedded in each cafe page's HTML as `Bamco.*`
 * JavaScript globals. This class fetches the dated cafe page, extracts those
 * globals, and walks daypart → station → item to produce the shape the rest of
 * the UPlate pipeline expects.
 *
 * Concrete schools extend this and only pass config to `super(...)`; see the
 * Trine subclass in `src/trine.ts`.
 */
class BonAppetit extends School {
  protected site: string; // subdomain, e.g. "trine" -> trine.cafebonappetit.com
  protected schoolCodeValue: string;
  protected cafeSlugs: string[]; // e.g. ["whitney-commons-cafe"]
  protected diningHallNames: string[]; // display names, joined with metadata
  protected timeZone: string;
  protected mealTimes: string[]; // canonical, matched against daypart labels
  // Hand-maintained schedules keyed by hall display name. The embedded page
  // data only carries the current day's serving hours, so the canonical
  // per-day generalSchedule (metadata.schedule) must come from here.
  protected generalSchedules: Record<string, any> | null;

  constructor(
    site: string,
    schoolCode: string,
    govCode: number,
    cafeSlugs: string[],
    diningHallNames: string[],
    timeZone: string,
    mealTimes: string[] = ["Breakfast", "Lunch", "Dinner"],
    generalSchedules: Record<string, any> | null = null,
  ) {
    super(schoolCode, diningHallNames, govCode);
    this.site = site;
    this.schoolCodeValue = schoolCode;
    this.cafeSlugs = cafeSlugs;
    this.diningHallNames = diningHallNames;
    this.timeZone = timeZone;
    this.mealTimes = mealTimes;
    this.generalSchedules = generalSchedules;
  }

  // ── Production ingest entry point ──────────────────────────────────────────
  public async processMenus(env: Env, dateOffset: number, isRecursive = false): Promise<boolean[][]> {
    const run = (off: number) =>
      Promise.all(this.cafeSlugs.map((slug) => this.processAndStoreDiningCourtMenuData(env, slug, off)));

    let responses: boolean[][] = await run(dateOffset);
    if (isRecursive) {
      console.log("Performing recursive fetch for next 2 days");
      responses.push(...(await run(dateOffset + 1)));
      responses.push(...(await run(dateOffset + 2)));
    }
    return responses;
  }

  protected async processAndStoreDiningCourtMenuData(env: Env, slug: string, dateOffset: number, parsedData?: HallData) {
    const date = this.dateFromOffset(dateOffset, this.timeZone);
    const idx = this.cafeSlugs.indexOf(slug);
    const name = this.diningHallNames[idx] ?? slug;

    const { foods, meals, mealTimeHours, metadata } = parsedData ?? (await this.fetchAndParseHall(slug, name, date));

    if (foods.length > 0) {
      await storeFoodsInD1(env.DB, foods, this.schoolCodeValue);
      console.log(`Stored ${foods.length} food items for ${name}.`);
    }

    console.log(`Storing meal data for ${name} on ${date} in D1.`);
    const updated = await Promise.all(
      this.mealTimes.map((mealTime) =>
        storeMealsInD1(env, {
          diningHall: name,
          date,
          meals: meals[mealTime] ?? [],
          school: this.schoolCodeValue,
          mealTime,
          mealTimeHours: mealTimeHours[mealTime] ?? "{}",
        }),
      ),
    );

    if (metadata) {
      await storeMetadataInD1(env.DB, {
        school: this.schoolCodeValue,
        diningHall: name,
        address: metadata.address ?? "",
        latitude: metadata.latitude ?? "",
        longitude: metadata.longitude ?? "",
        type: "Dining Halls",
        schedule: metadata.schedule ?? "{}",
      });
    }

    return updated;
  }

  public async pullRawData(date: string): Promise<HallResult[]> {
    const results = await Promise.allSettled(
      this.cafeSlugs.map((slug, i) => this.fetchAndParseHall(slug, this.diningHallNames[i] ?? slug, date)),
    );
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? { ok: true as const, ...r.value }
        : { ok: false as const, hall: this.diningHallNames[i] ?? this.cafeSlugs[i], error: String(r.reason) },
    );
  }

  public async fetchMetadata(env: Env): Promise<void> {
    await Promise.all(
      this.diningHallNames.map((name) =>
        storeMetadataInD1(env.DB, {
          school: this.schoolCodeValue,
          diningHall: name,
          address: "",
          latitude: "",
          longitude: "",
          type: "Dining Halls",
          schedule: JSON.stringify(this.generalSchedules?.[name] ?? {}),
        }),
      ),
    );
  }

  // ── Fetch + parse one cafe for one date ─────────────────────────────────────
  protected async fetchAndParseHall(slug: string, name: string, date: string): Promise<HallData> {
    const url = `https://${this.site}.cafebonappetit.com/cafe/${slug}/${date}/`;
    const resp = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
    const html = await resp.text();

    const menuItems = this.extractGlobal(html, /Bamco\.menu_items\s*=/) ?? {};
    const dayparts = this.extractDayparts(html);

    const tz = this.tzOffset(date);
    const meals: Record<string, MealItem[]> = {};
    const mealTimeHours: Record<string, string> = {};
    const foodItemsMap = new Map<string, any>();

    for (const daypart of dayparts) {
      const mealKey = this.mealTimes.find((mt) => mt.toLowerCase() === String(daypart.label ?? "").toLowerCase());
      if (!mealKey) continue; // e.g. a daypart this school doesn't serve/track

      if (daypart.starttime && daypart.endtime) {
        mealTimeHours[mealKey] = JSON.stringify({
          Start: `${date}T${this.normalizeTime(daypart.starttime)}${tz}`,
          End: `${date}T${this.normalizeTime(daypart.endtime)}${tz}`,
        });
      }

      meals[mealKey] ??= [];
      for (const station of daypart.stations ?? []) {
        const stationLabel = this.stripHtml(station.label ?? "");
        for (const rawId of station.items ?? []) {
          const id = String(rawId);
          const item = (menuItems as Record<string, any>)[id];
          if (!item) continue; // id not present in menu_items
          meals[mealKey].push({ id, station: stationLabel });
          if (!foodItemsMap.has(id)) foodItemsMap.set(id, item);
        }
      }
    }

    // Dedupe on the id|station key the storage layer merges on, and drop empty slots.
    const filteredMeals: Record<string, MealItem[]> = {};
    for (const mealName in meals) {
      const seen = new Map<string, MealItem>();
      for (const item of meals[mealName]) {
        const k = `${item.id}|${item.station}`;
        if (!seen.has(k)) seen.set(k, item);
      }
      const deduped = Array.from(seen.values());
      if (deduped.length > 0) filteredMeals[mealName] = deduped;
    }

    const foods: FoodItem[] = [];
    for (const [id, item] of foodItemsMap) {
      const parsed = this.parseItem(item, id);
      if (parsed) foods.push(parsed);
    }

    const metadata = {
      address: "",
      latitude: "",
      longitude: "",
      schedule: JSON.stringify(this.generalSchedules?.[name] ?? {}),
    };

    return { hall: name, foods, meals: filteredMeals, mealTimeHours, metadata };
  }

  /**
   * Map one `Bamco.menu_items[id]` entry into a {@link FoodItem}. Full nutrition
   * lives in `nutrition_details` ({ label, value, unit } per field); values are
   * strings and may be `""` (missing) or `"< 1"`.
   */
  protected parseItem(item: Record<string, any>, id: string): FoodItem | null {
    if (!item?.label) return null;
    const nd = item.nutrition_details ?? {};

    const num = (key: string): number | undefined => {
      const raw = String(nd?.[key]?.value ?? "").trim();
      if (raw === "") return undefined;
      if (raw.startsWith("<")) return 0; // "< 1" -> treat as 0, consistently
      const n = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
      return Number.isNaN(n) ? undefined : n;
    };

    // Prefer the detailed calories, fall back to the summary kcal.
    let calories = num("calories");
    if (calories === undefined) {
      const kcal = String(item.nutrition?.kcal ?? "").trim();
      if (kcal !== "") {
        const n = parseFloat(kcal);
        if (!Number.isNaN(n)) calories = n;
      }
    }

    const serving = nd.servingSize;
    const servingSize = serving?.value
      ? `${String(serving.value).trim()}${serving.unit ? ` ${String(serving.unit).trim()}` : ""}`.trim()
      : undefined;

    const labels: string[] = Object.values(item.cor_icon ?? {}).map((v) => String(v));

    return {
      id,
      name: this.stripHtml(item.label),
      calories,
      servingSize,
      totalFat: num("fatContent"),
      saturatedFat: num("saturatedFatContent"),
      cholesterol: num("cholesterolContent"),
      sodium: num("sodiumContent"),
      carbs: num("carbohydrateContent"),
      dietaryFiber: num("fiberContent"),
      sugar: num("sugarContent"),
      protein: num("proteinContent"),
      ingredients: typeof item.ingredients === "string" ? item.ingredients : "",
      labels: JSON.stringify(labels),
    };
  }

  // ── HTML / global extraction helpers ────────────────────────────────────────

  /** Parse the JSON literal assigned to a `Bamco.*` global (e.g. menu_items). */
  protected extractGlobal(html: string, assignment: RegExp): any | null {
    const m = assignment.exec(html);
    if (!m) return null;
    const literal = this.extractBalancedFrom(html, m.index + m[0].length);
    if (literal == null) return null;
    try {
      return JSON.parse(literal);
    } catch {
      return null;
    }
  }

  /** Extract every `Bamco.dayparts['<id>'] = {...};` object on the page. */
  protected extractDayparts(html: string): any[] {
    const dayparts: any[] = [];
    const re = /Bamco\.dayparts\['(\d+)'\]\s*=/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const literal = this.extractBalancedFrom(html, m.index + m[0].length);
      if (literal == null) continue;
      try {
        dayparts.push(JSON.parse(literal));
      } catch {
        // skip a malformed daypart rather than failing the whole hall
      }
    }
    return dayparts;
  }

  /**
   * From `from`, skip to the next `{`/`[` and return the balanced literal as a
   * string. Brace-matches while respecting JSON double-quoted strings, so a `};`
   * inside a description (which would break a non-greedy regex) is handled.
   */
  protected extractBalancedFrom(html: string, from: number): string | null {
    let i = from;
    while (i < html.length && html[i] !== "{" && html[i] !== "[") i++;
    if (i >= html.length) return null;

    const open = html[i];
    const close = open === "{" ? "}" : "]";
    const start = i;
    let depth = 0;
    let inStr = false;
    for (; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (ch === "\\") i++; // skip escaped char
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) return html.substring(start, i + 1);
    }
    return null;
  }

  protected stripHtml(s: string): string {
    return String(s)
      .replace(/<[^>]*>/g, "")
      .replace(/^@/, "")
      .trim();
  }

  protected normalizeTime(t: string): string {
    // "11:00" -> "11:00:00", leave "11:00:00" untouched.
    const parts = String(t).trim().split(":");
    while (parts.length < 3) parts.push("00");
    return parts.slice(0, 3).map((p) => p.padStart(2, "0")).join(":");
  }

  /** e.g. "-04:00" for America/New_York on the given date (DST-aware). */
  protected tzOffset(date: string): string {
    const ref = new Date(`${date}T12:00:00Z`);
    const utc = new Date(ref.toLocaleString("en-US", { timeZone: "UTC" }));
    const local = new Date(ref.toLocaleString("en-US", { timeZone: this.timeZone }));
    const diff = (local.getTime() - utc.getTime()) / 60000;
    const sign = diff >= 0 ? "+" : "-";
    const h = String(Math.floor(Math.abs(diff) / 60)).padStart(2, "0");
    const m = String(Math.abs(diff) % 60).padStart(2, "0");
    return `${sign}${h}:${m}`;
  }
}
