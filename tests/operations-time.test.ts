import assert from "node:assert/strict";
import test from "node:test";

import {
  parseZonedDateTimeInput,
  resolveOrganizationTimeZone,
  toZonedDateTimeInput,
} from "../lib/operations-time.ts";

test("organization timezone resolution fails closed to UTC", () => {
  assert.equal(resolveOrganizationTimeZone(undefined), "UTC");
  assert.equal(resolveOrganizationTimeZone("not/a-timezone"), "UTC");
  assert.equal(resolveOrganizationTimeZone(" Asia/Taipei "), "Asia/Taipei");
});

test("organization-local input round-trips to one UTC instant", () => {
  const instant = "2026-07-31T02:00:00.000Z";
  assert.equal(toZonedDateTimeInput(instant, "Asia/Taipei"), "2026-07-31T10:00");
  assert.equal(parseZonedDateTimeInput("2026-07-31T10:00", "Asia/Taipei")?.toISOString(), instant);
});

test("nonexistent and repeated daylight-saving local times are rejected", () => {
  assert.equal(parseZonedDateTimeInput("2026-03-08T02:30", "America/New_York"), null);
  assert.equal(parseZonedDateTimeInput("2026-11-01T01:30", "America/New_York"), null);
  assert.equal(
    parseZonedDateTimeInput("2026-11-01T03:30", "America/New_York")?.toISOString(),
    "2026-11-01T08:30:00.000Z",
  );
});
