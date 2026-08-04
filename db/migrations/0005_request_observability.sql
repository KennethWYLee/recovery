CREATE TABLE ops_request_telemetry (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  route_template TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  problem_code TEXT,
  latency_ms INTEGER NOT NULL CHECK (latency_ms BETWEEN 0 AND 3600000),
  api_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  deployment_version TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'staging', 'production', 'unknown')),
  source TEXT NOT NULL CHECK (source IN ('runtime', 'simulated')),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  CHECK (length(request_id) BETWEEN 8 AND 128),
  CHECK (route_template LIKE '/api/v1/%' AND length(route_template) BETWEEN 9 AND 160),
  CHECK (problem_code IS NULL OR length(problem_code) BETWEEN 2 AND 80),
  CHECK (length(api_version) BETWEEN 1 AND 32),
  CHECK (length(schema_version) BETWEEN 1 AND 32),
  CHECK (length(deployment_version) BETWEEN 1 AND 80),
  CHECK (length(occurred_at) BETWEEN 20 AND 35)
);
--> statement-breakpoint
CREATE INDEX ops_request_telemetry_time_idx
ON ops_request_telemetry (organization_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX ops_request_telemetry_status_time_idx
ON ops_request_telemetry (organization_id, status_code, occurred_at DESC);
