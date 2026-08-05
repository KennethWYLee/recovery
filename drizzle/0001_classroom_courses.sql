CREATE TABLE IF NOT EXISTS classroom_users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  CHECK (length(email) BETWEEN 6 AND 254),
  CHECK (length(display_name) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS classroom_courses (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  academic_year INTEGER NOT NULL CHECK (academic_year BETWEEN 100 AND 999),
  term TEXT NOT NULL CHECK (term IN ('1', '2', 'summer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (owner_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (length(name) BETWEEN 2 AND 80),
  CHECK (length(name_key) BETWEEN 2 AND 80),
  CHECK ((status = 'active' AND deleted_at IS NULL) OR (status = 'deleted' AND deleted_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS classroom_courses_owner_name_active_unique
ON classroom_courses (owner_user_id, name_key)
WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS classroom_courses_owner_status_idx
ON classroom_courses (owner_user_id, status, updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS classroom_course_members (
  id TEXT PRIMARY KEY NOT NULL,
  course_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES classroom_courses(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  UNIQUE (course_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS classroom_course_members_user_status_idx
ON classroom_course_members (user_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS classroom_seed_state (
  user_id TEXT PRIMARY KEY NOT NULL,
  seeded_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS classroom_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (length(action) BETWEEN 3 AND 80),
  CHECK (length(resource_type) BETWEEN 3 AND 40),
  CHECK (length(resource_id) BETWEEN 3 AND 100)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS classroom_audit_events_actor_time_idx
ON classroom_audit_events (actor_user_id, occurred_at DESC);
