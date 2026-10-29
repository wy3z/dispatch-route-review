import assert from "node:assert/strict";
import test from "node:test";
import { buildEngineerRoutes } from "../modules/routing/route-builder";
import { findRouteIssues } from "../modules/routing/issues";
import { classifyScheduleVisitOwner } from "../modules/work/schedule/assignment";
import {
  buildServiceCallTicketContexts,
  reconcileServiceCallProjection,
} from "../modules/work/worker/service-call-ticket-links";
import type { ScheduledVisit } from "../modules/work/contracts";

function linkMap(links: Array<Record<string, unknown>>) {
  const byServiceCall = new Map<number, Array<Record<string, unknown>>>();
  links.forEach((link) => {
    const serviceCallId = Number(link.serviceCallID);
    byServiceCall.set(serviceCallId, [
      ...(byServiceCall.get(serviceCallId) ?? []),
      link,
    ]);
  });
  return byServiceCall;
}

function ticketMap(tickets: Array<Record<string, unknown>>) {
  return new Map(tickets.map((ticket) => [Number(ticket.id), ticket]));
}

test("zero ticket links still produce one source service-call context", () => {
  const [context] = buildServiceCallTicketContexts(
    [{ id: 401 }],
    new Map(),
    new Map(),
    new Set(),
  );

  assert.ok(context);
  assert.equal(context.serviceCallId, 401);
  assert.deepEqual(context.relatedLinks, []);
  assert.equal(context.ticketId, null);
  assert.equal(context.ticket, null);
  assert.equal(context.additionalTicketCount, 0);
});

test("a completed zero-link context remains unassigned when projected", () => {
  const [context] = buildServiceCallTicketContexts(
    [{ id: 401, isComplete: 1 }],
    new Map(),
    new Map(),
    new Set(),
  );
  assert.ok(context);

  const owner = classifyScheduleVisitOwner({
    isThirdPartyStatus: false,
    ticketStatusId: 0,
    thirdPartyLabel: "Ticket not linked",
    isComplete: Number(context.call.isComplete) === 1,
    assignmentCount: 0,
    recognisedAssignmentCount: 0,
    recognisedAssignment: null,
  });

  assert.equal(owner.ownerType, "unassigned");
  assert.equal(owner.routeOwnerKey, "unassigned");
  assert.equal(owner.resourceId, null);
  assert.equal(owner.resourceName, "Completed — no assigned engineer");
});

test("one ticket link resolves its ticket", () => {
  const link = { id: 11, serviceCallID: 401, ticketID: 501 };
  const ticket = { id: 501, status: 10, ticketNumber: "T501" };
  const [context] = buildServiceCallTicketContexts(
    [{ id: 401 }],
    linkMap([link]),
    ticketMap([ticket]),
    new Set(),
  );

  assert.equal(context.ticketId, 501);
  assert.equal(context.ticket, ticket);
  assert.equal(context.additionalTicketCount, 0);
});

test("multiple ticket links retain their count and prefer the third-party ticket", () => {
  const normalLink = { id: 11, serviceCallID: 401, ticketID: 501 };
  const thirdPartyLink = { id: 12, serviceCallID: 401, ticketID: 502 };
  const normalTicket = { id: 501, status: 10 };
  const thirdPartyTicket = { id: 502, status: 99 };
  const [context] = buildServiceCallTicketContexts(
    [{ id: 401 }],
    linkMap([normalLink, thirdPartyLink]),
    ticketMap([normalTicket, thirdPartyTicket]),
    new Set([99]),
  );

  assert.equal(context.ticketId, 502);
  assert.equal(context.ticket, thirdPartyTicket);
  assert.equal(context.relatedLinks.length, 2);
  assert.equal(context.additionalTicketCount, 1);
});

test("a ticket link whose ticket lookup fails remains linked and projected", () => {
  const link = { id: 11, serviceCallID: 401, ticketID: 599 };
  const [context] = buildServiceCallTicketContexts(
    [{ id: 401 }],
    linkMap([link]),
    new Map(),
    new Set(),
  );

  assert.equal(context.ticketId, 599);
  assert.equal(context.ticket, null);
  assert.equal(context.relatedLinks.length, 1);
});

test("source and projected service-call counts reconcile across duplicate assignments", () => {
  const contexts = buildServiceCallTicketContexts(
    [{ id: 401 }, { id: 402 }, { id: 403 }],
    new Map(),
    new Map(),
    new Set(),
  );
  const complete = reconcileServiceCallProjection(contexts, [
    { serviceCallId: 401 },
    { serviceCallId: 402 },
    { serviceCallId: 402 },
    { serviceCallId: 403 },
  ]);
  assert.deepEqual(complete, {
    sourceCount: 3,
    projectedCount: 3,
    unprojectedServiceCallIds: [],
  });

  const incomplete = reconcileServiceCallProjection(contexts, [
    { serviceCallId: 401 },
    { serviceCallId: 402 },
    { serviceCallId: 402 },
  ]);
  assert.deepEqual(incomplete, {
    sourceCount: 3,
    projectedCount: 2,
    unprojectedServiceCallIds: [403],
  });
  assert.equal(
    incomplete.sourceCount,
    incomplete.projectedCount + incomplete.unprojectedServiceCallIds.length,
  );
});

test("an unlinked placeholder is presented as a data-quality issue", () => {
  const visit: ScheduledVisit = {
    id: "401-unassigned",
    serviceCallId: 401,
    ticketId: null,
    ticketNumber: "",
    title: "Service call 401",
    autotaskUrl: null,
    companyName: "Example Company",
    locationName: "Example Site",
    address: "1 Example Street",
    city: "Manchester",
    postcode: "M1 1AA",
    resourceId: null,
    resourceName: "No assigned engineer",
    routeOwnerKey: "unassigned",
    ownerType: "unassigned",
    ticketStatusId: 0,
    ticketStatusLabel: "Ticket not linked",
    queueId: 0,
    queueLabel: "Queue not set",
    jobType: "other",
    ignoredResourceCount: 0,
    startDateTime: "2026-08-20T09:00:00.000Z",
    endDateTime: "2026-08-20T10:00:00.000Z",
    durationMinutes: 60,
    status: 1,
    isComplete: false,
    latitude: 53.4808,
    longitude: -2.2426,
    additionalTicketCount: 0,
  };
  const [route] = buildEngineerRoutes([visit], []);
  const issue = findRouteIssues([route], []).find(
    (candidate) => candidate.kind === "missing-ticket-link",
  );

  assert.ok(issue);
  assert.equal(issue.severity, "data");
  assert.equal(issue.visitId, visit.id);
  assert.equal(issue.title, "Scheduled call has no ticket link");
  assert.match(issue.detail, /shown using service-call data/i);
});
