import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedIncidentTransitions,
  canApproveIncidentCommunication,
  canDraftIncidentCommunication,
  canReadIncident,
  canTransitionIncident,
  canonicalJson,
  cleanOperationsText,
  incidentTimestampUpdates,
  incidentStatusMatchesFilter,
  isCommunicationAudience,
  isCommunicationStatus,
  isDurableHttpsUrl,
  isFinalIncidentCommunication,
  normalizeEmail,
  normalizeOperationsId,
  normalizeSlug,
  organizationRoleCanReadAllIncidents,
  organizationRoleCanHoldIncidentRole,
  operationsRouteTemplate,
  permissionsForRole,
  roleHasPermission,
  serviceCanAcceptNewIncidents,
  taskStatusHasRequiredEvidence,
} from "../lib/operations-domain.ts";

test("incident transitions require both an organization role and an incident assignment", () => {
  assert.deepEqual(allowedIncidentTransitions("declared"), ["investigating", "cancelled"]);
  assert.equal(canTransitionIncident("commander", ["incident_commander"], "monitoring", "resolved"), true);
  assert.equal(canTransitionIncident("commander", [], "monitoring", "resolved"), false);
  assert.equal(canTransitionIncident("responder", ["responder"], "investigating", "mitigating"), true);
  assert.equal(canTransitionIncident("responder", ["responder"], "monitoring", "resolved"), false);
  assert.equal(canTransitionIncident("auditor", ["incident_commander"], "declared", "investigating"), false);
  assert.equal(canTransitionIncident("admin", [], "closed", "investigating"), true);
  assert.equal(canTransitionIncident("admin", [], "closed", "resolved"), false);
});

test("read and organization permissions preserve least privilege", () => {
  assert.equal(canReadIncident("auditor", []), true);
  assert.equal(canReadIncident("observer", []), true);
  assert.equal(canReadIncident("observer", ["observer"]), true);
  assert.equal(canReadIncident("responder", []), false);
  assert.equal(organizationRoleCanReadAllIncidents("observer"), true);
  assert.equal(organizationRoleCanReadAllIncidents("auditor"), true);
  assert.equal(organizationRoleCanReadAllIncidents("responder"), false);
  assert.equal(roleHasPermission("admin", "access:manage"), true);
  assert.equal(roleHasPermission("auditor", "audit:read"), true);
  assert.equal(roleHasPermission("responder", "audit:read"), false);
  assert.equal(roleHasPermission("observer", "incident:respond"), false);
  assert.deepEqual(permissionsForRole("observer"), ["access:read", "service:read", "incident:read", "audit:read", "observability:read"]);
  assert.deepEqual(permissionsForRole("auditor"), ["access:read", "service:read", "incident:read", "audit:read", "observability:read"]);
  for (const role of ["admin", "commander", "responder", "observer", "auditor"] as const) {
    assert.equal(roleHasPermission(role, "observability:read"), true);
  }
});

test("incident filters and service lifecycle agree with new-incident eligibility", () => {
  assert.equal(incidentStatusMatchesFilter("investigating", "open"), true);
  assert.equal(incidentStatusMatchesFilter("resolved", "open"), true);
  assert.equal(incidentStatusMatchesFilter("closed", "open"), false);
  assert.equal(incidentStatusMatchesFilter("cancelled", "open"), false);
  assert.equal(incidentStatusMatchesFilter("closed", "closed"), true);
  assert.equal(incidentStatusMatchesFilter("investigating", "all"), true);
  assert.equal(serviceCanAcceptNewIncidents("active"), true);
  assert.equal(serviceCanAcceptNewIncidents("deprecated"), false);
});

test("incident communication duties separate drafting from approval", () => {
  assert.equal(canDraftIncidentCommunication("admin", []), true);
  assert.equal(canApproveIncidentCommunication("admin", []), true);

  assert.equal(canDraftIncidentCommunication("commander", []), false);
  assert.equal(canApproveIncidentCommunication("commander", []), false);
  assert.equal(canDraftIncidentCommunication("commander", ["incident_commander"]), true);
  assert.equal(canApproveIncidentCommunication("commander", ["incident_commander"]), true);
  assert.equal(canDraftIncidentCommunication("commander", ["communications_lead"]), true);
  assert.equal(canApproveIncidentCommunication("commander", ["communications_lead"]), true);

  assert.equal(canDraftIncidentCommunication("responder", ["responder"]), true);
  assert.equal(canApproveIncidentCommunication("responder", ["responder"]), false);
  assert.equal(canDraftIncidentCommunication("responder", ["service_owner"]), true);
  assert.equal(canApproveIncidentCommunication("responder", ["service_owner"]), false);
  assert.equal(canDraftIncidentCommunication("responder", ["communications_lead"]), true);
  assert.equal(canApproveIncidentCommunication("responder", ["communications_lead"]), true);

  assert.equal(canDraftIncidentCommunication("observer", ["communications_lead"]), false);
  assert.equal(canApproveIncidentCommunication("observer", ["communications_lead"]), false);
  assert.equal(canDraftIncidentCommunication("observer", ["observer"]), false);
  assert.equal(canDraftIncidentCommunication("auditor", ["communications_lead"]), false);
  assert.equal(canApproveIncidentCommunication("auditor", ["communications_lead"]), false);
  assert.equal(isCommunicationAudience("stakeholder"), true);
  assert.equal(isCommunicationAudience("customer"), false);
  assert.equal(isCommunicationStatus("reviewed"), true);
  assert.equal(isCommunicationStatus("approved"), false);
  assert.equal(isFinalIncidentCommunication("[FINAL] Service is fully restored."), true);
  assert.equal(isFinalIncidentCommunication("[fInAl] Service is fully restored."), true);
  assert.equal(isFinalIncidentCommunication("[FINAL]Service is fully restored."), false);
  assert.equal(isFinalIncidentCommunication("[FINAL]\u00a0Service is fully restored."), false);
  assert.equal(isFinalIncidentCommunication(" [FINAL] Service is fully restored."), false);
  assert.equal(isFinalIncidentCommunication("Service is final."), false);
});

test("organization roles can hold only compatible incident responsibilities", () => {
  const expected = {
    admin: ["incident_commander", "responder", "communications_lead", "service_owner", "observer"],
    commander: ["incident_commander", "communications_lead", "observer"],
    responder: ["responder", "communications_lead", "service_owner", "observer"],
    observer: ["observer"],
    auditor: ["observer"],
  } as const;
  const incidentRoles = ["incident_commander", "responder", "communications_lead", "service_owner", "observer"] as const;

  for (const [organizationRole, allowedRoles] of Object.entries(expected)) {
    for (const incidentRole of incidentRoles) {
      assert.equal(
        organizationRoleCanHoldIncidentRole(
          organizationRole as keyof typeof expected,
          incidentRole,
        ),
        allowedRoles.includes(incidentRole as never),
        `${organizationRole} x ${incidentRole}`,
      );
    }
  }
});

test("identifiers and text use deterministic boundaries", () => {
  assert.equal(normalizeEmail(" Operator@Example.COM "), "operator@example.com");
  assert.equal(normalizeEmail("not-an-email"), "");
  assert.equal(normalizeOperationsId("inc_ABC-123"), "inc_ABC-123");
  assert.equal(normalizeOperationsId("x"), "");
  assert.equal(normalizeSlug("  Core Login API  "), "core-login-api");
  assert.equal(cleanOperationsText("  first\r\nsecond\u0000 ", 40), "first\nsecond");
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(canonicalJson({ a: undefined }), '{"a":null}');
});

test("completed tasks require an HTTPS evidence reference", () => {
  assert.equal(taskStatusHasRequiredEvidence("open", null), true);
  assert.equal(taskStatusHasRequiredEvidence("cancelled", null), true);
  assert.equal(taskStatusHasRequiredEvidence("completed", null), false);
  assert.equal(taskStatusHasRequiredEvidence("completed", "http://evidence.example.com/task/1"), false);
  assert.equal(taskStatusHasRequiredEvidence("completed", "https://"), false);
  assert.equal(taskStatusHasRequiredEvidence("completed", "https://evidence.example.com/task/1"), true);
  assert.equal(isDurableHttpsUrl("https://example.com"), true);
  assert.equal(isDurableHttpsUrl("HTTPS://EXAMPLE.COM/path?check=1#result"), true);
  assert.equal(isDurableHttpsUrl("https://@"), false);
  assert.equal(isDurableHttpsUrl("https://:"), false);
  assert.equal(isDurableHttpsUrl("https://["), false);
  assert.equal(isDurableHttpsUrl("https://%"), false);
  assert.equal(isDurableHttpsUrl("https://user:secret@example.com/evidence"), false);
  assert.equal(isDurableHttpsUrl("https://example.com:8443/evidence"), false);
});

test("milestone timestamps are explicit and status-specific", () => {
  const now = "2026-07-31T10:00:00.000Z";
  assert.deepEqual(incidentTimestampUpdates("investigating", now), { acknowledgedAt: now });
  assert.deepEqual(incidentTimestampUpdates("monitoring", now), { mitigatedAt: now });
  assert.deepEqual(incidentTimestampUpdates("resolved", now), { resolvedAt: now });
  assert.deepEqual(incidentTimestampUpdates("closed", now), { closedAt: now });
  assert.deepEqual(incidentTimestampUpdates("cancelled", now), {});
});

test("request telemetry uses bounded route templates instead of record identifiers", () => {
  assert.equal(
    operationsRouteTemplate(["session", "role"]),
    "/api/v1/session/role",
  );
  assert.equal(
    operationsRouteTemplate(["incidents", "inc-sensitive-123", "assignments", "assign-sensitive-456"]),
    "/api/v1/incidents/:incidentId/assignments/:assignmentId",
  );
  assert.equal(operationsRouteTemplate(["observability"]), "/api/v1/observability");
  assert.equal(
    operationsRouteTemplate(["incidents", "inc-sensitive-123", "tasks", "task-sensitive-456"]),
    "/api/v1/incidents/:incidentId/tasks/:taskId",
  );
  assert.equal(
    operationsRouteTemplate(["incidents", "inc-sensitive-123", "communications", "comm-sensitive-456"]),
    "/api/v1/incidents/:incidentId/communications/:communicationId",
  );
  assert.equal(
    operationsRouteTemplate(["services", "svc-sensitive-123", "lifecycle-events"]),
    "/api/v1/services/:serviceId/lifecycle-events",
  );
  assert.equal(operationsRouteTemplate(["untrusted-value", "secret"]), "/api/v1/:route");
});
