import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHOOL_SELECTABLE_ORGANIZATION_ROLES,
  actorHasPermission,
  isNtubEmail,
  isSchoolSelectableOrganizationRole,
  organizationRoleCanUseRequestMethod,
  provisioningRoleForIdentity,
  randomReadOnlyOrganizationRole,
  randomSchoolViewerDisplayName,
  rejectedMutationAudit,
  requestIsSameOrigin,
  resolveExternalOperationsIdentity,
} from "../lib/operations-auth.ts";

test("localhost identity is accepted only from explicit environment configuration", () => {
  const request = new Request("http://localhost:3001/api/v1/access");
  assert.equal(resolveExternalOperationsIdentity(request, { CONTINUITY_OPS_ENVIRONMENT: "development" }), null);
  const identity = resolveExternalOperationsIdentity(request, {
    CONTINUITY_OPS_ENVIRONMENT: "development",
    CONTINUITY_OPS_LOCAL_OPERATOR_ID: "local-operator-1",
    CONTINUITY_OPS_LOCAL_OPERATOR_NAME: "Local Operator",
    CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL: "operator@example.com",
    CONTINUITY_OPS_LOCAL_OPERATOR_ROLE: "admin",
  });
  assert.deepEqual(identity, {
    externalId: "local-operator-1",
    email: "operator@example.com",
    displayName: "Local Operator",
    source: "local_environment",
    localRole: "admin",
    isLocal: true,
  });
  const nonLocal = new Request("https://ops.example.com/api/v1/access");
  assert.equal(resolveExternalOperationsIdentity(nonLocal, {
    CONTINUITY_OPS_ENVIRONMENT: "development",
    CONTINUITY_OPS_LOCAL_OPERATOR_ID: "local-operator-1",
    CONTINUITY_OPS_LOCAL_OPERATOR_NAME: "Local Operator",
    CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL: "operator@example.com",
    CONTINUITY_OPS_LOCAL_OPERATOR_ROLE: "admin",
  }), null);
});

test("production accepts only a forwarded verified email identity", () => {
  const request = new Request("https://ops.example.com/api/v1/access", {
    headers: {
      "oai-authenticated-user-email": "operator@example.com",
      "oai-authenticated-user-full-name": "Lin%20Operator",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  });
  assert.deepEqual(resolveExternalOperationsIdentity(request, { CONTINUITY_OPS_ENVIRONMENT: "production" }), {
    externalId: "operator@example.com",
    email: "operator@example.com",
    displayName: "Lin Operator",
    source: "forwarded_identity",
    isLocal: false,
  });
  assert.equal(resolveExternalOperationsIdentity(
    new Request("https://ops.example.com/api/v1/access"),
    { CONTINUITY_OPS_ENVIRONMENT: "production" },
  ), null);
});

test("only the bootstrap identity or exact NTUB domain can be provisioned", () => {
  const stranger = {
    externalId: "stranger@example.com",
    email: "stranger@example.com",
    displayName: "Stranger",
    source: "forwarded_identity",
    isLocal: false,
  } as const;
  assert.equal(provisioningRoleForIdentity(stranger, "bootstrap@example.com"), null);
  assert.equal(provisioningRoleForIdentity(
    { ...stranger, externalId: "bootstrap@example.com", email: "bootstrap@example.com" },
    "bootstrap@example.com",
  ), "admin");
  assert.equal(provisioningRoleForIdentity(
    { ...stranger, externalId: "student@ntub.edu.tw", email: "student@ntub.edu.tw" },
    "student@ntub.edu.tw",
    () => "observer",
  ), "admin");
  assert.equal(provisioningRoleForIdentity(
    { ...stranger, externalId: "student@ntub.edu.tw", email: "student@ntub.edu.tw" },
    "bootstrap@example.com",
    () => "observer",
  ), "observer");
  assert.equal(provisioningRoleForIdentity(
    { ...stranger, externalId: "student@ntub.edu.tw", email: "student@ntub.edu.tw" },
    null,
    () => "auditor",
  ), "auditor");
  assert.ok(["observer", "auditor"].includes(provisioningRoleForIdentity(
    { ...stranger, externalId: "random@ntub.edu.tw", email: "random@ntub.edu.tw" },
    null,
  ) ?? ""));
  assert.equal(provisioningRoleForIdentity({
    externalId: "local-operator",
    email: "local@example.com",
    displayName: "Local Operator",
    source: "local_environment",
    localRole: "commander",
    isLocal: true,
  }, null), "commander");
});

test("school email matching is exact and read-only identity selection is bounded", () => {
  assert.equal(isNtubEmail(" Student@NTUB.EDU.TW "), true);
  assert.equal(isNtubEmail("student@dept.ntub.edu.tw"), false);
  assert.equal(isNtubEmail("student@ntub.edu.tw.example.com"), false);
  assert.equal(isNtubEmail("student@ntub"), false);
  assert.equal(isNtubEmail(null), false);

  assert.equal(randomReadOnlyOrganizationRole(0), "observer");
  assert.equal(randomReadOnlyOrganizationRole(1), "auditor");
  assert.equal(randomReadOnlyOrganizationRole(2), "observer");
  assert.ok(["observer", "auditor"].includes(randomReadOnlyOrganizationRole()));
  assert.equal(randomSchoolViewerDisplayName("12345678-aaaa-bbbb-cccc-123456789abc"), "校內訪客 1234-5678");
  assert.match(randomSchoolViewerDisplayName(), /^校內訪客 [A-Z0-9]{4}-[A-Z0-9]{4}$/u);
});

test("school users can select every non-admin organization role but never admin", () => {
  assert.deepEqual(
    [...SCHOOL_SELECTABLE_ORGANIZATION_ROLES],
    ["commander", "responder", "observer", "auditor"],
  );
  for (const role of SCHOOL_SELECTABLE_ORGANIZATION_ROLES) {
    assert.equal(isSchoolSelectableOrganizationRole(role), true, role);
  }
  assert.equal(isSchoolSelectableOrganizationRole("admin"), false);
  assert.equal(isSchoolSelectableOrganizationRole("owner"), false);
  assert.equal(isSchoolSelectableOrganizationRole(null), false);
});

test("state-changing browser requests must be same-origin", () => {
  assert.equal(requestIsSameOrigin(new Request("https://ops.example.com/api/v1/incidents")), true);
  assert.equal(requestIsSameOrigin(new Request("https://ops.example.com/api/v1/incidents", {
    method: "POST", headers: { origin: "https://ops.example.com" },
  })), true);
  assert.equal(requestIsSameOrigin(new Request("https://ops.example.com/api/v1/incidents", {
    method: "POST", headers: { origin: "https://evil.example" },
  })), false);
  assert.equal(requestIsSameOrigin(new Request("https://ops.example.com/api/v1/incidents", { method: "POST" })), false);
});

test("organization roles expose an explicit permission matrix", () => {
  assert.equal(actorHasPermission({ role: "admin" }, "access:manage"), true);
  assert.equal(actorHasPermission({ role: "commander" }, "incident:command"), true);
  assert.equal(actorHasPermission({ role: "commander" }, "incident:assign"), true);
  assert.equal(actorHasPermission({ role: "commander" }, "access:manage"), false);
  assert.equal(actorHasPermission({ role: "responder" }, "incident:respond"), true);
  assert.equal(actorHasPermission({ role: "observer" }, "incident:respond"), false);
  assert.equal(actorHasPermission({ role: "observer" }, "audit:read"), true);
  assert.equal(actorHasPermission({ role: "observer" }, "access:read"), true);
  assert.equal(actorHasPermission({ role: "auditor" }, "audit:read"), true);
  assert.equal(actorHasPermission({ role: "auditor" }, "access:read"), true);
});

test("read-only organization roles cannot use any state-changing method", () => {
  for (const role of ["observer", "auditor"] as const) {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.equal(organizationRoleCanUseRequestMethod(role, method), true, `${role} ${method}`);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      assert.equal(organizationRoleCanUseRequestMethod(role, method), false, `${role} ${method}`);
    }
  }
  for (const role of ["admin", "commander", "responder"] as const) {
    assert.equal(organizationRoleCanUseRequestMethod(role, "POST"), true, role);
  }
});

test("only verified-member mutation failures are eligible for payload-free security audit", () => {
  assert.deepEqual(
    rejectedMutationAudit("POST", ["session", "role"], "ADMIN_ROLE_MANAGED"),
    {
      outcome: "denied",
      action: "access.self_role.select",
      resourceType: "membership",
      resourceId: "self",
      route: "/api/v1/session/role",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit("POST", ["session", "role"], "INVALID_ROLE_SELECTION"),
    {
      outcome: "failure",
      action: "access.self_role.select",
      resourceType: "membership",
      resourceId: "self",
      route: "/api/v1/session/role",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit("POST", ["services"], "READ_ONLY_ACCESS"),
    {
      outcome: "denied",
      action: "service.create",
      resourceType: "service",
      resourceId: "pending",
      route: "/api/v1/services",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit("POST", ["incidents", "inc-123", "transitions"], "TRANSITION_NOT_ALLOWED"),
    {
      outcome: "denied",
      action: "incident.transition",
      resourceType: "incident",
      resourceId: "inc-123",
      route: "/api/v1/incidents/:incidentId/transitions",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit("PATCH", ["incidents", "inc-123", "tasks", "task-456"], "VERSION_CONFLICT"),
    {
      outcome: "failure",
      action: "incident.task.update",
      resourceType: "task",
      resourceId: "task-456",
      route: "/api/v1/incidents/:incidentId/tasks/:taskId",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit("PATCH", ["incidents", "inc-123", "tasks", "task-456"], "TASK_EVIDENCE_REQUIRED"),
    {
      outcome: "failure",
      action: "incident.task.update",
      resourceType: "task",
      resourceId: "task-456",
      route: "/api/v1/incidents/:incidentId/tasks/:taskId",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit(
      "DELETE",
      ["incidents", "inc-123", "assignments", "assign-789"],
      "INCIDENT_COMMANDER_REQUIRED",
    ),
    {
      outcome: "failure",
      action: "incident.assignment.revoke",
      resourceType: "incident_assignment",
      resourceId: "assign-789",
      route: "/api/v1/incidents/:incidentId/assignments/:assignmentId",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit(
      "PATCH",
      ["incidents", "inc-123", "communications", "comm-456"],
      "COMMUNICATION_STATUS_CONFLICT",
    ),
    {
      outcome: "failure",
      action: "incident.communication.update",
      resourceType: "incident_communication",
      resourceId: "comm-456",
      route: "/api/v1/incidents/:incidentId/communications/:communicationId",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit(
      "POST",
      ["incidents", "inc-123", "communications"],
      "INCIDENT_COMMUNICATION_ACCESS_DENIED",
    ),
    {
      outcome: "denied",
      action: "incident.communication.create",
      resourceType: "incident_communication",
      resourceId: "pending",
      route: "/api/v1/incidents/:incidentId/communications",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit(
      "POST",
      ["incidents", "inc-123", "assignments"],
      "INCIDENT_ROLE_INCOMPATIBLE",
    ),
    {
      outcome: "denied",
      action: "incident.assignment.create",
      resourceType: "incident",
      resourceId: "inc-123",
      route: "/api/v1/incidents/:incidentId/assignments",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit(
      "PATCH",
      ["services", "svc-123"],
      "SERVICE_STATUS_CHANGE_CONFIRMATION_REQUIRED",
    ),
    {
      outcome: "failure",
      action: "service.update",
      resourceType: "service",
      resourceId: "svc-123",
      route: "/api/v1/services/:serviceId",
    },
  );
  assert.deepEqual(
    rejectedMutationAudit(
      "PATCH",
      ["services", "svc-123"],
      "SERVICE_STATUS_CHANGE_ACTOR_INVALID",
    ),
    {
      outcome: "denied",
      action: "service.update",
      resourceType: "service",
      resourceId: "svc-123",
      route: "/api/v1/services/:serviceId",
    },
  );
  assert.equal(rejectedMutationAudit("GET", ["incidents", "inc-123"], "PERMISSION_DENIED"), null);
  assert.equal(rejectedMutationAudit("POST", ["incidents"], "AUTHENTICATION_REQUIRED"), null);
  assert.equal(rejectedMutationAudit("POST", ["incidents"], "CROSS_ORIGIN_REQUEST_REJECTED"), null);
  assert.equal(rejectedMutationAudit("POST", ["incidents"], "INVALID_JSON"), null);
});
