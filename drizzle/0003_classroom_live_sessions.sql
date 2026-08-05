ALTER TABLE classroom_courses
ADD COLUMN default_group_capacity INTEGER NOT NULL DEFAULT 5
CHECK (default_group_capacity BETWEEN 2 AND 20);
--> statement-breakpoint
CREATE TABLE classroom_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  ranking_criteria TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL DEFAULT 'check_in' CHECK (phase IN ('check_in', 'grouping', 'answering', 'presenting', 'ranking', 'results', 'archived')),
  group_capacity INTEGER NOT NULL CHECK (group_capacity BETWEEN 2 AND 20),
  effective_group_capacity INTEGER NOT NULL CHECK (effective_group_capacity BETWEEN group_capacity AND 50),
  anonymous_groups INTEGER NOT NULL DEFAULT 1 CHECK (anonymous_groups IN (0, 1)),
  allow_ranking_edits INTEGER NOT NULL DEFAULT 1 CHECK (allow_ranking_edits IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES classroom_courses(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (length(title) BETWEEN 2 AND 100),
  CHECK (length(question) BETWEEN 5 AND 2000),
  CHECK (length(ranking_criteria) BETWEEN 5 AND 500),
  CHECK (length(join_code) = 6)
);
--> statement-breakpoint
CREATE UNIQUE INDEX classroom_sessions_course_active_unique
ON classroom_sessions (course_id)
WHERE phase != 'archived';
--> statement-breakpoint
CREATE INDEX classroom_sessions_course_created_idx
ON classroom_sessions (course_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE classroom_groups (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  label TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  representative_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES classroom_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (representative_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  UNIQUE (session_id, label),
  UNIQUE (session_id, position),
  CHECK (length(label) BETWEEN 1 AND 30)
);
--> statement-breakpoint
CREATE TABLE classroom_session_participants (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT,
  attendance TEXT NOT NULL CHECK (attendance IN ('on_time', 'late')),
  joined_phase TEXT NOT NULL CHECK (joined_phase IN ('check_in', 'grouping', 'answering', 'presenting', 'ranking', 'results')),
  can_rank INTEGER NOT NULL DEFAULT 1 CHECK (can_rank IN (0, 1)),
  checked_in_at TEXT NOT NULL,
  grouped_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES classroom_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (group_id) REFERENCES classroom_groups(id) ON DELETE RESTRICT,
  UNIQUE (session_id, user_id)
);
--> statement-breakpoint
CREATE INDEX classroom_session_participants_group_idx
ON classroom_session_participants (group_id, checked_in_at);
--> statement-breakpoint
CREATE TABLE classroom_group_responses (
  group_id TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'locked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_user_id TEXT,
  submitted_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (group_id) REFERENCES classroom_groups(id) ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (length(content) <= 4000)
);
--> statement-breakpoint
CREATE TABLE classroom_ranking_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'invalid')),
  invalid_reason TEXT,
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES classroom_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  UNIQUE (session_id, user_id, version)
);
--> statement-breakpoint
CREATE UNIQUE INDEX classroom_ranking_submissions_current_unique
ON classroom_ranking_submissions (session_id, user_id)
WHERE is_current = 1;
--> statement-breakpoint
CREATE INDEX classroom_ranking_submissions_session_status_idx
ON classroom_ranking_submissions (session_id, is_current, status);
--> statement-breakpoint
CREATE TABLE classroom_ranking_items (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  is_own_group INTEGER NOT NULL DEFAULT 0 CHECK (is_own_group IN (0, 1)),
  FOREIGN KEY (submission_id) REFERENCES classroom_ranking_submissions(id) ON DELETE RESTRICT,
  FOREIGN KEY (group_id) REFERENCES classroom_groups(id) ON DELETE RESTRICT,
  UNIQUE (submission_id, group_id),
  UNIQUE (submission_id, rank)
);
--> statement-breakpoint
CREATE INDEX classroom_ranking_items_group_rank_idx
ON classroom_ranking_items (group_id, rank);
--> statement-breakpoint
CREATE TABLE classroom_rate_limits (
  scope_key TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX classroom_audit_events_resource_time_idx
ON classroom_audit_events (resource_type, resource_id, occurred_at DESC);
