PRAGMA foreign_keys = ON;
--> statement-breakpoint

CREATE TABLE ops_organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(trim(timezone)) BETWEEN 1 AND 64),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

INSERT INTO ops_organizations (id, name, timezone, status)
VALUES ('ops-singleton', 'Continuity Ops', 'UTC', 'active');
--> statement-breakpoint

CREATE TABLE ops_users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  identity_source TEXT NOT NULL CHECK (identity_source IN ('forwarded_identity', 'local_environment', 'invited')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE UNIQUE INDEX ops_users_email_unique ON ops_users (email);
--> statement-breakpoint

CREATE TABLE ops_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'commander', 'responder', 'observer', 'auditor')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, user_id)
);
--> statement-breakpoint

CREATE INDEX ops_memberships_role_idx ON ops_memberships (organization_id, role, status);
--> statement-breakpoint

CREATE TABLE ops_services (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'tier_2' CHECK (tier IN ('tier_1', 'tier_2', 'tier_3', 'tier_4')),
  owner_user_id TEXT REFERENCES ops_users(id) ON DELETE SET NULL,
  owner_team TEXT NOT NULL DEFAULT '',
  slo_target REAL NOT NULL DEFAULT 99.9 CHECK (slo_target > 0 AND slo_target <= 100),
  runbook_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, slug),
  UNIQUE (id, organization_id)
);
--> statement-breakpoint

CREATE INDEX ops_services_status_idx ON ops_services (organization_id, status, tier);
--> statement-breakpoint

CREATE TABLE ops_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  incident_number TEXT NOT NULL,
  service_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status TEXT NOT NULL DEFAULT 'declared' CHECK (status IN ('declared', 'investigating', 'mitigating', 'monitoring', 'resolved', 'closed', 'cancelled')),
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'staging', 'development', 'other')),
  impact_summary TEXT NOT NULL DEFAULT '',
  current_hypothesis TEXT NOT NULL DEFAULT '',
  current_mitigation TEXT NOT NULL DEFAULT '',
  verification_criteria TEXT NOT NULL DEFAULT '',
  declared_at TEXT NOT NULL,
  acknowledged_at TEXT,
  mitigated_at TEXT,
  resolved_at TEXT,
  closed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  updated_by_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  last_request_id TEXT NOT NULL,
  last_transition_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, incident_number),
  UNIQUE (id, organization_id),
  FOREIGN KEY (service_id, organization_id) REFERENCES ops_services(id, organization_id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX ops_incidents_active_idx ON ops_incidents (organization_id, status, severity, updated_at);
--> statement-breakpoint
CREATE INDEX ops_incidents_service_idx ON ops_incidents (service_id, updated_at);
--> statement-breakpoint

CREATE TABLE ops_incident_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  incident_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  incident_role TEXT NOT NULL CHECK (incident_role IN ('incident_commander', 'responder', 'communications_lead', 'service_owner', 'observer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  assigned_by_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  ended_by_user_id TEXT REFERENCES ops_users(id) ON DELETE RESTRICT,
  CHECK (
    (status = 'active' AND ended_at IS NULL AND ended_by_user_id IS NULL) OR
    (status = 'revoked' AND ended_at IS NOT NULL AND ended_by_user_id IS NOT NULL)
  ),
  FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX ops_assignments_user_idx ON ops_incident_assignments (organization_id, user_id, incident_id);
--> statement-breakpoint
CREATE INDEX ops_assignments_incident_status_idx ON ops_incident_assignments (incident_id, status, incident_role);
--> statement-breakpoint
CREATE UNIQUE INDEX ops_assignments_active_incident_user_role_unique
  ON ops_incident_assignments (incident_id, user_id, incident_role)
  WHERE status = 'active';
--> statement-breakpoint

CREATE TABLE ops_incident_timeline (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  incident_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('status_change', 'note', 'investigation', 'mitigation', 'verification', 'communication', 'task', 'assignment', 'review')),
  actor_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  message TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reference_url TEXT,
  source_label TEXT,
  observed_from TEXT,
  observed_to TEXT,
  sha256_digest TEXT CHECK (sha256_digest IS NULL OR (length(sha256_digest) = 64 AND sha256_digest NOT GLOB '*[^0-9a-f]*')),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (observed_from IS NULL OR observed_to IS NULL OR observed_from <= observed_to),
  FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX ops_timeline_incident_idx ON ops_incident_timeline (incident_id, created_at, id);
--> statement-breakpoint
CREATE UNIQUE INDEX ops_timeline_request_unique ON ops_incident_timeline (incident_id, request_id, event_type);
--> statement-breakpoint

CREATE TABLE ops_incident_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  incident_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
  assignee_user_id TEXT REFERENCES ops_users(id) ON DELETE SET NULL,
  due_at TEXT,
  completed_at TEXT,
  evidence_ref TEXT,
  cancellation_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, incident_id),
  CONSTRAINT ops_tasks_completed_evidence_check CHECK (
    status <> 'completed' OR (
      evidence_ref IS NOT NULL
      AND evidence_ref = trim(evidence_ref)
      AND length(evidence_ref) BETWEEN 9 AND 2048
      AND substr(evidence_ref, 1, 8) = 'https://'
      AND (
        (instr(substr(evidence_ref, 9), '/') = 0 AND length(substr(evidence_ref, 9)) BETWEEN 1 AND 253) OR
        instr(substr(evidence_ref, 9), '/') BETWEEN 2 AND 254
      )
      AND substr(substr(evidence_ref, 9), 1, 1) GLOB '[a-z0-9]'
      AND substr(substr(evidence_ref, 9), CASE WHEN instr(substr(evidence_ref, 9), '/') = 0
        THEN length(substr(evidence_ref, 9)) ELSE instr(substr(evidence_ref, 9), '/') - 1 END, 1) GLOB '[a-z0-9]'
      AND substr(substr(evidence_ref, 9), 1, CASE WHEN instr(substr(evidence_ref, 9), '/') = 0
        THEN length(substr(evidence_ref, 9)) ELSE instr(substr(evidence_ref, 9), '/') - 1 END) NOT GLOB '*[^a-z0-9.-]*'
      AND instr(substr(substr(evidence_ref, 9), 1, CASE WHEN instr(substr(evidence_ref, 9), '/') = 0
        THEN length(substr(evidence_ref, 9)) ELSE instr(substr(evidence_ref, 9), '/') - 1 END), '..') = 0
      AND instr(substr(substr(evidence_ref, 9), 1, CASE WHEN instr(substr(evidence_ref, 9), '/') = 0
        THEN length(substr(evidence_ref, 9)) ELSE instr(substr(evidence_ref, 9), '/') - 1 END), '.-') = 0
      AND instr(substr(substr(evidence_ref, 9), 1, CASE WHEN instr(substr(evidence_ref, 9), '/') = 0
        THEN length(substr(evidence_ref, 9)) ELSE instr(substr(evidence_ref, 9), '/') - 1 END), '-.') = 0
      AND instr(evidence_ref, ' ') = 0
      AND instr(evidence_ref, char(9)) = 0
      AND instr(evidence_ref, char(10)) = 0
      AND instr(evidence_ref, char(13)) = 0
    )
  ),
  CONSTRAINT ops_tasks_critical_cancellation_reason_check CHECK (
    status <> 'cancelled' OR priority <> 'critical' OR (
      cancellation_reason IS NOT NULL
      AND cancellation_reason = trim(cancellation_reason)
      AND length(cancellation_reason) BETWEEN 8 AND 1000
    )
  ),
  CONSTRAINT ops_tasks_cancellation_reason_lifecycle_check CHECK (
    status = 'cancelled' OR cancellation_reason IS NULL
  ),
  FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX ops_tasks_incident_idx ON ops_incident_tasks (incident_id, status, due_at);
--> statement-breakpoint
CREATE INDEX ops_tasks_assignee_idx ON ops_incident_tasks (organization_id, assignee_user_id, status);
--> statement-breakpoint

CREATE TABLE ops_incident_communications (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  incident_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('internal', 'stakeholder', 'public')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'published')),
  message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 10 AND 5000),
  affected_components TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(affected_components) AND json_type(affected_components) = 'array' AND length(affected_components) <= 8192),
  next_update_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  updated_by_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  reviewed_by_user_id TEXT REFERENCES ops_users(id) ON DELETE RESTRICT,
  published_by_user_id TEXT REFERENCES ops_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  published_at TEXT,
  last_request_id TEXT NOT NULL,
  UNIQUE (id, incident_id),
  CHECK (
    (status = 'draft' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL
      AND published_by_user_id IS NULL AND published_at IS NULL) OR
    (status = 'reviewed' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
      AND published_by_user_id IS NULL AND published_at IS NULL) OR
    (status = 'published' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
      AND published_by_user_id IS NOT NULL AND published_at IS NOT NULL)
  ),
  CHECK (
    status = 'draft' OR audience = 'internal' OR
    (lower(substr(message, 1, 7)) = '[final]' AND
      (length(message) = 7 OR substr(message, 8, 1) IN (' ', char(9), char(10), char(13)))) OR
    (next_update_at IS NOT NULL AND julianday(next_update_at) IS NOT NULL AND (
      (status = 'reviewed' AND julianday(next_update_at) > julianday(reviewed_at)) OR
      (status = 'published' AND julianday(next_update_at) > julianday(published_at))
    ))
  ),
  CHECK (
    julianday(created_at) IS NOT NULL AND
    julianday(updated_at) IS NOT NULL AND
    julianday(updated_at) >= julianday(created_at) AND
    (reviewed_at IS NULL OR (julianday(reviewed_at) IS NOT NULL
      AND julianday(reviewed_at) >= julianday(created_at)
      AND julianday(reviewed_at) <= julianday(updated_at))) AND
    (published_at IS NULL OR (reviewed_at IS NOT NULL
      AND julianday(published_at) IS NOT NULL
      AND julianday(published_at) >= julianday(reviewed_at)
      AND julianday(published_at) <= julianday(updated_at)))
  ),
  FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX ops_communications_incident_idx ON ops_incident_communications (incident_id, created_at, id);
--> statement-breakpoint
CREATE INDEX ops_communications_status_idx ON ops_incident_communications (organization_id, status, audience, updated_at);
--> statement-breakpoint
CREATE INDEX ops_communications_next_update_idx
  ON ops_incident_communications (organization_id, next_update_at, incident_id)
  WHERE status = 'published' AND next_update_at IS NOT NULL;
--> statement-breakpoint

CREATE TABLE ops_post_incident_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  incident_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  customer_impact TEXT NOT NULL DEFAULT '',
  root_cause TEXT NOT NULL DEFAULT '',
  detection_gap TEXT NOT NULL DEFAULT '',
  lessons_learned TEXT NOT NULL DEFAULT '',
  follow_up_actions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  updated_by_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (incident_id),
  CHECK (
    status = 'draft' OR (
      length(trim(summary)) >= 20 AND
      length(trim(customer_impact)) >= 10 AND
      length(trim(root_cause)) >= 10 AND
      length(trim(detection_gap)) >= 10 AND
      length(trim(lessons_learned)) >= 10 AND
      length(trim(follow_up_actions)) >= 10
    )
  ),
  FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE ops_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  reason_code TEXT,
  request_id TEXT NOT NULL,
  details_json TEXT,
  occurred_at TEXT NOT NULL
);
--> statement-breakpoint

CREATE INDEX ops_audit_time_idx ON ops_audit_events (organization_id, occurred_at, id);
--> statement-breakpoint
CREATE INDEX ops_audit_resource_idx ON ops_audit_events (resource_type, resource_id, occurred_at);
--> statement-breakpoint
CREATE INDEX ops_audit_actor_idx ON ops_audit_events (actor_user_id, occurred_at);
--> statement-breakpoint

CREATE TABLE ops_idempotency_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES ops_organizations(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE RESTRICT,
  action_scope TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (organization_id, actor_user_id, action_scope, idempotency_key_hash)
);
--> statement-breakpoint

CREATE INDEX ops_receipts_expiry_idx ON ops_idempotency_receipts (expires_at);
--> statement-breakpoint

CREATE TABLE ops_write_guards (
  id TEXT PRIMARY KEY NOT NULL,
  passed INTEGER NOT NULL CHECK (passed = 1),
  created_at TEXT NOT NULL
);
--> statement-breakpoint

CREATE TRIGGER ops_membership_version_guard
BEFORE UPDATE ON ops_memberships
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'OPS_MEMBERSHIP_VERSION_MUST_INCREMENT');
END;
--> statement-breakpoint

CREATE TRIGGER ops_service_version_guard
BEFORE UPDATE ON ops_services
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'OPS_SERVICE_VERSION_MUST_INCREMENT');
END;
--> statement-breakpoint

CREATE TRIGGER ops_service_deprecation_guard
BEFORE UPDATE OF status ON ops_services
WHEN OLD.status <> 'deprecated'
  AND NEW.status = 'deprecated'
  AND EXISTS (
    SELECT 1 FROM ops_incidents i
    WHERE i.service_id = OLD.id
      AND i.organization_id = OLD.organization_id
      AND i.status NOT IN ('closed', 'cancelled')
  )
BEGIN
  SELECT RAISE(ABORT, 'OPS_SERVICE_HAS_OPEN_INCIDENTS');
END;
--> statement-breakpoint

CREATE TRIGGER ops_incident_version_guard
BEFORE UPDATE ON ops_incidents
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'OPS_INCIDENT_VERSION_MUST_INCREMENT');
END;
--> statement-breakpoint

CREATE TRIGGER ops_incident_transition_guard
BEFORE UPDATE OF status ON ops_incidents
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'declared' AND NEW.status IN ('investigating', 'cancelled')) OR
  (OLD.status = 'investigating' AND NEW.status IN ('mitigating', 'cancelled')) OR
  (OLD.status = 'mitigating' AND NEW.status IN ('monitoring', 'investigating', 'cancelled')) OR
  (OLD.status = 'monitoring' AND NEW.status IN ('resolved', 'investigating', 'cancelled')) OR
  (OLD.status = 'resolved' AND NEW.status IN ('closed', 'investigating')) OR
  (OLD.status = 'closed' AND NEW.status = 'investigating')
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_INVALID_INCIDENT_TRANSITION');
END;
--> statement-breakpoint

CREATE TRIGGER ops_incident_resolution_readiness_guard
BEFORE UPDATE OF status ON ops_incidents
WHEN OLD.status = 'monitoring' AND NEW.status = 'resolved'
BEGIN
  SELECT CASE
    WHEN length(trim(NEW.verification_criteria)) = 0
      THEN RAISE(ABORT, 'OPS_RESOLUTION_CRITERIA_REQUIRED')
    WHEN NOT EXISTS (
      SELECT 1 FROM ops_incident_timeline t
      WHERE t.incident_id = NEW.id
        AND t.event_type = 'verification'
        AND NEW.mitigated_at IS NOT NULL
        AND t.created_at >= NEW.mitigated_at
    )
      THEN RAISE(ABORT, 'OPS_RESOLUTION_VERIFICATION_REQUIRED')
    WHEN EXISTS (
      SELECT 1 FROM ops_incident_tasks t
      WHERE t.incident_id = NEW.id
        AND t.priority = 'critical'
        AND t.status NOT IN ('completed', 'cancelled')
    )
      THEN RAISE(ABORT, 'OPS_RESOLUTION_CRITICAL_TASKS_OPEN')
  END;
END;
--> statement-breakpoint

CREATE TRIGGER ops_incident_actor_guard
BEFORE UPDATE ON ops_incidents
WHEN NOT EXISTS (
  SELECT 1 FROM ops_memberships m
  WHERE m.organization_id = NEW.organization_id
    AND m.user_id = NEW.updated_by_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_INCIDENT_ACTOR_MEMBERSHIP_REQUIRED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_incident_status_timeline
AFTER UPDATE OF status ON ops_incidents
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO ops_incident_timeline
    (id, organization_id, incident_id, event_type, actor_user_id, message,
     from_status, to_status, request_id, created_at)
  VALUES
    ('tl-' || lower(hex(randomblob(16))), NEW.organization_id, NEW.id, 'status_change',
     NEW.updated_by_user_id, NEW.last_transition_note, OLD.status, NEW.status,
     NEW.last_request_id, NEW.updated_at);

  INSERT INTO ops_audit_events
    (id, organization_id, actor_user_id, actor_role, action, resource_type,
     resource_id, outcome, request_id, details_json, occurred_at)
  SELECT
    'audit-' || lower(hex(randomblob(16))), NEW.organization_id, NEW.updated_by_user_id,
    m.role, 'incident.transition', 'incident', NEW.id, 'success', NEW.last_request_id,
    json_object('fromStatus', OLD.status, 'toStatus', NEW.status,
                'fromVersion', OLD.version, 'toVersion', NEW.version), NEW.updated_at
  FROM ops_memberships m
  WHERE m.organization_id = NEW.organization_id
    AND m.user_id = NEW.updated_by_user_id;
END;
--> statement-breakpoint

CREATE TRIGGER ops_task_version_guard
BEFORE UPDATE ON ops_incident_tasks
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'OPS_TASK_VERSION_MUST_INCREMENT');
END;
--> statement-breakpoint

CREATE TRIGGER ops_task_critical_cancellation_guard
BEFORE UPDATE ON ops_incident_tasks
WHEN OLD.priority = 'critical'
  AND NEW.status = 'cancelled'
  AND (
    NEW.cancellation_reason IS NULL OR
    NEW.cancellation_reason <> trim(NEW.cancellation_reason) OR
    length(NEW.cancellation_reason) NOT BETWEEN 8 AND 1000
  )
BEGIN
  SELECT RAISE(ABORT, 'OPS_TASK_CRITICAL_CANCELLATION_REASON_REQUIRED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_task_cancellation_reason_immutable
BEFORE UPDATE OF cancellation_reason ON ops_incident_tasks
WHEN OLD.status = 'cancelled'
  AND OLD.cancellation_reason IS NOT NULL
  AND NOT (NEW.cancellation_reason IS OLD.cancellation_reason)
BEGIN
  SELECT RAISE(ABORT, 'OPS_TASK_CANCELLATION_REASON_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_insert_draft_guard
BEFORE INSERT ON ops_incident_communications
WHEN NEW.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_MUST_START_DRAFT');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_version_guard
BEFORE UPDATE ON ops_incident_communications
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_VERSION_MUST_INCREMENT');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_transition_guard
BEFORE UPDATE ON ops_incident_communications
WHEN OLD.status <> 'published' AND NOT (
  (OLD.status = 'draft' AND NEW.status IN ('draft', 'reviewed')) OR
  (OLD.status = 'reviewed' AND NEW.status = 'published')
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_INVALID_TRANSITION');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_identity_immutable
BEFORE UPDATE OF id, organization_id, incident_id, created_by_user_id, created_at
ON ops_incident_communications
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_reviewed_content_immutable
BEFORE UPDATE OF audience, message, affected_components, next_update_at
ON ops_incident_communications
WHEN OLD.status = 'reviewed' AND (
  NEW.audience <> OLD.audience OR
  NEW.message <> OLD.message OR
  NEW.affected_components <> OLD.affected_components OR
  NOT (NEW.next_update_at IS OLD.next_update_at)
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_REVIEWED_CONTENT_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_publish_incident_guard
BEFORE UPDATE OF status ON ops_incident_communications
WHEN OLD.status = 'reviewed' AND NEW.status = 'published' AND EXISTS (
  SELECT 1 FROM ops_incidents i
  WHERE i.id = NEW.incident_id
    AND i.organization_id = NEW.organization_id
    AND i.status IN ('resolved', 'closed', 'cancelled')
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_INCIDENT_TERMINAL');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_external_schedule_guard
BEFORE UPDATE OF status ON ops_incident_communications
WHEN (
    (OLD.status = 'draft' AND NEW.status = 'reviewed') OR
    (OLD.status = 'reviewed' AND NEW.status = 'published')
  )
  AND NEW.audience IN ('stakeholder', 'public')
  AND NOT (
    (NEW.next_update_at IS NOT NULL
      AND julianday(NEW.next_update_at) IS NOT NULL
      AND julianday(NEW.next_update_at) > julianday(CASE NEW.status
        WHEN 'reviewed' THEN NEW.reviewed_at
        ELSE NEW.published_at
      END)) OR
    (lower(substr(NEW.message, 1, 7)) = '[final]' AND
      (length(NEW.message) = 7 OR substr(NEW.message, 8, 1) IN (' ', char(9), char(10), char(13))))
  )
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_NEXT_UPDATE_REQUIRED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_published_update_guard
BEFORE UPDATE ON ops_incident_communications
WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_PUBLISHED_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_communication_published_delete_guard
BEFORE DELETE ON ops_incident_communications
WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMUNICATION_PUBLISHED_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_review_version_guard
BEFORE UPDATE ON ops_post_incident_reviews
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'OPS_REVIEW_VERSION_MUST_INCREMENT');
END;
--> statement-breakpoint

CREATE TRIGGER ops_review_incident_status_insert_guard
BEFORE INSERT ON ops_post_incident_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM ops_incidents i
  WHERE i.id = NEW.incident_id
    AND i.organization_id = NEW.organization_id
    AND i.status IN ('resolved', 'closed')
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_REVIEW_INCIDENT_NOT_RESOLVED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_review_incident_status_update_guard
BEFORE UPDATE ON ops_post_incident_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM ops_incidents i
  WHERE i.id = NEW.incident_id
    AND i.organization_id = NEW.organization_id
    AND i.status IN ('resolved', 'closed')
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_REVIEW_INCIDENT_NOT_RESOLVED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_assignment_membership_guard
BEFORE INSERT ON ops_incident_assignments
WHEN NEW.status = 'active' AND NOT EXISTS (
  SELECT 1 FROM ops_memberships m
  WHERE m.organization_id = NEW.organization_id
    AND m.user_id = NEW.user_id
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_ASSIGNEE_NOT_ACTIVE_MEMBER');
END;
--> statement-breakpoint

CREATE TRIGGER ops_assignment_commander_role_guard
BEFORE INSERT ON ops_incident_assignments
WHEN NEW.status = 'active' AND NEW.incident_role = 'incident_commander' AND NOT EXISTS (
  SELECT 1 FROM ops_memberships m
  JOIN ops_users u ON u.id = m.user_id
  WHERE m.organization_id = NEW.organization_id
    AND m.user_id = NEW.user_id
    AND m.role IN ('admin', 'commander')
    AND m.status = 'active'
    AND u.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_COMMANDER_ROLE_REQUIRED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_assignment_commander_revoke_guard
BEFORE UPDATE OF status ON ops_incident_assignments
WHEN OLD.status = 'active'
  AND OLD.incident_role = 'incident_commander'
  AND NEW.status = 'revoked'
  AND NOT EXISTS (
    SELECT 1 FROM ops_incident_assignments a
    JOIN ops_memberships m
      ON m.organization_id = a.organization_id AND m.user_id = a.user_id
    JOIN ops_users u ON u.id = a.user_id
    WHERE a.incident_id = OLD.incident_id
      AND a.incident_role = 'incident_commander'
      AND a.status = 'active'
      AND a.id <> OLD.id
      AND m.status = 'active'
      AND m.role IN ('admin', 'commander')
      AND u.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'OPS_INCIDENT_COMMANDER_REQUIRED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_assignment_identity_immutable
BEFORE UPDATE OF organization_id, incident_id, user_id, incident_role, assigned_by_user_id, created_at
ON ops_incident_assignments
BEGIN
  SELECT RAISE(ABORT, 'OPS_ASSIGNMENT_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_assignment_revoked_immutable
BEFORE UPDATE ON ops_incident_assignments
WHEN OLD.status = 'revoked'
BEGIN
  SELECT RAISE(ABORT, 'OPS_ASSIGNMENT_REVOKED_IMMUTABLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_task_assignee_membership_guard
BEFORE INSERT ON ops_incident_tasks
WHEN NEW.assignee_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ops_memberships m
  WHERE m.organization_id = NEW.organization_id
    AND m.user_id = NEW.assignee_user_id
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_TASK_ASSIGNEE_NOT_ACTIVE_MEMBER');
END;
--> statement-breakpoint

CREATE TRIGGER ops_last_active_admin_update_guard
BEFORE UPDATE OF role, status ON ops_memberships
WHEN OLD.role = 'admin'
  AND OLD.status = 'active'
  AND (NEW.role <> 'admin' OR NEW.status <> 'active')
  AND NOT EXISTS (
    SELECT 1 FROM ops_memberships m
    WHERE m.organization_id = OLD.organization_id
      AND m.id <> OLD.id
      AND m.role = 'admin'
      AND m.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'OPS_LAST_ADMIN_REQUIRED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_active_incident_commander_membership_update_guard
BEFORE UPDATE OF role, status ON ops_memberships
WHEN OLD.status = 'active'
  AND OLD.role IN ('admin', 'commander')
  AND (NEW.status <> 'active' OR NEW.role NOT IN ('admin', 'commander'))
  AND EXISTS (
    SELECT 1 FROM ops_incident_assignments a
    JOIN ops_incidents i ON i.id = a.incident_id
    WHERE a.organization_id = OLD.organization_id
      AND a.user_id = OLD.user_id
      AND a.incident_role = 'incident_commander'
      AND a.status = 'active'
      AND i.status NOT IN ('closed', 'cancelled')
      AND NOT EXISTS (
        SELECT 1 FROM ops_incident_assignments other
        JOIN ops_memberships other_m
          ON other_m.organization_id = other.organization_id AND other_m.user_id = other.user_id
        JOIN ops_users other_u ON other_u.id = other.user_id
        WHERE other.incident_id = a.incident_id
          AND other.id <> a.id
          AND other.incident_role = 'incident_commander'
          AND other.status = 'active'
          AND other_m.status = 'active'
          AND other_m.role IN ('admin', 'commander')
          AND other_u.status = 'active'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'OPS_ACTIVE_INCIDENT_HANDOFF_REQUIRED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_last_active_admin_delete_guard
BEFORE DELETE ON ops_memberships
WHEN OLD.role = 'admin'
  AND OLD.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM ops_memberships m
    WHERE m.organization_id = OLD.organization_id
      AND m.id <> OLD.id
      AND m.role = 'admin'
      AND m.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'OPS_LAST_ADMIN_REQUIRED');
END;
--> statement-breakpoint

CREATE TRIGGER ops_task_assignee_update_guard
BEFORE UPDATE OF assignee_user_id ON ops_incident_tasks
WHEN NEW.assignee_user_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ops_memberships m
  WHERE m.organization_id = NEW.organization_id
    AND m.user_id = NEW.assignee_user_id
    AND m.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_TASK_ASSIGNEE_NOT_ACTIVE_MEMBER');
END;
--> statement-breakpoint

CREATE TRIGGER ops_audit_append_only_update
BEFORE UPDATE ON ops_audit_events
BEGIN
  SELECT RAISE(ABORT, 'OPS_AUDIT_APPEND_ONLY');
END;
--> statement-breakpoint

CREATE TRIGGER ops_audit_append_only_delete
BEFORE DELETE ON ops_audit_events
BEGIN
  SELECT RAISE(ABORT, 'OPS_AUDIT_APPEND_ONLY');
END;
--> statement-breakpoint

CREATE TRIGGER ops_timeline_append_only_update
BEFORE UPDATE ON ops_incident_timeline
BEGIN
  SELECT RAISE(ABORT, 'OPS_TIMELINE_APPEND_ONLY');
END;
--> statement-breakpoint

CREATE TRIGGER ops_timeline_append_only_delete
BEFORE DELETE ON ops_incident_timeline
BEGIN
  SELECT RAISE(ABORT, 'OPS_TIMELINE_APPEND_ONLY');
END;
