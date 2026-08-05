import assert from "node:assert/strict";
import test from "node:test";
import { requestIsSameOrigin, resolveClassroomIdentity } from "../lib/classroom-auth.ts";

test("localhost identity is accepted only from explicit classroom settings", () => {
  const request = new Request("http://127.0.0.1:3000/api/classroom/courses");
  assert.equal(resolveClassroomIdentity(request, { CLASSROOM_ENVIRONMENT: "development" }), null);
  assert.deepEqual(resolveClassroomIdentity(request, {
    CLASSROOM_ENVIRONMENT: "development",
    CLASSROOM_LOCAL_USER_ID: "local-admin",
    CLASSROOM_LOCAL_USER_NAME: "Local Administrator",
    CLASSROOM_LOCAL_USER_EMAIL: "wy.lee@ntub.edu.tw",
  }), {
    externalId: "local-admin",
    email: "wy.lee@ntub.edu.tw",
    displayName: "Local Administrator",
    source: "local_environment",
    isLocal: true,
  });
});

test("hosted identity comes only from platform headers", () => {
  const request = new Request("https://classroom.example.test/api/classroom/courses", { headers: {
    "oai-authenticated-user-id": "site-user-1",
    "oai-authenticated-user-email": "student@ntub.edu.tw",
    "oai-authenticated-user-full-name": "Test%20Student",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  } });
  assert.deepEqual(resolveClassroomIdentity(request, { CLASSROOM_ENVIRONMENT: "production" }), {
    externalId: "site-user-1",
    email: "student@ntub.edu.tw",
    displayName: "Test Student",
    source: "forwarded_identity",
    isLocal: false,
  });
});

test("state-changing classroom requests must be same-origin", () => {
  assert.equal(requestIsSameOrigin(new Request("https://classroom.example.test/api/classroom/courses")), true);
  assert.equal(requestIsSameOrigin(new Request("https://classroom.example.test/api/classroom/courses", {
    method: "POST",
    headers: { origin: "https://classroom.example.test" },
  })), true);
  assert.equal(requestIsSameOrigin(new Request("https://classroom.example.test/api/classroom/courses", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  })), false);
});
