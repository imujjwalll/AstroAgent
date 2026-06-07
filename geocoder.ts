import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import NodeGeocoder from "node-geocoder";
import { find as findTimezone } from "geo-tz";

// ─── Geocoder setup ───────────────────────────────────────────────────────────

const geocoder = NodeGeocoder({
  provider: "openstreetmap",
  formatter: null,
} as any);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeocodeResult {
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
  country: string;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

// @ts-ignore: Type instantiation is excessively deep and possibly infinite
export const geocoderTool = new DynamicStructuredTool({
  name: "geocode_city",
  description:
    "Convert a city name into precise latitude, longitude, timezone, and country. " +
    "Use this when you need geographic coordinates for a birth city. " +
    "Input the city name exactly as provided by the user.",
  schema: z.object({
    city: z.string().describe("The city name to geocode, e.g. 'Mumbai' or 'New York'"),
  }) as any,
  func: async ({ city }: any): Promise<string> => {
    try {
      console.log(`🌍 Geocoding city: ${city}`);

      const results = await geocoder.geocode(city);

      if (!results || results.length === 0) {
        return JSON.stringify({
          error: `Could not find coordinates for city: "${city}". Please verify the city name and try again.`,
        });
      }

      const best = results[0];
      const lat = best.latitude;
      const lon = best.longitude;

      if (lat === undefined || lat === null || lon === undefined || lon === null) {
        return JSON.stringify({
          error: `Geocoding returned incomplete data for "${city}". Try a more specific location.`,
        });
      }

      // Use geo-tz for accurate IANA timezone lookup
      const timezones = findTimezone(lat, lon);
      const timezone = timezones.length > 0 ? timezones[0] : "UTC";

      const result: GeocodeResult = {
        city: best.city || best.formattedAddress || city,
        latitude: lat,
        longitude: lon,
        timezone,
        country: best.country || "Unknown",
      };

      console.log(`✅ Geocoded ${city}:`, result);
      return JSON.stringify(result);
    } catch (error) {
      console.error("Geocoder error:", error);
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        error: `Geocoding failed for "${city}": ${message}. Please check the city name and try again.`,
      });
    }
  },
});
