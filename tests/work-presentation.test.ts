import assert from "node:assert/strict";
import test from "node:test";
import {
  demandQueueLabel,
  demandWorkstreamColour,
  jobTypeLabel,
} from "../modules/work/presentation";

test("booked labels use the ID-derived job type, never editable queue text", () => {
  assert.equal(jobTypeLabel("support", "Install"), "Support");
  assert.equal(jobTypeLabel("install", "Renamed queue"), "Install");
  assert.equal(jobTypeLabel("survey", "Content Update"), "Survey");
  assert.equal(jobTypeLabel("other", "Custom queue"), "Custom queue");
  assert.equal(jobTypeLabel("other", "  "), "Queue not set");
});

test("demand labels and colours use the ID-derived workstream", () => {
  assert.equal(
    demandQueueLabel({ workstream: "support", queueLabel: "Install" }),
    "Support",
  );
  assert.equal(
    demandQueueLabel({ workstream: "other", queueLabel: "Maintenance" }),
    "Maintenance",
  );
  assert.equal(demandWorkstreamColour("install"), "#7C5CFC");
  assert.equal(demandWorkstreamColour("support"), "#00A7D6");
  assert.equal(demandWorkstreamColour("other"), "#2EAE72");
});
