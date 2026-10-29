// Fictional records at fixed geographic points; no customer or home addresses.
export const demoEngineers = [
  { resourceId: 990001, name: "Demo Engineer One", base: "Demo Base Salford", latitude: 53.4875, longitude: -2.2901 },
  { resourceId: 990002, name: "Demo Engineer Two", base: "Demo Base Stockport", latitude: 53.4106, longitude: -2.1575 },
  { resourceId: 990003, name: "Demo Engineer Three", base: "Demo Base Trafford", latitude: 53.4617, longitude: -2.3223 },
  { resourceId: 990004, name: "Demo Engineer Four", base: "Demo Base Bury", latitude: 53.5933, longitude: -2.2966 },
  { resourceId: 990005, name: "Demo Engineer Five", base: "Demo Base Rochdale", latitude: 53.6154, longitude: -2.1552 },
  { resourceId: 990006, name: "Demo Engineer Six", base: "Demo Base Altrincham", latitude: 53.3871, longitude: -2.3507 },
];

export const demoSites = [
  { name: "Demo Site A", city: "Manchester", latitude: 53.4808, longitude: -2.2426 },
  { name: "Demo Site B", city: "Salford", latitude: 53.4723, longitude: -2.2982 },
  { name: "Demo Site C", city: "Stockport", latitude: 53.4083, longitude: -2.1494 },
  { name: "Demo Site D", city: "Trafford", latitude: 53.4663, longitude: -2.3125 },
  { name: "Demo Site E", city: "Bury", latitude: 53.5925, longitude: -2.2979 },
  { name: "Demo Site F", city: "Rochdale", latitude: 53.6172, longitude: -2.1587 },
  { name: "Demo Site G", city: "Altrincham", latitude: 53.3875, longitude: -2.3498 },
  { name: "Demo Site H", city: "Oldham", latitude: 53.5409, longitude: -2.1114 },
  { name: "Demo Site I", city: "Bolton", latitude: 53.5785, longitude: -2.4299 },
  { name: "Demo Site Outlier", city: "Lerwick", latitude: 60.1551, longitude: -1.1451 },
];

// Engineer One overlaps; Engineer Two has five minutes from Salford to Stockport;
// Engineer Three's final stop is beyond the 700 km routing limit.
export const demoVisits = [
  { engineer: 0, site: 0, start: 540, end: 630, queue: "support" },
  { engineer: 0, site: 1, start: 600, end: 660, queue: "support" },
  { engineer: 0, site: 3, start: 840, end: 930, queue: "install" },
  { engineer: 1, site: 1, start: 540, end: 600, queue: "support" },
  { engineer: 1, site: 2, start: 605, end: 665, queue: "support" },
  { engineer: 1, site: 6, start: 840, end: 930, queue: "survey" },
  { engineer: 2, site: 3, start: 540, end: 600, queue: "support" },
  { engineer: 2, site: 6, start: 690, end: 750, queue: "install" },
  { engineer: 2, site: 9, start: 900, end: 960, queue: "support" },
  { engineer: 3, site: 4, start: 540, end: 600, queue: "survey" },
  { engineer: 3, site: 8, start: 690, end: 780, queue: "install" },
  { engineer: 3, site: 0, start: 870, end: 930, queue: "support" },
  { engineer: 4, site: 5, start: 540, end: 600, queue: "support" },
  { engineer: 4, site: 7, start: 690, end: 780, queue: "install" },
  { engineer: 4, site: 0, start: 870, end: 930, queue: "support" },
  { engineer: 5, site: 6, start: 540, end: 600, queue: "support" },
  { engineer: 5, site: 3, start: 690, end: 780, queue: "survey" },
  { engineer: 5, site: 1, start: 870, end: 930, queue: "install" },
] as const;

export const demoDemand = [
  { site: 0, queue: "ready", status: "ready", daysOld: 0, dueInDays: 0 },
  { site: 1, queue: "ready", status: "ready", daysOld: 2, dueInDays: 1 },
  { site: 2, queue: "ready", status: "ready", daysOld: 1, dueInDays: 3 },
  { site: 3, queue: "support", status: "access", daysOld: 3, dueInDays: -1 },
  { site: 4, queue: "install", status: "requested", daysOld: 0, dueInDays: 7 },
  { site: 5, queue: "install", status: "access", daysOld: 5, dueInDays: 2 },
  { site: 7, queue: "support", status: "thirdParty", daysOld: 2, dueInDays: 5 },
  { site: 8, queue: "install", status: "requested", daysOld: 4, dueInDays: -2 },
] as const;
