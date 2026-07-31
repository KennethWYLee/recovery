-- Record and enforce the reason, actor, and time for every future service
-- lifecycle transition. Existing deprecated rows remain explicitly legacy:
-- their missing historical reason is not reconstructed or fabricated.

ALTER TABLE ops_services ADD COLUMN status_change_reason TEXT;
--> statement-breakpoint
ALTER TABLE ops_services ADD COLUMN status_changed_at TEXT;
--> statement-breakpoint
ALTER TABLE ops_services ADD COLUMN status_changed_by_user_id TEXT REFERENCES ops_users(id);
--> statement-breakpoint
ALTER TABLE ops_services ADD COLUMN status_change_request_id TEXT;
--> statement-breakpoint

CREATE TABLE ops_service_lifecycle_events (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
  service_id TEXT NOT NULL,
  from_status TEXT NOT NULL CHECK (from_status IN ('active', 'deprecated')),
  to_status TEXT NOT NULL CHECK (to_status IN ('active', 'deprecated')),
  reason TEXT NOT NULL CHECK (
    length(trim(replace(replace(replace(replace(replace(replace(
      reason, char(10), ' '), char(13), ' '), char(9), ' '), char(11), ' '), char(12), ' '), char(160), ' '))) BETWEEN 8 AND 1000
  ),
  changed_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
  request_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  UNIQUE (service_id, request_id),
  FOREIGN KEY (service_id, organization_id)
    REFERENCES ops_services(id, organization_id) ON DELETE RESTRICT,
  CHECK (from_status <> to_status)
);
--> statement-breakpoint

CREATE INDEX ops_service_lifecycle_events_service_time_idx
  ON ops_service_lifecycle_events (organization_id, service_id, changed_at DESC);
--> statement-breakpoint

-- Lifecycle evidence is derived exclusively from the corresponding service
-- transition below. A direct INSERT cannot invent or alter history: every
-- field must match the service's newly committed state and deterministic ID.
CREATE TRIGGER ops_service_lifecycle_events_insert_guard
BEFORE INSERT ON ops_service_lifecycle_events
WHEN NOT EXISTS (
  SELECT 1
  FROM ops_services s
  WHERE s.id = NEW.service_id
    AND s.organization_id = NEW.organization_id
    AND NEW.id = s.id || ':lifecycle:' || printf('%020d', s.version)
    AND NEW.to_status = s.status
    AND NEW.from_status = CASE s.status
      WHEN 'active' THEN 'deprecated'
      ELSE 'active'
    END
    AND NEW.reason IS s.status_change_reason
    AND NEW.changed_by_user_id IS s.status_changed_by_user_id
    AND NEW.request_id IS s.status_change_request_id
    AND NEW.changed_at IS s.status_changed_at
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_SERVICE_LIFECYCLE_EVENT_NOT_DERIVED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_service_lifecycle_events_immutable_update
BEFORE UPDATE ON ops_service_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'OPS_SERVICE_LIFECYCLE_EVENT_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_service_lifecycle_events_immutable_delete
BEFORE DELETE ON ops_service_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'OPS_SERVICE_LIFECYCLE_EVENT_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_service_initial_lifecycle_guard
BEFORE INSERT ON ops_services
WHEN NEW.status <> 'active'
  OR NEW.status_change_reason IS NOT NULL
  OR NEW.status_changed_at IS NOT NULL
  OR NEW.status_changed_by_user_id IS NOT NULL
  OR NEW.status_change_request_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'OPS_SERVICE_MUST_START_ACTIVE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_service_status_change_evidence_guard
BEFORE UPDATE OF status ON ops_services
WHEN NEW.status <> OLD.status
BEGIN
  SELECT CASE
    WHEN NEW.status_change_reason IS NULL
      OR typeof(NEW.status_change_reason) <> 'text'
      OR length(trim(replace(replace(replace(replace(replace(replace(
        NEW.status_change_reason, char(10), ' '), char(13), ' '), char(9), ' '), char(11), ' '), char(12), ' '), char(160), ' '))) < 8
      OR length(NEW.status_change_reason) > 1000
      OR NEW.status_changed_at IS NULL
      OR NEW.status_changed_at NOT GLOB '????-??-??T??:??:??.???Z'
      OR julianday(NEW.status_changed_at) IS NULL
      OR NEW.status_changed_at <> NEW.updated_at
      OR NEW.status_change_request_id IS NULL
      OR length(trim(NEW.status_change_request_id)) < 8
      OR length(NEW.status_change_request_id) > 128
    THEN RAISE(ABORT, 'OPS_SERVICE_STATUS_CHANGE_REASON_REQUIRED')
    WHEN NOT EXISTS (
      SELECT 1
      FROM ops_users u
      JOIN ops_memberships m ON m.user_id = u.id
      WHERE u.id = NEW.status_changed_by_user_id
        AND u.status = 'active'
        AND m.organization_id = NEW.organization_id
        AND m.status = 'active'
        AND m.role IN ('admin', 'commander')
    )
    THEN RAISE(ABORT, 'OPS_SERVICE_STATUS_CHANGE_ACTOR_INVALID')
  END;
END;
--> statement-breakpoint

CREATE TRIGGER ops_service_status_metadata_immutable_guard
BEFORE UPDATE OF status_change_reason, status_changed_at, status_changed_by_user_id, status_change_request_id ON ops_services
WHEN NEW.status = OLD.status AND (
  NEW.status_change_reason IS NOT OLD.status_change_reason
  OR NEW.status_changed_at IS NOT OLD.status_changed_at
  OR NEW.status_changed_by_user_id IS NOT OLD.status_changed_by_user_id
  OR NEW.status_change_request_id IS NOT OLD.status_change_request_id
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_SERVICE_STATUS_METADATA_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_service_status_change_history_append
AFTER UPDATE OF status ON ops_services
WHEN NEW.status <> OLD.status
BEGIN
  INSERT INTO ops_service_lifecycle_events
    (id, organization_id, service_id, from_status, to_status, reason,
     changed_by_user_id, request_id, changed_at)
  VALUES
    (NEW.id || ':lifecycle:' || printf('%020d', NEW.version), NEW.organization_id, NEW.id,
     OLD.status, NEW.status, NEW.status_change_reason,
     NEW.status_changed_by_user_id, NEW.status_change_request_id, NEW.status_changed_at);
END;
