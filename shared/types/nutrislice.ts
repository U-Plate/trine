import { storeMealsInD1, storeFoodsInD1, storeMetadataInD1 } from "../d1/index";
import { School } from "./school";
import type { HallResult } from "./school";
import type { FoodItem } from "./foods";
import { Env } from "./env";

export { Nutrislice };

class Nutrislice extends School {
  protected schoolEP: string;
  protected diningHallNames: string[];
  protected timeZone: string;
  protected mealTimes: string[];
  protected diningHallSlugs: string[];
  protected schoolCodeValue: string;
  protected generalSchedules: Record<string, any> | null;

  constructor(
    schoolEP: string,
    schoolCode: string,
    govCode: number,
    diningHallSlugs: string[],
    diningHallNames: string[],
    timeZone: string,
    mealTimes: string[] = ["breakfast", "lunch", "dinner"],
    // Hand-maintained generalSchedules.json keyed by hall name; takes priority
    // over API hours for schools whose API publishes none (e.g. IU Bloomington)
    generalSchedules: Record<string, any> | null = null,
  ) {
    super(schoolCode, diningHallNames, govCode);
    this.schoolEP = schoolEP;
    this.schoolCodeValue = schoolCode;
    this.diningHallSlugs = diningHallSlugs;
    this.diningHallNames = diningHallNames;
    this.timeZone = timeZone;
    this.mealTimes = mealTimes;
    this.generalSchedules = generalSchedules;
  }

  public async processMenus(env: Env, dateOffset: number, isRecursive = false) {
    let futures = this.diningHallSlugs.map((hall) => this.processAndStoreDiningCourtMenuData(env, hall, dateOffset));
    let responses: boolean[][] = await Promise.all(futures);
    if (isRecursive) {
      console.log("Performing recursive fetch for next 2 days");
      futures = this.diningHallSlugs.map((hall) => this.processAndStoreDiningCourtMenuData(env, hall, dateOffset + 1));
      responses.push(...(await Promise.all(futures)));
      futures = this.diningHallSlugs.map((hall) => this.processAndStoreDiningCourtMenuData(env, hall, dateOffset + 2));
      responses.push(...(await Promise.all(futures)));
    }
    return responses;
  }

  /**
   * Main logic to fetch, process, and store menu data for given locations.
   * @param {object} env - The environment object with bindings.
   * @param {string} locSlug - A slug string of a dining hall.
   * @param {string} locName - A slug string of a dining hall.
   */
  protected async processAndStoreDiningCourtMenuData(env: Env, loc: string, dateOffset: number, parsedData?: any) {
    let now = new Date();
    now.setTime(now.getTime() + dateOffset * 24 * 60 * 60 * 1000);
    let date = now.toISOString().split("T")[0];

    const idx = this.diningHallSlugs.indexOf(loc);
    const name = this.diningHallNames[idx] ?? loc;

    const data = parsedData || (await this.fetchAndParseHall(loc, name, date));

    const { foods, meals, mealTimeHours, metadata } = data;

    if (foods.length > 0) {
      await storeFoodsInD1(env.DB, foods, this.schoolCodeValue);
      console.log(`Stored ${foods.length} food items for ${name}.`);
    }

    console.log(`Storing meal data for ${name} on ${date} in D1.`);
    const futures = this.mealTimes.map((mt) => {
      const mealKey = mt.charAt(0).toUpperCase() + mt.slice(1);
      return storeMealsInD1(env, {
        diningHall: name,
        date,
        meals: meals[mealKey] ?? [],
        school: this.schoolCodeValue,
        mealTime: mealKey,
        // HallData keys match the capitalized meal keys. Keep the lowercase
        // lookup as a compatibility fallback for older school parsers.
        mealTimeHours: mealTimeHours[mealKey] ?? mealTimeHours[mt] ?? "{}",
      });
    });
    const updated = await Promise.all(futures);

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

    const anyUpdated = updated.some(Boolean);
    if (anyUpdated && env.KV_MENUS) {
      // Invalidate any cache key that includes this location for this date
      const listPrefix = `menu-date:${date}-halls:`;
      try {
        const keys = await env.KV_MENUS.list({ prefix: listPrefix });
        for (const key of keys.keys) {
          if (key.name.includes(name)) {
            console.log(`Invalidating KV cache for: ${key.name}`);
            await env.KV_MENUS.delete(key.name);
          }
        }
      } catch (e) {
        console.error("Error invalidating KV cache:", e);
      }
    }
    return updated;
  }

  /**
   * Converts Nutrislice operating_days_by_menu_type into the canonical
   * generalSchedule format stored in the metadata table:
   * { "Breakfast": { "Sunday": { Start: "08:00", End: "10:00" }, ... } | null, ... }
   */
  protected buildGeneralSchedule(hoursData: Array<Record<string, any>> | null) {
    const DAYS: [string, string][] = [
      ["Sunday", "sun"],
      ["Monday", "mon"],
      ["Tuesday", "tue"],
      ["Wednesday", "wed"],
      ["Thursday", "thu"],
      ["Friday", "fri"],
      ["Saturday", "sat"],
    ];
    const result: Record<string, Record<string, { Start: string; End: string } | null> | null> = {};
    for (const mt of this.mealTimes) {
      const mealKey = mt.charAt(0).toUpperCase() + mt.slice(1);
      // Names may be hall-prefixed (e.g. "Burge Breakfast"); prefer an exact
      // match, otherwise the shortest name containing the meal time so "lunch"
      // doesn't grab "Late Lunch" when a plain lunch entry exists.
      const mtLower = mt.toLowerCase();
      const candidates = (hoursData ?? []).filter((h) =>
        String(h.menu_type_name ?? "")
          .toLowerCase()
          .includes(mtLower),
      );
      const menuType =
        candidates.find((h) => String(h.menu_type_name ?? "").toLowerCase() === mtLower) ??
        candidates.sort((a, b) => String(a.menu_type_name).length - String(b.menu_type_name).length)[0];
      if (!menuType) {
        result[mealKey] = null;
        continue;
      }
      const days: Record<string, { Start: string; End: string } | null> = {};
      let hasAnyHours = false;
      for (const [fullDay, shortDay] of DAYS) {
        const start = menuType[`${shortDay}_start`];
        const end = menuType[`${shortDay}_end`];
        // Disabled days can still carry stale start/end times in the API data
        if (menuType[`${shortDay}_enabled`] !== false && start && end) {
          days[fullDay] = { Start: String(start).substring(0, 5), End: String(end).substring(0, 5) };
          hasAnyHours = true;
        } else {
          days[fullDay] = null;
        }
      }
      result[mealKey] = hasAnyHours ? days : null;
    }
    return result;
  }

  protected cleanUpHoursData(hoursData: Array<Record<string, any>> | null, weekdayIndex: number) {
    const dayMap: Record<string, number> = {
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
      sun: 0,
    };
    const daysOrder = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const result: Record<string, { Start: string; End: string } | null> = {};

    if (!hoursData) {
      return null;
    }

    hoursData.forEach((menuType) => {
      const schedule: Record<number, { Start: string; End: string } | null> = {};

      daysOrder.forEach((shortDay) => {
        const fullDay = dayMap[shortDay];
        const enabledKey = `${shortDay}_enabled`;
        const startKey = `${shortDay}_start`;
        const endKey = `${shortDay}_end`;

        // if (menuType[enabledKey] === false) {
        //   schedule[fullDay] = null;
        //   return;
        // }

        if (menuType[startKey] && menuType[endKey]) {
          schedule[fullDay] = {
            Start: String(menuType[startKey]).substring(0, 5),
            End: String(menuType[endKey]).substring(0, 5),
          };
        } else {
          schedule[fullDay] = null;
        }
      });

      // result[menuType.menu_type_name] = schedule;
      const menuTypeName = String(menuType.menu_type_name ?? "");
      result[menuTypeName] = schedule[weekdayIndex] || null;
    });

    return result;
  }

  public async pullRawData(date: string): Promise<HallResult[]> {
    const results = await Promise.allSettled(
      this.diningHallSlugs.map((slug, i) => this.fetchAndParseHall(slug, this.diningHallNames[i] ?? slug, date)),
    );
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? { ok: true as const, ...r.value }
        : {
            ok: false as const,
            hall: this.diningHallNames[i] ?? this.diningHallSlugs[i],
            error: String(r.reason),
          },
    );
  }

  public async fetchMetadata(env: Env): Promise<void> {
    const resp = await fetch(`https://${this.schoolEP}.api.nutrislice.com/menu/api/schools/`, {
      headers: { "User-Agent": "BoilerFuel-Worker/1.0", "Content-Type": "application/json" },
    });
    if (!resp.ok) return;
    const schools: any[] = await resp.json();
    for (let i = 0; i < this.diningHallSlugs.length; i++) {
      const slug = this.diningHallSlugs[i];
      const name = this.diningHallNames[i];
      const hallData = schools.find((h: any) => h.slug === slug);
      if (!hallData) continue;
      const lat = String(hallData.geolocation?.latitude ?? "");
      const lng = String(hallData.geolocation?.longitude ?? "");
      const address = hallData.address ?? "";
      const schedule = JSON.stringify(
        this.generalSchedules?.[name] ?? this.buildGeneralSchedule(hallData.operating_days_by_menu_type ?? []),
      );
      if (lat || lng || address) {
        await storeMetadataInD1(env.DB, {
          school: this.schoolCodeValue,
          diningHall: name,
          address,
          latitude: lat,
          longitude: lng,
          type: "",
          schedule,
        });
      }
    }
  }

  /**
   * Pairs each food row in a day's menu_items with its station name.
   *
   * Nutrislice encodes stations two ways, common across schools:
   *  1. Inline section-title rows (is_section_title with a text label) that
   *     precede the food rows belonging to them and share their station_id.
   *  2. menu_info entries keyed by menu_id whose section_options.display_name
   *     names the whole menu (often a coarser grouping, e.g. "Beverages").
   * Section titles are the finer-grained signal, so they take priority;
   * menu_info is the fallback for menus that have no section titles.
   * (menu_station_id, which older code keyed on, is null in practice.)
   */
  protected resolveStationNames(dayData: any): Array<{ item: any; station: string }> {
    const menuInfo = dayData?.menu_info ?? {};
    const menuNames: Record<string, string> = {};
    for (const k of Object.keys(menuInfo)) {
      const displayName = menuInfo[k]?.section_options?.display_name;
      if (displayName) menuNames[k] = String(displayName);
    }

    const menuItems = dayData?.menu_items ?? [];
    const itemList: any[] = Array.isArray(menuItems) ? menuItems : Object.values(menuItems);

    const sectionByStationId: Record<string, string> = {};
    for (const item of itemList) {
      if (item?.is_section_title && item.text && item.station_id != null) {
        sectionByStationId[String(item.station_id)] = String(item.text).trim();
      }
    }

    const result: Array<{ item: any; station: string }> = [];
    let currentMenuId: unknown;
    let currentSection = "";
    for (const item of itemList) {
      // Section titles only apply within their own menu
      if (item?.menu_id !== currentMenuId) {
        currentMenuId = item?.menu_id;
        currentSection = "";
      }
      if (item?.is_section_title) {
        currentSection = String(item.text ?? "").trim();
        continue;
      }
      if (item?.food == null) continue;

      let station = item.station_id != null ? (sectionByStationId[String(item.station_id)] ?? "") : "";
      if (!station) station = currentSection;
      if (!station) {
        station = menuNames[String(item.menu_station_id ?? "")] ?? menuNames[String(item.menu_id ?? "")] ?? "";
      }
      result.push({ item, station });
    }
    return result;
  }

  protected async fetchAndParseHall(slug: string, name: string, date: string) {
    const dateForUrl = date.replaceAll("-", "/");
    const now = new Date(date + "T12:00:00Z");
    const weekDayIndex = now.getDay();
    const DAY_SHORTS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
    const dayShort = DAY_SHORTS[weekDayIndex];

    // Fetch school metadata and hours from the schools API
    let metadata = { address: "", latitude: "", longitude: "", schedule: "" };
    const mealTimeHours: Record<string, string> = {};
    try {
      const schoolsResp = await fetch(`https://${this.schoolEP}.api.nutrislice.com/menu/api/schools/`, {
        method: "GET",
        headers: {
          "User-Agent": "BoilerFuel-Worker/1.0",
          "Content-Type": "application/json",
        },
      });
      if (schoolsResp.ok) {
        const schoolsData: any[] = await schoolsResp.json();
        const hallData = schoolsData.find((h: any) => h.slug === slug);
        if (hallData) {
          metadata = {
            address: hallData.address ?? "",
            latitude: String(hallData.geolocation?.latitude ?? ""),
            longitude: String(hallData.geolocation?.longitude ?? ""),
            schedule: JSON.stringify(
              this.generalSchedules?.[name] ?? this.buildGeneralSchedule(hallData.operating_days_by_menu_type ?? []),
            ),
          };
          const tzOffset = (() => {
            const ref = new Date(`${date}T12:00:00Z`);
            const utc = new Date(ref.toLocaleString("en-US", { timeZone: "UTC" }));
            const local = new Date(ref.toLocaleString("en-US", { timeZone: this.timeZone }));
            const diff = (local.getTime() - utc.getTime()) / 60000;
            const sign = diff >= 0 ? "+" : "-";
            const h = String(Math.floor(Math.abs(diff) / 60)).padStart(2, "0");
            const m = String(Math.abs(diff) % 60).padStart(2, "0");
            return `${sign}${h}:${m}`;
          })();
          for (const menuType of hallData.operating_days_by_menu_type ?? []) {
            const start = menuType[`${dayShort}_start`];
            const end = menuType[`${dayShort}_end`];
            if (start && end) {
              mealTimeHours[menuType.menu_type_name] = JSON.stringify({
                Start: `${date}T${start}${tzOffset}`,
                End: `${date}T${end}${tzOffset}`,
              });
            }
          }
        }
      }
    } catch {}

    const mealResponses: Record<string, any> = {};
    for (const mealTime of this.mealTimes) {
      const resp = await fetch(
        `https://${this.schoolEP}.api.nutrislice.com/menu/api/weeks/school/${slug}/menu-type/${mealTime}/${dateForUrl}`,
        {
          method: "GET",
          headers: {
            "User-Agent": "BoilerFuel-Worker/1.0",
            "Content-Type": "application/json",
          },
        },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${slug}/${mealTime}`);
      mealResponses[mealTime] = await resp.json();
    }

    // Only initialize meals for this school's configured meal times
    const meals: Record<string, any[]> = {};
    for (const mt of this.mealTimes) {
      meals[mt.charAt(0).toUpperCase() + mt.slice(1)] = [];
    }
    const foodItemsMap = new Map<string, any>();

    for (const mealTime of this.mealTimes) {
      const mealKey = mealTime.charAt(0).toUpperCase() + mealTime.slice(1);
      const dayData = mealResponses[mealTime]?.days?.[weekDayIndex];
      if (!dayData) continue;

      for (const { item: foodItem, station } of this.resolveStationNames(dayData)) {
        const food = foodItem.food;
        meals[mealKey].push({ id: String(food.id), station });
        if (!foodItemsMap.has(String(food.id))) foodItemsMap.set(String(food.id), food);
      }
    }

    // Deduplicate and drop empty meal slots
    const filteredMeals: Record<string, any[]> = {};
    for (const mealName in meals) {
      const seen = new Map<string, any>();
      meals[mealName].forEach((item) => {
        const k = `${item.id}|${item.station}`;
        if (!seen.has(k)) seen.set(k, item);
      });
      const deduped = Array.from(seen.values());
      if (deduped.length > 0) filteredMeals[mealName] = deduped;
    }

    const foods: FoodItem[] = [];
    for (const [id, food] of foodItemsMap) {
      const parsed = this.parseItemFromNutrislice(food, id);
      if (parsed) foods.push(parsed);
    }

    return {
      hall: name,
      foods,
      meals: filteredMeals,
      mealTimeHours,
      metadata,
    };
  }

  protected parseItemFromNutrislice(food: Record<string, any>, id: string): FoodItem | null {
    if (!food?.name) return null;
    const n = food.rounded_nutrition_info ?? {};
    const servingInfo = food.serving_size_info ?? {};
    const servingSize = servingInfo.serving_size_unit ? String(servingInfo.serving_size_unit) : null;

    const labels = (food.icons?.food_icons ?? []).map((t: any) => t.name ?? t).filter(Boolean);

    return {
      id,
      name: food.name,
      calories: n.calories ?? null,
      totalFat: n.g_fat ?? null,
      saturatedFat: n.g_saturated_fat ?? null,
      protein: n.g_protein ?? null,
      carbs: n.g_carbs ?? null,
      sugar: n.g_sugar ?? null,
      sodium: n.mg_sodium ?? null,
      dietaryFiber: n.g_fiber ?? null,
      cholesterol: n.mg_cholesterol ?? null,
      servingSize: servingSize ?? undefined,
      ingredients: food.ingredients ?? "",
      labels: JSON.stringify(labels),
    };
  }
}
