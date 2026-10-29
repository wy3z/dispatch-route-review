import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(
  join(process.cwd(), "app/engineers/EngineerManagementClient.tsx"),
  "utf8",
);

function selectSection(ariaLabel: string) {
  const start = source.indexOf(`aria-label="${ariaLabel}"`);
  assert.notEqual(start, -1, `missing ${ariaLabel}`);
  const end = source.indexOf("</select>", start);
  assert.notEqual(end, -1, `unterminated ${ariaLabel}`);
  return source.slice(start, end);
}

test("unavailable third-party statuses can only be removed, not newly added", () => {
  const unselected = selectSection("Unselected Autotask statuses");
  const selected = selectSection("Selected third-party Autotask statuses");

  assert.match(unselected, /disabled=\{!item\.available\}/);
  assert.doesNotMatch(selected, /disabled=\{!item\.available\}/);
  assert.match(selected, /\(unavailable\)/);
});
