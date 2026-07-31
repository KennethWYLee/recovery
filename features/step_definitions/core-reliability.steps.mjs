import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  canTransitionIncident,
  incidentStatusMatchesFilter,
  isFinalIncidentCommunication,
  organizationRoleCanHoldIncidentRole,
  serviceCanAcceptNewIncidents,
  taskStatusHasRequiredEvidence,
} from "../../lib/operations-domain.ts";

Given("the organization role is {string}", function (role) {
  this.organizationRole = role;
});

Given("the active incident assignment is {string}", function (role) {
  this.incidentRoles = [role];
});

Given("the incident status is {string}", function (status) {
  this.incidentStatus = status;
});

When("the actor attempts to transition the incident to {string}", function (status) {
  this.transitionAllowed = canTransitionIncident(
    this.organizationRole,
    this.incidentRoles ?? [],
    this.incidentStatus,
    status,
  );
});

Then("the incident transition is rejected", function () {
  assert.equal(this.transitionAllowed, false);
});

Then("the incident transition is allowed", function () {
  assert.equal(this.transitionAllowed, true);
});

When("the actor is considered for the incident assignment {string}", function (incidentRole) {
  this.assignmentAllowed = organizationRoleCanHoldIncidentRole(this.organizationRole, incidentRole);
});

Then("the incident assignment is rejected", function () {
  assert.equal(this.assignmentAllowed, false);
});

Given("a completed task cites {string}", function (evidenceRef) {
  this.taskStatus = "completed";
  this.evidenceRef = evidenceRef;
});

When("the task evidence is validated", function () {
  this.taskEvidenceAccepted = taskStatusHasRequiredEvidence(this.taskStatus, this.evidenceRef);
});

Then("the task evidence is rejected", function () {
  assert.equal(this.taskEvidenceAccepted, false);
});

Then("the task evidence is accepted", function () {
  assert.equal(this.taskEvidenceAccepted, true);
});

Given("the service lifecycle status is {string}", function (status) {
  this.serviceStatus = status;
});

When("new incident eligibility is evaluated", function () {
  this.serviceEligible = serviceCanAcceptNewIncidents(this.serviceStatus);
});

Then("the service is not eligible for a new incident", function () {
  assert.equal(this.serviceEligible, false);
});

Given("the incident list contains {string}", function (statuses) {
  this.incidentStatuses = statuses.split(",");
});

When("the incident list is filtered by {string}", function (filter) {
  this.filteredIncidentStatuses = this.incidentStatuses.filter((status) => (
    incidentStatusMatchesFilter(status, filter)
  ));
});

Then("the filtered incident list is {string}", function (statuses) {
  assert.deepEqual(this.filteredIncidentStatuses, statuses.split(","));
});

Given("the incident communication is {string}", function (message) {
  this.communicationMessage = message;
});

When("final communication status is evaluated", function () {
  this.communicationIsFinal = isFinalIncidentCommunication(this.communicationMessage);
});

Then("the communication is treated as final", function () {
  assert.equal(this.communicationIsFinal, true);
});
