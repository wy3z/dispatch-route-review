import {
  listAuditFilters,
  listAuditEvents,
  authenticateRequest,
  authErrorResponse,
  requireRole,
  auditApiRequest,
} from "@/modules/access/server";
import { auditEventsToCsv, validAuditDate } from "@/modules/access/domain";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;
const CSV_MAX_ROWS = 50_000;

function optionalFilter(value: string | null, maxLength: number) {
  if (value === null || value === "") return null;
  return value.length <= maxLength ? value : undefined;
}

export async function GET(request: Request) {
  return auditApiRequest(request, async () => {
   try {
    const user = await authenticateRequest(request);
    requireRole(user, ["admin"]);
    const params = new URL(request.url).searchParams;
    const requestedLimit = Number(params.get("limit") ?? "100");
    const format = params.get("format");
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      return Response.json({ message: "Invalid audit log limit." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    if (format !== null && format !== "csv") {
      return Response.json({ message: "Invalid audit export format." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const action = optionalFilter(params.get("action"), 160);
    const resource = optionalFilter(params.get("resource"), 320);
    const entityType = optionalFilter(params.get("entityType"), 160);
    const entityId = optionalFilter(params.get("entityId"), 200);
    // `date` still works for old bookmarks. New clients send dateFrom/dateTo.
    const rawLegacyDate = params.get("date");
    const rawDateFrom = params.get("dateFrom");
    const rawDateTo = params.get("dateTo");
    const legacyDate = validAuditDate(rawLegacyDate);
    const explicitDateFrom = validAuditDate(rawDateFrom);
    const explicitDateTo = validAuditDate(rawDateTo);
    if (
      action === undefined ||
      resource === undefined ||
      entityType === undefined ||
      entityId === undefined
    ) {
      return Response.json({ message: "An audit filter is too long." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    if (
      legacyDate === undefined ||
      explicitDateFrom === undefined ||
      explicitDateTo === undefined
    ) {
      return Response.json({ message: "Valid audit start and end dates are required." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    if ((rawDateFrom === null) !== (rawDateTo === null)) {
      return Response.json({ message: "Audit start and end dates must be supplied together." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const dateFrom = explicitDateFrom ?? legacyDate;
    const dateTo = explicitDateTo ?? legacyDate;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return Response.json({ message: "Audit start date must not be after the end date." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const limit = format === "csv" ? CSV_MAX_ROWS + 1 : Math.min(250, requestedLimit);
    const events = await listAuditEvents({action, resource, entityType, entityId, dateFrom, dateTo, limit});
    if (format === "csv") {
      if (events.length > CSV_MAX_ROWS) {
        return Response.json(
          { message: "The export exceeds 50,000 events. Add filters and try again." },
          { status: 413, headers: PRIVATE_HEADERS },
        );
      }
      const filenameDate = dateFrom && dateTo && dateFrom !== dateTo
        ? `${dateFrom}-to-${dateTo}`
        : dateFrom ?? dateTo ?? new Date().toISOString().slice(0, 10);
      return new Response(auditEventsToCsv(events), {
        headers: {
          ...PRIVATE_HEADERS,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-events-${filenameDate}.csv"`,
        },
      });
    }
    const { resources, actions } = await listAuditFilters();
    return Response.json(
      {
        events,
        filterOptions: {
          resources: resources,
          actions: actions,
        },
      },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
  });
}
