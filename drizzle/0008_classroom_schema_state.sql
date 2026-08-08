CREATE TABLE `classroom_schema_state` (
  `singleton_id` integer PRIMARY KEY NOT NULL,
  `schema_version` integer NOT NULL,
  `schema_fingerprint` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `classroom_schema_state_singleton_check` CHECK (`singleton_id` = 1),
  CONSTRAINT `classroom_schema_state_version_check` CHECK (`schema_version` >= 1)
);
--> statement-breakpoint
INSERT INTO `classroom_schema_state`
  (`singleton_id`, `schema_version`, `schema_fingerprint`, `updated_at`)
VALUES
  (1, 8, 'classroom-schema-v8-20260807', '2026-08-07T00:00:00.000Z');
--> statement-breakpoint
PRAGMA optimize;
