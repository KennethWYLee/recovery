import assert from "node:assert/strict";
import test from "node:test";

import { observabilityRoleFocus } from "../lib/observability-role-focus.ts";

test("each operations persona receives a distinct observability question", () => {
  const roles = ["commander", "responder", "auditor", "observer"];
  const focus = roles.map((role) => observabilityRoleFocus(role));
  assert.equal(new Set(focus.map((item) => item.verificationQuestion)).size, roles.length);
  assert.ok(focus.every((item) => item.title && item.description && item.verificationQuestion.endsWith("？")));
  assert.deepEqual(observabilityRoleFocus("admin"), observabilityRoleFocus("commander"));
});
