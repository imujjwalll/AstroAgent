import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { DateTime } from "luxon";
import * as swe from "sweph";

// ─── Constants ────────────────────────────────────────────────────────────────

const { constants: c } = swe;

const PLANETS = [
  { id: c.SE_SUN,     name: "Sun" },
  { id: c.SE_MOON,    name: "Moon" },
  { id: c.SE_MERCURY, name: "Mercury" },
  { id: c.SE_VENUS,   name: "Venus" },
  { id: c.SE_MARS,    name: "Mars" },
  { id: c.SE_JUPITER, name: "Jupiter" },
  { id: c.SE_SATURN,  name: "Saturn" },
  { id: c.SE_URANUS,  name: "Uranus" },
  { id: c.SE_NEPTUNE, name: "Neptune" },
  { id: c.SE_PLUTO,   name: "Pluto" },
  { id: c.SE_TRUE_NODE, name: "North Node" },
];

const ZODIAC_SIGNS = [
  "Aries", "Taurus", "Gemini", "Cancer",
  "Leo", "Virgo", "Libra", "Scorpio",
  "Sagittarius", "Capricorn", "Aquarius", "Pisces",
];

const FLAG = c.SEFLG_SWIEPH | c.SEFLG_SPEED;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function longitudeToZodiac(lon: number): { sign: string; degree: number; minute: number } {
  const normalized = ((lon % 360) + 360) % 360;
  const signIndex = Math.floor(normalized / 30);
  const degreeInSign = normalized % 30;
  const degree = Math.floor(degreeInSign);
  const minute = Math.floor((degreeInSign - degree) * 60);
  return {
    sign: ZODIAC_SIGNS[signIndex] ?? "Unknown",
    degree,
    minute,
  };
}

function formatDegree(lon: number): string {
  const { sign, degree, minute } = longitudeToZodiac(lon);
  return `${degree}°${minute}' ${sign}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanetPosition {
  name: string;
  longitude: number;
  zodiacSign: string;
  degree: number;
  minute: number;
  formatted: string;
  isRetrograde: boolean;
}

export interface BirthChart {
  sun: PlanetPosition;
  moon: PlanetPosition;
  ascendant: { longitude: number; zodiacSign: string; degree: number; minute: number; formatted: string };
  midheaven: { longitude: number; zodiacSign: string; degree: number; minute: number; formatted: string };
  planets: PlanetPosition[];
  houses: { number: number; longitude: number; zodiacSign: string; formatted: string }[];
  calculatedAt: string;
  inputData: {
    date: string;
    time: string;
    latitude: number;
    longitude: number;
    timezone: string;
  };
}

// ─── Core Calculation ─────────────────────────────────────────────────────────

function computeBirthChart(
  date: string,
  time: string,
  latitude: number,
  longitude: number,
  timezone: string
): BirthChart {
  // Parse local birth datetime and convert to UTC using luxon
  const localDt = DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", {
    zone: timezone,
  });

  if (!localDt.isValid) {
    throw new Error(
      `Invalid date/time: ${date} ${time} in timezone ${timezone}. Reason: ${localDt.invalidReason}`
    );
  }

  const utcDt = localDt.toUTC();

  // Calculate Julian Day (UT)
  const julianDay = swe.julday(
    utcDt.year,
    utcDt.month,
    utcDt.day,
    utcDt.hour + utcDt.minute / 60 + utcDt.second / 3600,
    c.SE_GREG_CAL
  );

  // ── Calculate planetary positions ──
  const planetPositions: PlanetPosition[] = [];

  for (const planet of PLANETS) {
    const result = swe.calc_ut(julianDay, planet.id, FLAG);

    // data[0]=longitude, data[1]=latitude, data[2]=distance
    // data[3]=lon_speed, data[4]=lat_speed, data[5]=dist_speed
    const lon = result.data[0] as number;
    const lonSpeed = result.data[3] as number;
    const isRetrograde = lonSpeed < 0;
    const zodiacData = longitudeToZodiac(lon);

    if (result.flag < 0) {
      console.warn(`Warning calculating ${planet.name}: ${result.error}`);
    }

    planetPositions.push({
      name: planet.name,
      longitude: lon,
      zodiacSign: zodiacData.sign,
      degree: zodiacData.degree,
      minute: zodiacData.minute,
      formatted: formatDegree(lon),
      isRetrograde,
    });
  }

  // ── Calculate houses (Placidus system) ──
  // houses() returns { flag, data: { houses: [12 cusps...], points: [asc, mc, ...] } }
  const housesResult = swe.houses(julianDay, latitude, longitude, "P");
  const houseData = housesResult.data as {
    houses: number[];
    points: number[];
  };

  // points[0] = Ascendant, points[1] = MC
  const ascLon = houseData.points[0] as number;
  const mcLon = houseData.points[1] as number;

  const houses = houseData.houses.slice(0, 12).map((lon: number, idx: number) => {
    const zodiacData = longitudeToZodiac(lon);
    return {
      number: idx + 1,
      longitude: lon,
      zodiacSign: zodiacData.sign,
      formatted: formatDegree(lon),
    };
  });

  const ascZodiac = longitudeToZodiac(ascLon);
  const mcZodiac = longitudeToZodiac(mcLon);

  const sun = planetPositions.find((p) => p.name === "Sun")!;
  const moon = planetPositions.find((p) => p.name === "Moon")!;

  return {
    sun,
    moon,
    ascendant: {
      longitude: ascLon,
      zodiacSign: ascZodiac.sign,
      degree: ascZodiac.degree,
      minute: ascZodiac.minute,
      formatted: formatDegree(ascLon),
    },
    midheaven: {
      longitude: mcLon,
      zodiacSign: mcZodiac.sign,
      degree: mcZodiac.degree,
      minute: mcZodiac.minute,
      formatted: formatDegree(mcLon),
    },
    planets: planetPositions,
    houses,
    calculatedAt: new Date().toISOString(),
    inputData: { date, time, latitude, longitude, timezone },
  };
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

// @ts-ignore: Type instantiation is excessively deep and possibly infinite
export const ephemerisTool = new DynamicStructuredTool({
  name: "compute_birth_chart",
  description:
    "Compute a complete astrological birth chart using the Swiss Ephemeris. " +
    "Returns precise planetary positions, zodiac signs, house cusps, ascendant, midheaven (MC), and True North Node. " +
    "Use this whenever the user asks about their sun sign, moon sign, rising sign, " +
    "planetary placements, houses, midheaven, or needs their birth chart calculated. " +
    "Requires date in YYYY-MM-DD format, time in HH:MM (24h), and an IANA timezone string.",
  schema: z.object({
    date: z
      .string()
      .describe("Birth date in YYYY-MM-DD format, e.g. '1990-05-15'"),
    time: z
      .string()
      .describe("Birth time in HH:MM 24-hour format, e.g. '14:30'"),
    latitude: z
      .number()
      .describe("Birth location latitude in decimal degrees, e.g. 22.5726"),
    longitude: z
      .number()
      .describe("Birth location longitude in decimal degrees, e.g. 88.3639"),
    timezone: z
      .string()
      .describe("IANA timezone string, e.g. 'Asia/Kolkata' or 'America/New_York'"),
  }) as any,
  func: async ({ date, time, latitude, longitude, timezone }: any): Promise<string> => {
    try {
      console.log(`🔭 Computing birth chart for ${date} ${time} @ (${latitude}, ${longitude}) [${timezone}]`);

      // ── Validate date parts ──
      const parts = date.split("-").map(Number);
      if (parts.length !== 3) {
        return JSON.stringify({ error: "Invalid date format. Please use YYYY-MM-DD (e.g. 1990-05-15)." });
      }

      const [year, month, day] = parts as [number, number, number];

      if (month < 1 || month > 12) {
        return JSON.stringify({
          error: `Invalid month ${month}. Month must be between 1 and 12.`,
        });
      }

      // Get actual days in the given month (handles leap years)
      const daysInMonth = new Date(year, month, 0).getDate();
      if (day < 1 || day > daysInMonth) {
        const monthNames = [
          "January","February","March","April","May","June",
          "July","August","September","October","November","December",
        ];
        return JSON.stringify({
          error: `Invalid date: ${monthNames[month - 1]} ${year} only has ${daysInMonth} days, but you entered day ${day}. Please provide a valid birth date.`,
        });
      }

      // ── Year and Future date check ──
      const currentYear = new Date().getFullYear();
      if (year < 1900 || year > currentYear) {
        return JSON.stringify({
          error: `Invalid year: ${year}. Please provide a valid birth year between 1900 and ${currentYear}.`,
        });
      }

      const birthDate = new Date(year, month - 1, day);
      if (birthDate > new Date()) {
        return JSON.stringify({
          error: `The birth date ${date} is in the future. Please provide your actual birth date.`,
        });
      }

      const chart = computeBirthChart(date, time, latitude, longitude, timezone);
      console.log(`✅ Birth chart computed. Sun: ${chart.sun.formatted}, Moon: ${chart.moon.formatted}, Asc: ${chart.ascendant.formatted}`);

      return JSON.stringify(chart);
    } catch (error) {
      console.error("Ephemeris tool error:", error);
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: `Birth chart calculation failed: ${message}` });
    }
  },
});

// ─── Daily Transits Tool ──────────────────────────────────────────────────────

export interface TransitAspect {
  transitPlanet: string;
  natalPlanet: string;
  aspect: string;
  orb: number;
}

export interface DailyTransits {
  date: string;
  transitingPlanets: PlanetPosition[];
  aspects: TransitAspect[];
  interpretation: string;
}

function calculateAspects(transitPlanets: PlanetPosition[], natalPlanets: PlanetPosition[]): TransitAspect[] {
  const aspects: TransitAspect[] = [];
  const MAJOR_ASPECTS = [
    { name: "Conjunction", angle: 0, orb: 5 },
    { name: "Sextile", angle: 60, orb: 4 },
    { name: "Square", angle: 90, orb: 5 },
    { name: "Trine", angle: 120, orb: 5 },
    { name: "Opposition", angle: 180, orb: 5 },
  ];

  for (const t of transitPlanets) {
    for (const n of natalPlanets) {
      let diff = Math.abs(t.longitude - n.longitude);
      if (diff > 180) diff = 360 - diff;

      for (const aspect of MAJOR_ASPECTS) {
        if (Math.abs(diff - aspect.angle) <= aspect.orb) {
          aspects.push({
            transitPlanet: t.name,
            natalPlanet: n.name,
            aspect: aspect.name,
            orb: Math.abs(diff - aspect.angle)
          });
        }
      }
    }
  }
  return aspects;
}

// @ts-ignore: Type instantiation is excessively deep and possibly infinite
export const dailyTransitsTool = new DynamicStructuredTool({
  name: "get_daily_transits",
  description:
    "Compute daily astrological transits by comparing current planetary positions against a natal chart. " +
    "Returns current planetary positions, major transit aspects (Conjunction, Square, etc.) and a concise astrological interpretation. " +
    "Requires the natal chart object (from compute_birth_chart) and target date in YYYY-MM-DD format.",
  schema: z.object({
    natalChart: z.any().describe("The user's complete birth chart object"),
    targetDate: z.string().describe("Target date in YYYY-MM-DD format, e.g. '2023-10-15'"),
    timezone: z.string().describe("Timezone string, e.g. 'UTC' (defaults to UTC if omitted)"),
  }) as any,
  func: async ({ natalChart, targetDate, timezone }: any): Promise<string> => {
    try {
      console.log(`🔭 Computing daily transits for ${targetDate}`);
      
      const tz = timezone || "UTC";
      
      // Calculate current planetary positions for the target date (noon)
      // Using a dummy latitude/longitude since we only need planetary positions for transits, not house cusps.
      // But we can reuse computeBirthChart by passing dummy coords and extracting just the planets.
      const currentChart = computeBirthChart(targetDate, "12:00", 0, 0, tz);
      const transitingPlanets = currentChart.planets;

      // Extract natal planets
      const natalPlanets = natalChart.planets || [];
      if (natalPlanets.length === 0) {
        return JSON.stringify({ error: "Invalid natal chart provided. Missing planets array." });
      }

      // Calculate aspects
      const aspects = calculateAspects(transitingPlanets, natalPlanets);

      // Generate a concise interpretation
      let interpretation = `On ${targetDate}, we observe ${aspects.length} major transit aspects to the natal chart. `;
      if (aspects.length > 0) {
        const topAspects = aspects.slice(0, 3);
        interpretation += topAspects.map(a => `Transiting ${a.transitPlanet} is in ${a.aspect} to natal ${a.natalPlanet}`).join(", ");
        interpretation += ".";
      }

      const result: DailyTransits = {
        date: targetDate,
        transitingPlanets,
        aspects,
        interpretation
      };

      console.log(`✅ Daily transits computed. Found ${aspects.length} aspects.`);
      return JSON.stringify(result);
    } catch (error) {
      console.error("Daily transits tool error:", error);
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: `Daily transits calculation failed: ${message}` });
    }
  },
});
