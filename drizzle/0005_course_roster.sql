CREATE TABLE classroom_course_roster (
  id TEXT PRIMARY KEY NOT NULL,
  course_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  source_file_name TEXT NOT NULL,
  imported_by_user_id TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (course_id) REFERENCES classroom_courses(id) ON DELETE RESTRICT,
  FOREIGN KEY (imported_by_user_id) REFERENCES classroom_users(id) ON DELETE RESTRICT,
  CHECK (status IN ('active', 'removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX classroom_course_roster_course_student_unique
ON classroom_course_roster (course_id, student_id);
--> statement-breakpoint
CREATE INDEX classroom_course_roster_course_email_idx
ON classroom_course_roster (course_id, email);
--> statement-breakpoint
CREATE INDEX classroom_course_roster_email_status_idx
ON classroom_course_roster (email, status, course_id);
--> statement-breakpoint
PRAGMA optimize;
