import type { ScheduledVisit } from "../contracts";

type RecognisedScheduleAssignment = {
  resourceId: number;
  resourceName: string;
};

type ScheduleVisitOwner = Pick<
  ScheduledVisit,
  | "resourceId"
  | "resourceName"
  | "routeOwnerKey"
  | "ownerType"
  | "ignoredResourceCount"
  | "thirdPartyCompany"
>;

function thirdPartyCompanyValue(fields: unknown, fieldName: string | null): string | null {
  if (!fieldName || !Array.isArray(fields)) return null;
  const field = fields.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      entry.name === fieldName,
  );
  return typeof field?.value === "string" && field.value.trim()
    ? field.value
    : null;
}

export function classifyScheduleVisitOwner({
  isThirdPartyStatus,
  ticketStatusId,
  thirdPartyLabel,
  ticketUserDefinedFields,
  thirdPartyCompanyField = null,
  isComplete,
  assignmentCount,
  recognisedAssignmentCount,
  recognisedAssignment,
}: {
  isThirdPartyStatus: boolean;
  ticketStatusId: number;
  thirdPartyLabel: string;
  ticketUserDefinedFields?: unknown;
  thirdPartyCompanyField?: string | null;
  isComplete: boolean;
  assignmentCount: number;
  recognisedAssignmentCount: number;
  recognisedAssignment: RecognisedScheduleAssignment | null;
}): ScheduleVisitOwner {
  if (isThirdPartyStatus) {
    const thirdPartyCompany = thirdPartyCompanyValue(ticketUserDefinedFields, thirdPartyCompanyField);
    if (thirdPartyCompany) {
      return {
        resourceId: null,
        resourceName: thirdPartyCompany.trim(),
        routeOwnerKey: `third-party:company:${encodeURIComponent(thirdPartyCompany)}`,
        ownerType: "third-party",
        thirdPartyCompany,
        ignoredResourceCount: 0,
      };
    }
    return {
      resourceId: null,
      resourceName: thirdPartyLabel,
      routeOwnerKey: `third-party:${ticketStatusId}`,
      ownerType: "third-party",
      ignoredResourceCount: 0,
    };
  }

  const ignoredResourceCount = Math.max(
    0,
    assignmentCount - recognisedAssignmentCount,
  );
  if (recognisedAssignment) {
    return {
      resourceId: recognisedAssignment.resourceId,
      resourceName: recognisedAssignment.resourceName,
      routeOwnerKey: String(recognisedAssignment.resourceId),
      ownerType: "internal",
      ignoredResourceCount,
    };
  }

  return {
    resourceId: null,
    resourceName: assignmentCount
      ? isComplete
        ? "Completed — no recognised engineer"
        : "No recognised engineer"
      : isComplete
        ? "Completed — no assigned engineer"
        : "No assigned engineer",
    routeOwnerKey: "unassigned",
    ownerType: "unassigned",
    ignoredResourceCount,
  };
}
