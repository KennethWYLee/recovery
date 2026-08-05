CREATE TABLE IF NOT EXISTS classroom_access_requests (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  requested_at TEXT NOT NULL,
  last_requested_at TEXT NOT NULL,
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (length(email) BETWEEN 6 AND 254),
  CHECK (length(display_name) BETWEEN 1 AND 120),
  CHECK (
    (status = 'pending' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
    OR (status IN ('approved', 'rejected') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS classroom_access_requests_status_time_idx
ON classroom_access_requests (status, last_requested_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS classroom_access_allowlist (
  email TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  approved_by_user_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (length(email) BETWEEN 6 AND 254)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS classroom_access_allowlist_status_time_idx
ON classroom_access_allowlist (status, approved_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS classroom_courses_term_name_active_unique
ON classroom_courses (academic_year, term, name_key)
WHERE status = 'active';
