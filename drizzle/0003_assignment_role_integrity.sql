-- Enforce the organization-role x incident-role contract at the persistence
-- boundary. Existing incompatible active assignments stop this migration so
-- an operator can reconcile them explicitly instead of silently losing history.

CREATE TABLE ops_migration_0003_assignment_role_guard (
  id INTEGER PRIMARY KEY,
  passed INTEGER NOT NULL
    CONSTRAINT OPS_ASSIGNMENT_ROLE_INCOMPATIBLE CHECK (passed = 1)
);
--> statement-breakpoint

INSERT INTO ops_migration_0003_assignment_role_guard (id, passed)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1
  FROM ops_incident_assignments a
  LEFT JOIN ops_memberships m
    ON m.organization_id = a.organization_id AND m.user_id = a.user_id
  LEFT JOIN ops_users u ON u.id = a.user_id
  WHERE a.status = 'active' AND (
    m.id IS NULL OR m.status <> 'active' OR u.id IS NULL OR u.status <> 'active' OR NOT (
      m.role = 'admin'
      OR (m.role = 'commander' AND a.incident_role IN ('incident_commander', 'communications_lead', 'observer'))
      OR (m.role = 'responder' AND a.incident_role IN ('responder', 'communications_lead', 'service_owner', 'observer'))
      OR (m.role IN ('observer', 'auditor') AND a.incident_role = 'observer')
    )
  )
) THEN 1 ELSE 0 END;
--> statement-breakpoint

DROP TABLE ops_migration_0003_assignment_role_guard;
--> statement-breakpoint

CREATE TRIGGER ops_assignment_role_compatibility_insert_guard
BEFORE INSERT ON ops_incident_assignments
WHEN NEW.status = 'active' AND NOT EXISTS (
  SELECT 1
  FROM ops_memberships m
  JOIN ops_users u ON u.id = m.user_id
  WHERE m.organization_id = NEW.organization_id
    AND m.user_id = NEW.user_id
    AND m.status = 'active'
    AND u.status = 'active'
    AND (
      m.role = 'admin'
      OR (m.role = 'commander' AND NEW.incident_role IN ('incident_commander', 'communications_lead', 'observer'))
      OR (m.role = 'responder' AND NEW.incident_role IN ('responder', 'communications_lead', 'service_owner', 'observer'))
      OR (m.role IN ('observer', 'auditor') AND NEW.incident_role = 'observer')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_ASSIGNMENT_ROLE_INCOMPATIBLE');
END;
--> statement-breakpoint

CREATE TRIGGER ops_membership_assignment_compatibility_update_guard
BEFORE UPDATE OF role, status ON ops_memberships
WHEN EXISTS (
  SELECT 1
  FROM ops_incident_assignments a
  WHERE a.organization_id = OLD.organization_id
    AND a.user_id = OLD.user_id
    AND a.status = 'active'
    AND (
      NEW.status <> 'active' OR NOT (
        NEW.role = 'admin'
        OR (NEW.role = 'commander' AND a.incident_role IN ('incident_commander', 'communications_lead', 'observer'))
        OR (NEW.role = 'responder' AND a.incident_role IN ('responder', 'communications_lead', 'service_owner', 'observer'))
        OR (NEW.role IN ('observer', 'auditor') AND a.incident_role = 'observer')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'OPS_ASSIGNMENT_ROLE_INCOMPATIBLE');
END;
