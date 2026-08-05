ALTER TABLE classroom_courses ADD COLUMN default_group_count INTEGER NOT NULL DEFAULT 6;
--> statement-breakpoint
ALTER TABLE classroom_courses ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE classroom_sessions ADD COLUMN group_count INTEGER NOT NULL DEFAULT 6;
--> statement-breakpoint
ALTER TABLE classroom_sessions ADD COLUMN admission_open INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE classroom_sessions ADD COLUMN qr_enabled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE classroom_questions (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  question_text TEXT NOT NULL,
  ranking_criteria TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'draft',
  position INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  opened_at TEXT,
  responses_locked_at TEXT,
  ranking_locked_at TEXT,
  published_at TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES classroom_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (phase IN ('draft', 'answering', 'presenting', 'ranking', 'locked', 'published', 'archived')),
  CHECK (position >= 1),
  CHECK (version >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX classroom_questions_session_position_unique
ON classroom_questions (session_id, position);
--> statement-breakpoint
CREATE UNIQUE INDEX classroom_questions_one_active_unique
ON classroom_questions (session_id)
WHERE phase IN ('answering', 'presenting', 'ranking', 'locked');
--> statement-breakpoint
CREATE INDEX classroom_questions_session_phase_idx
ON classroom_questions (session_id, phase, position);
--> statement-breakpoint
CREATE TABLE classroom_question_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  question_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  can_rank INTEGER NOT NULL DEFAULT 1,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES classroom_questions(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (group_id) REFERENCES classroom_groups(id) ON DELETE RESTRICT,
  UNIQUE (question_id, user_id)
);
--> statement-breakpoint
CREATE INDEX classroom_question_memberships_group_idx
ON classroom_question_memberships (question_id, group_id);
--> statement-breakpoint
CREATE TABLE classroom_question_responses (
  id TEXT PRIMARY KEY NOT NULL,
  question_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by_user_id TEXT,
  submitted_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (question_id) REFERENCES classroom_questions(id) ON DELETE RESTRICT,
  FOREIGN KEY (group_id) REFERENCES classroom_groups(id) ON DELETE RESTRICT,
  FOREIGN KEY (updated_by_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  UNIQUE (question_id, group_id),
  CHECK (status IN ('draft', 'submitted', 'locked')),
  CHECK (version >= 1)
);
--> statement-breakpoint
CREATE INDEX classroom_question_responses_question_status_idx
ON classroom_question_responses (question_id, status);
--> statement-breakpoint
CREATE TABLE classroom_question_ranking_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  question_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'valid',
  invalid_reason TEXT,
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES classroom_questions(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  UNIQUE (question_id, user_id, version),
  CHECK (status IN ('valid', 'invalid')),
  CHECK (version >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX classroom_question_rankings_current_unique
ON classroom_question_ranking_submissions (question_id, user_id)
WHERE is_current = 1;
--> statement-breakpoint
CREATE INDEX classroom_question_rankings_question_status_idx
ON classroom_question_ranking_submissions (question_id, is_current, status);
--> statement-breakpoint
CREATE TABLE classroom_question_ranking_items (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES classroom_question_ranking_submissions(id) ON DELETE RESTRICT,
  FOREIGN KEY (group_id) REFERENCES classroom_groups(id) ON DELETE RESTRICT,
  UNIQUE (submission_id, group_id),
  UNIQUE (submission_id, rank),
  CHECK (rank >= 1)
);
--> statement-breakpoint
CREATE INDEX classroom_question_ranking_items_group_rank_idx
ON classroom_question_ranking_items (group_id, rank);
--> statement-breakpoint
INSERT OR IGNORE INTO classroom_questions
  (id, session_id, question_text, ranking_criteria, phase, position, version, opened_at,
   responses_locked_at, ranking_locked_at, published_at, created_by_user_id, created_at, updated_at)
SELECT 'question-legacy-' || id, id, question, ranking_criteria,
  CASE phase
    WHEN 'answering' THEN 'answering'
    WHEN 'presenting' THEN 'presenting'
    WHEN 'ranking' THEN 'ranking'
    WHEN 'results' THEN 'published'
    WHEN 'archived' THEN 'archived'
    ELSE 'draft'
  END,
  1, version,
  CASE WHEN phase IN ('answering','presenting','ranking','results','archived') THEN created_at ELSE NULL END,
  CASE WHEN phase IN ('presenting','ranking','results','archived') THEN updated_at ELSE NULL END,
  CASE WHEN phase IN ('results','archived') THEN updated_at ELSE NULL END,
  CASE WHEN phase IN ('results','archived') THEN updated_at ELSE NULL END,
  created_by_user_id, created_at, updated_at
FROM classroom_sessions;
--> statement-breakpoint
INSERT OR IGNORE INTO classroom_question_memberships
  (id, question_id, user_id, group_id, can_rank, captured_at)
SELECT 'qmember-legacy-' || p.id, 'question-legacy-' || p.session_id, p.user_id, p.group_id, p.can_rank, p.updated_at
FROM classroom_session_participants p
WHERE p.group_id IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO classroom_question_responses
  (id, question_id, group_id, content, status, version, updated_by_user_id, submitted_at, updated_at)
SELECT 'qresponse-legacy-' || r.group_id, 'question-legacy-' || g.session_id, r.group_id,
  r.content, r.status, r.version, r.updated_by_user_id, r.submitted_at, r.updated_at
FROM classroom_group_responses r
JOIN classroom_groups g ON g.id = r.group_id;
--> statement-breakpoint
INSERT OR IGNORE INTO classroom_question_ranking_submissions
  (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
SELECT 'q-' || id, 'question-legacy-' || session_id, user_id, version, is_current, status, invalid_reason, submitted_at
FROM classroom_ranking_submissions;
--> statement-breakpoint
INSERT OR IGNORE INTO classroom_question_ranking_items
  (id, submission_id, group_id, rank)
SELECT 'q-' || i.id, 'q-' || i.submission_id, i.group_id, i.rank
FROM classroom_ranking_items i;
--> statement-breakpoint
UPDATE classroom_sessions SET phase = 'answering'
WHERE phase IN ('answering', 'presenting', 'ranking', 'results');
--> statement-breakpoint
PRAGMA optimize;
