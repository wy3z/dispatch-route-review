/** Existing booking attendance, not an optimiser proposal. */
export type ScheduledVisit = {
  /** Display-row identity includes attendance ownership; use source IDs for work identity. */
  id: string;
  serviceCallId: number;
  ticketId: number | null;
  ticketNumber: string;
  title: string;
  /** Absent in worker snapshots; null explicitly suppresses links. */
  autotaskUrl?: string | null;
  companyName: string;
  locationName: string;
  address: string;
  city: string;
  postcode: string;
  resourceId: number | null;
  resourceName: string;
  routeOwnerKey: string;
  ownerType: "internal" | "third-party" | "unassigned";
  /** Exact configured company field value; absent in older snapshots. */
  thirdPartyCompany?: string | null;
  ticketStatusId: number;
  ticketStatusLabel: string;
  queueId: number;
  queueLabel: string;
  jobType: "install" | "support" | "survey" | "other";
  ignoredResourceCount: number;
  startDateTime: string;
  endDateTime: string;
  durationMinutes: number;
  status: number;
  isComplete: boolean;
  latitude: number | null;
  longitude: number | null;
  additionalTicketCount: number;
};

export type ScheduleSnapshot = {
  source: "autotask";
  date: string;
  generatedAt: string;
  visits: ScheduledVisit[];
  warnings: string[];
};

export type { PlanningDemandItem, PlanningDemandSnapshot } from "./demand/model";

export type { ReviewCacheState } from "./client/review-cache-view";

export type { ThirdPartyVisitStatus } from "./server/third-party-statuses";

export type { AutotaskUsagePayload } from "./usage";
