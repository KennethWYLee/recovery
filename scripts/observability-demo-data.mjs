const ROUTES = [
  "/api/v1/overview",
  "/api/v1/incidents",
  "/api/v1/incidents/:incidentId",
  "/api/v1/incidents/:incidentId/tasks",
  "/api/v1/services",
  "/api/v1/audit-events",
  "/api/v1/observability",
];

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function scenarioFor(index, random) {
  const hour = index % 24;
  const day = Math.floor(index / 24);
  const isPeak = hour >= 8 && hour <= 18;
  const isDatabaseIncident = day === 24 && hour >= 9 && hour <= 12;
  const isReleaseRegression = day === 27 && hour >= 14 && hour <= 16;
  const draw = random();
  if (isDatabaseIncident && draw < 0.32) return { status: 503, code: "OPERATIONS_DATABASE_UNAVAILABLE", latency: 1300 + Math.floor(random() * 2100), version: "2.2.0-demo.2" };
  if (isReleaseRegression && draw < 0.24) return { status: 500, code: "INTERNAL_ERROR", latency: 700 + Math.floor(random() * 1300), version: "2.2.0-demo.3" };
  if (draw < 0.035) return { status: 403, code: "INSUFFICIENT_PERMISSION", latency: 35 + Math.floor(random() * 90), version: "2.2.0-demo.4" };
  if (draw < 0.057) return { status: 409, code: "VERSION_CONFLICT", latency: 70 + Math.floor(random() * 140), version: "2.2.0-demo.4" };
  if (draw < 0.066) return { status: 422, code: "VALIDATION_FAILED", latency: 45 + Math.floor(random() * 110), version: "2.2.0-demo.4" };
  if (draw < 0.073) return { status: 500, code: "INTERNAL_ERROR", latency: 420 + Math.floor(random() * 850), version: "2.2.0-demo.4" };
  return { status: 200, code: null, latency: (isPeak ? 65 : 38) + Math.floor(random() * (isPeak ? 190 : 95)), version: "2.2.0-demo.4" };
}

export function generateObservabilityDemoRows({
  seed = 20260805,
  hours = 30 * 24,
  anchor = "2026-08-05T12:00:00.000Z",
} = {}) {
  if (!Number.isInteger(hours) || hours < 24 || hours > 31 * 24) throw new Error("hours must be an integer between 24 and 744");
  const end = new Date(anchor);
  if (!Number.isFinite(end.getTime())) throw new Error("anchor must be an ISO date");
  end.setUTCMinutes(0, 0, 0);
  const random = lcg(seed);
  const rows = [];
  for (let index = 0; index < hours; index += 1) {
    const occurredAt = new Date(end.getTime() - (hours - 1 - index) * 3_600_000);
    const hour = occurredAt.getUTCHours();
    const eventsThisHour = (hour >= 8 && hour <= 18 ? 5 : 2) + Math.floor(random() * 4);
    for (let event = 0; event < eventsThisHour; event += 1) {
      const scenario = scenarioFor(index, random);
      const route = ROUTES[Math.floor(random() * ROUTES.length)];
      const timestamp = new Date(occurredAt.getTime() + Math.floor(random() * 3_599_000)).toISOString();
      const serial = String(rows.length + 1).padStart(6, "0");
      rows.push({
        id: `telemetry-demo-${serial}`,
        organizationId: "ops-singleton",
        requestId: `req-demo-${serial}`,
        route,
        method: route.includes(":incidentId/tasks") && random() < 0.32 ? "POST" : "GET",
        status: scenario.status,
        problemCode: scenario.code,
        latencyMs: scenario.latency,
        apiVersion: "2.2.0",
        schemaVersion: "0005",
        deploymentVersion: scenario.version,
        environment: "development",
        source: "simulated",
        occurredAt: timestamp,
      });
    }
  }
  return rows;
}

function sqlValue(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function observabilityDemoSql(rows) {
  const statements = ["DELETE FROM ops_request_telemetry WHERE source = 'simulated';"];
  for (const row of rows) {
    statements.push(`INSERT INTO ops_request_telemetry (id, organization_id, request_id, route_template, method, status_code, problem_code, latency_ms, api_version, schema_version, deployment_version, environment, source, occurred_at) VALUES (${[
      row.id, row.organizationId, row.requestId, row.route, row.method, row.status, row.problemCode,
      row.latencyMs, row.apiVersion, row.schemaVersion, row.deploymentVersion, row.environment, row.source, row.occurredAt,
    ].map(sqlValue).join(", ")});`);
  }
  return `${statements.join("\n")}\n`;
}
