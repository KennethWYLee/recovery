CREATE TABLE classroom_course_question_bank (
  id TEXT PRIMARY KEY NOT NULL,
  course_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '未分類',
  question_text TEXT NOT NULL,
  ranking_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES classroom_courses(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (status IN ('draft', 'ready', 'archived')),
  CHECK (usage_count >= 0),
  CHECK (version >= 1)
);
--> statement-breakpoint
CREATE INDEX classroom_course_question_bank_course_status_idx
ON classroom_course_question_bank (course_id, status, updated_at);
--> statement-breakpoint
CREATE INDEX classroom_course_question_bank_course_category_idx
ON classroom_course_question_bank (course_id, category, status);
--> statement-breakpoint
ALTER TABLE classroom_questions ADD COLUMN source_question_bank_id TEXT;
--> statement-breakpoint
CREATE INDEX classroom_questions_session_source_idx
ON classroom_questions (session_id, source_question_bank_id);
--> statement-breakpoint
PRAGMA optimize;
