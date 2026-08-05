import assert from "node:assert/strict";
import test from "node:test";
import {
  GUIDED_TOUR_SCENARIOS,
  UPDATE_REGRESSION_OBSERVABILITY,
  UPDATE_REGRESSION_SCENARIO,
} from "../lib/operations-guided-tour.ts";

test("each guided tour stays focused and has stable navigation targets", () => {
  assert.equal(GUIDED_TOUR_SCENARIOS.length, 1);
  assert.equal(UPDATE_REGRESSION_SCENARIO.steps.length, 5);
  assert.equal(UPDATE_REGRESSION_SCENARIO.steps[0]?.view, "overview");
  assert.ok(UPDATE_REGRESSION_SCENARIO.steps.slice(1).every((step) => step.view === "observability"));

  const ids = UPDATE_REGRESSION_SCENARIO.steps.map((step) => step.id);
  const targets = UPDATE_REGRESSION_SCENARIO.steps.map((step) => step.target);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(targets).size, targets.length);
  assert.ok(targets.every((target) => target.startsWith("[data-tour='")));
});

test("tour telemetry totals agree across summaries, charts and route analysis", () => {
  const data = UPDATE_REGRESSION_OBSERVABILITY;
  const seriesTotal = data.timeSeries.reduce((sum, point) => sum + point.requests, 0);
  const seriesClientErrors = data.timeSeries.reduce((sum, point) => sum + point.clientErrors, 0);
  const seriesServerErrors = data.timeSeries.reduce((sum, point) => sum + point.serverErrors, 0);
  const routeTotal = data.routes.reduce((sum, route) => sum + route.requests, 0);
  const statusTotal = data.statusClasses.reduce((sum, status) => sum + status.count, 0);

  assert.equal(seriesTotal, data.summary.totalRequests);
  assert.equal(seriesClientErrors, data.summary.clientErrors);
  assert.equal(seriesServerErrors, data.summary.serverErrors);
  assert.equal(routeTotal, data.summary.totalRequests);
  assert.equal(statusTotal, data.summary.totalRequests);
  assert.equal(data.coverage.simulatedEvents, data.summary.totalRequests);
  assert.equal(data.coverage.runtimeEvents, 0);
  assert.equal(data.coverage.hasSimulatedData, true);
});

test("tour conclusion uses more than timing alone", () => {
  const conclusion = UPDATE_REGRESSION_SCENARIO.response.conclusion;
  assert.match(conclusion, /更新/);
  assert.match(conclusion, /API/);
  assert.match(conclusion, /版本/);
  assert.match(conclusion, /回復版本後/);
});
