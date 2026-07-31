import assert from "node:assert/strict";
import test from "node:test";

import {
  actorHasPermission,
  provisioningRoleForIdentity,
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

test("verified identity alone does not authorize account provisioning", () => {
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
  assert.equal(provisioningRoleForIdentity({
    externalId: "local-operator",
    email: "local@example.com",
    displayName: "Local Operator",
    source: "local_environment",
    localRole: "commander",
    isLocal: true,
  }, null), "commander");
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
  assert.equal(actorHasPermission({ role: "auditor" }, "audit:read"), true);
});

test("only verified-member mutation failures are eligible for payload-free security audit", () => {
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
