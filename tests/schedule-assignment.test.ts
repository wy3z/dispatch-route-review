import assert from "node:assert/strict";
import test from "node:test";
import { findEngineerBase } from "../modules/engineers/model";
import { classifyScheduleVisitOwner } from "../modules/work/schedule/assignment";

const defaultInput = {
  isThirdPartyStatus: false,
  ticketStatusId: 12,
  thirdPartyCompanyField: "Supplier field",
  thirdPartyLabel: "Vendor attending",
  isComplete: false,
  assignmentCount: 0,
  recognisedAssignmentCount: 0,
  recognisedAssignment: null,
};

test("configured third-party statuses are the only third-party ownership signal", () => {
  assert.deepEqual(
    classifyScheduleVisitOwner({
      ...defaultInput,
      isThirdPartyStatus: true,
      isComplete: true,
      assignmentCount: 1,
    }),
    {
      resourceId: null,
      resourceName: "Vendor attending",
      routeOwnerKey: "third-party:12",
      ownerType: "third-party",
      ignoredResourceCount: 0,
    },
  );
});

test("completed calls with no assignment remain explicitly unassigned", () => {
  assert.deepEqual(
    classifyScheduleVisitOwner({
      ...defaultInput,
      isComplete: true,
    }),
    {
      resourceId: null,
      resourceName: "Completed — no assigned engineer",
      routeOwnerKey: "unassigned",
      ownerType: "unassigned",
      ignoredResourceCount: 0,
    },
  );
});

test("completed calls with unknown resources preserve the mismatch count", () => {
  assert.deepEqual(
    classifyScheduleVisitOwner({
      ...defaultInput,
      isComplete: true,
      assignmentCount: 2,
    }),
    {
      resourceId: null,
      resourceName: "Completed — no recognised engineer",
      routeOwnerKey: "unassigned",
      ownerType: "unassigned",
      ignoredResourceCount: 2,
    },
  );
});

test("inactive retained roster engineers still own historical bookings", () => {
  const inactiveEngineer = {
    resourceId: 77,
    name: "Historical Engineer",
    base: "York",
    region: "North" as const,
    latitude: 53.959,
    longitude: -1.0815,
    active: false,
    workingDays: [1, 2, 3, 4, 5],
    workdayStart: "09:00",
    workdayEnd: "17:00",
  };
  const recognised = findEngineerBase(
    [inactiveEngineer],
    inactiveEngineer.resourceId,
    inactiveEngineer.name,
  );
  assert.ok(recognised);
  assert.deepEqual(
    classifyScheduleVisitOwner({
      ...defaultInput,
      isComplete: true,
      assignmentCount: 1,
      recognisedAssignmentCount: 1,
      recognisedAssignment: {
        resourceId: inactiveEngineer.resourceId,
        resourceName: recognised.name,
      },
    }),
    {
      resourceId: 77,
      resourceName: "Historical Engineer",
      routeOwnerKey: "77",
      ownerType: "internal",
      ignoredResourceCount: 0,
    },
  );
});

test("company UDF separates suppliers within a status and joins kit/non-kit attendance", () => {
  const classify = (status: number, company: string) => classifyScheduleVisitOwner({
    ...defaultInput,
    isThirdPartyStatus: true,
    ticketStatusId: status,
    thirdPartyLabel: "Third Party Attending",
    ticketUserDefinedFields: [
      { name: "Supplier field", value: company },
      { name: "Third Party Engineer", value: "Individual engineer" },
    ],
  });
  const first = classify(710, "Supplier A");
  const second = classify(710, "Supplier B");
  assert.equal(first.resourceName, "Supplier A");
  assert.notEqual(first.routeOwnerKey, second.routeOwnerKey);
  assert.equal(first.routeOwnerKey, classify(711, "Supplier A").routeOwnerKey);
  assert.equal(first.resourceId, null);
});

test("company values are authoritative across legacy statuses and remain exact", () => {
  const classify = (value: string, ticketStatusId = 12) => classifyScheduleVisitOwner({
    ...defaultInput,
    isThirdPartyStatus: true,
    ticketStatusId,
    ticketUserDefinedFields: [{ name: "Supplier field", value }],
  });
  assert.equal(classify("Supplier A").routeOwnerKey, classify("Supplier A", 710).routeOwnerKey);
  assert.notEqual(classify("A/B").routeOwnerKey, classify("A%2FB").routeOwnerKey);
  assert.notEqual(classify("Supplier A").routeOwnerKey, classify("supplier a").routeOwnerKey);
  assert.equal(classify("Supplier A").thirdPartyCompany, "Supplier A");
});

test("missing or malformed company UDFs preserve fallback ownership", () => {
  for (const fields of [undefined, null, {}, [], [null],
    [{ name: "Supplier field", value: "  " }],
    [{ name: "Supplier field", value: 123 }],
    [{ name: "Supplier field", value: { label: "Supplier" } }],
    [{ name: "Third Party Engineer", value: "Individual engineer" }],
  ]) {
    const owner = classifyScheduleVisitOwner({
      ...defaultInput, isThirdPartyStatus: true, ticketUserDefinedFields: fields,
    });
    assert.equal(owner.resourceName, "Vendor attending");
    assert.equal(owner.routeOwnerKey, "third-party:12");
    assert.equal(owner.ownerType, "third-party");
  }
  const missing = [710, 711].map((ticketStatusId) => classifyScheduleVisitOwner({
    ...defaultInput, isThirdPartyStatus: true, ticketStatusId,
    thirdPartyLabel: `Vendor status ${ticketStatusId} — company not set`,
  }));
  assert.notEqual(missing[0].resourceName, missing[1].resourceName);
  assert.match(missing[0].resourceName, /company not set/);
});

test("a company UDF never overrides an unselected status or internal resource", () => {
  const owner = classifyScheduleVisitOwner({
    ...defaultInput,
    ticketUserDefinedFields: [{ name: "Supplier field", value: "Supplier A" }],
    recognisedAssignment: { resourceId: 77, resourceName: "Internal engineer" },
    recognisedAssignmentCount: 1,
    assignmentCount: 1,
  });
  assert.equal(owner.ownerType, "internal");
  assert.equal(owner.resourceName, "Internal engineer");
  assert.equal(owner.thirdPartyCompany, undefined);
});

test("unset company field ignores supplier UDFs and uses status ownership", () => {
  const owner = classifyScheduleVisitOwner({
    ...defaultInput, isThirdPartyStatus: true, thirdPartyCompanyField: null,
    ticketUserDefinedFields: [{ name: "Supplier field", value: "Supplier A" }],
  });
  assert.equal(owner.routeOwnerKey, "third-party:12");
  assert.equal(owner.resourceName, "Vendor attending");
});
