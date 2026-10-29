const DEVELOPMENT_UK_GEOCODER_URL = "https://api.postcodes.io/postcodes";
const DEVELOPMENT_EU_GEOCODER_URL =
  "https://nominatim.openstreetmap.org/search";

export type GeocoderEnvironment = {
  NODE_ENV?: string;
  UK_GEOCODER_URL?: string;
  EU_GEOCODER_URL?: string;
  GEOCODER_ALLOWED_HOSTS?: string;
  GEOCODER_USER_AGENT_CONTACT?: string;
};

export type GeocoderConfiguration = {
  ukUrl: string;
  ukHost: string;
  euUrl: string;
  euHost: string;
  userAgent: string;
};

function configuredValue(
  environment: GeocoderEnvironment,
  name: keyof GeocoderEnvironment,
) {
  return environment[name]?.trim() ?? "";
}

function allowedHosts(environment: GeocoderEnvironment, production: boolean) {
  const hosts = new Set(
    configuredValue(environment, "GEOCODER_ALLOWED_HOSTS")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!production) {
    hosts.add(new URL(DEVELOPMENT_UK_GEOCODER_URL).host.toLowerCase());
    hosts.add(new URL(DEVELOPMENT_EU_GEOCODER_URL).host.toLowerCase());
  }
  return hosts;
}

function approvedEndpoint(
  environment: GeocoderEnvironment,
  name: "UK_GEOCODER_URL" | "EU_GEOCODER_URL",
  developmentFallback: string,
  approvedHosts: Set<string>,
  production: boolean,
) {
  const configured = configuredValue(environment, name);
  if (!configured && production) {
    throw new Error(`${name} is required in production.`);
  }

  let url: URL;
  try {
    url = new URL(configured || developmentFallback);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include URL credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not include a query string or fragment.`);
  }

  const host = url.host.toLowerCase();
  if (!approvedHosts.has(host)) {
    throw new Error(
      `${name} host "${host}" is not listed in GEOCODER_ALLOWED_HOSTS.`,
    );
  }
  return { url: url.toString(), host };
}

function userAgent(environment: GeocoderEnvironment, production: boolean) {
  const contact = configuredValue(environment, "GEOCODER_USER_AGENT_CONTACT");
  if (!contact) {
    if (production) {
      throw new Error("GEOCODER_USER_AGENT_CONTACT is required in production.");
    }
    return "DispatchRouteReview/0.1";
  }

  let url: URL;
  try {
    url = new URL(contact);
  } catch {
    throw new Error("GEOCODER_USER_AGENT_CONTACT must be a valid absolute URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("GEOCODER_USER_AGENT_CONTACT must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "GEOCODER_USER_AGENT_CONTACT must not include credentials, a query string or fragment.",
    );
  }
  // A contact is embedded in the User-Agent comment, so it cannot break that header.
  if (
    /[\s()]/.test(contact) ||
    [...contact].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error(
      "GEOCODER_USER_AGENT_CONTACT must not include whitespace, parentheses or control characters.",
    );
  }
  return `DispatchRouteReview/0.1 (${url.toString()})`;
}

export function geocoderConfiguration(
  environment: GeocoderEnvironment = process.env as GeocoderEnvironment,
): GeocoderConfiguration {
  const production = environment.NODE_ENV === "production";
  const approvedHosts = allowedHosts(environment, production);
  const uk = approvedEndpoint(
    environment,
    "UK_GEOCODER_URL",
    DEVELOPMENT_UK_GEOCODER_URL,
    approvedHosts,
    production,
  );
  const eu = approvedEndpoint(
    environment,
    "EU_GEOCODER_URL",
    DEVELOPMENT_EU_GEOCODER_URL,
    approvedHosts,
    production,
  );
  return {
    ukUrl: uk.url,
    ukHost: uk.host,
    euUrl: eu.url,
    euHost: eu.host,
    userAgent: userAgent(environment, production),
  };
}
