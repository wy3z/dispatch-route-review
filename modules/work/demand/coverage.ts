import { haversineKm } from "../../../shared/coordinates";
import type { EngineerBase, EngineerRegion } from "@/modules/engineers/contracts";

export type { EngineerRegion } from "../../engineers/contracts";

export type PlanningDemandExclusionReason =
  | "ungeocoded"
  | "outside_region"
  | "unsupported_region"
  | "no_covered_base"
  | "no_postcode"
  | "third_party"
  | "incomplete_data";

function nearestEngineerBase(
  latitude: number,
  longitude: number,
  bases: readonly EngineerBase[],
): EngineerBase | null {
  let nearest: EngineerBase | null = null;
  let nearestDistanceKm = Number.POSITIVE_INFINITY;
  for (const base of bases) {
    const distanceKm = haversineKm(
      latitude,
      longitude,
      base.latitude,
      base.longitude,
    );
    if (distanceKm < nearestDistanceKm) {
      nearestDistanceKm = distanceKm;
      nearest = base;
    }
  }
  return nearest;
}

const ukCountryCodes = new Set(["GB", "UK", "GBR"]);
const ukCountryNames = new Set([
  "united kingdom",
  "united kingdom of great britain and northern ireland",
  "great britain",
  "britain",
  "uk",
  "england",
  "scotland",
  "wales",
  "northern ireland",
  "isle of man",
  "guernsey",
  "jersey",
]);

function isNonUkCountry(code: string, name: string) {
  const normalisedCode = code.trim().toUpperCase();
  if (normalisedCode) return !ukCountryCodes.has(normalisedCode);
  const normalisedName = name.trim().toLocaleLowerCase("en-GB");
  if (!normalisedName) return false;
  return !ukCountryNames.has(normalisedName);
}

export type SiteCoverage = {
  region: EngineerRegion | null;
  exclusionReason: PlanningDemandExclusionReason | null;
  exclusionDetail: string | null;
};

/** Covered engineer region. A nearby UK base is not coverage for overseas work. */
export function resolveSiteCoverage(args: {
  latitude: number | null;
  longitude: number | null;
  postcode: string;
  countryCode: string;
  countryName: string;
}, engineerBases: readonly EngineerBase[]): SiteCoverage {
  const code = args.countryCode.trim().toUpperCase();
  const name = args.countryName.trim().toLocaleLowerCase("en-GB");

  // Ireland is its own demand group and has no covered engineer base.
  if (
    code === "IE" ||
    name === "ireland" ||
    name === "republic of ireland" ||
    name.includes("ireland, republic")
  ) {
    return {
      region: null,
      exclusionReason: "no_covered_base",
      exclusionDetail:
        "Republic of Ireland has no covered engineer base — excluded from planning.",
    };
  }

  if (isNonUkCountry(code, name)) {
    const place = args.countryName.trim() || args.countryCode.trim();
    return {
      region: null,
      exclusionReason: "no_covered_base",
      exclusionDetail: `${place} has no covered engineer base — excluded from planning.`,
    };
  }

  if (args.latitude === null || args.longitude === null) {
    if (!args.postcode) {
      return {
        region: null,
        exclusionReason: "no_postcode",
        exclusionDetail: "No postcode and no usable coordinates — excluded.",
      };
    }
    return {
      region: null,
      exclusionReason: "ungeocoded",
      exclusionDetail: "Site could not be geocoded — excluded from route preview.",
    };
  }

  const nearest = nearestEngineerBase(
    args.latitude,
    args.longitude,
    engineerBases,
  );
  if (!nearest) {
    return {
      region: null,
      exclusionReason: "unsupported_region",
      exclusionDetail: "No eligible engineer base covers this site.",
    };
  }

  return {
    region: nearest.region,
    exclusionReason: null,
    exclusionDetail: null,
  };
}
