ALTER TABLE classroom_questions ADD COLUMN answer_duration_seconds INTEGER NOT NULL DEFAULT 300;
--> statement-breakpoint
ALTER TABLE classroom_questions ADD COLUMN answer_deadline_at TEXT;
--> statement-breakpoint
CREATE INDEX classroom_questions_answer_deadline_idx
ON classroom_questions (session_id, phase, answer_deadline_at);
--> statement-breakpoint
PRAGMA optimize;
