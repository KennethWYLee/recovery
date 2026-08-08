CREATE TABLE `classroom_operation_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`actor_user_id` text,
	`actor_kind` text NOT NULL,
	`method` text NOT NULL,
	`route` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`outcome` text NOT NULL,
	`status_code` integer NOT NULL,
	`error_code` text,
	`duration_ms` integer NOT NULL,
	`capture_kind` text NOT NULL,
	`test_mode` integer DEFAULT false NOT NULL,
	`environment` text NOT NULL,
	`security_relevant` integer DEFAULT false NOT NULL,
	`release` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `classroom_users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `classroom_operation_logs_actor_kind_check` CHECK(`actor_kind` IN ('administrator','student','anonymous')),
	CONSTRAINT `classroom_operation_logs_outcome_check` CHECK(`outcome` IN ('success','client_error','server_error')),
	CONSTRAINT `classroom_operation_logs_capture_kind_check` CHECK(`capture_kind` IN ('error','mutation','slow','sample')),
	CONSTRAINT `classroom_operation_logs_scope_type_check` CHECK(`scope_type` IN ('course','session','question','system')),
	CONSTRAINT `classroom_operation_logs_status_check` CHECK(`status_code` BETWEEN 100 AND 599),
	CONSTRAINT `classroom_operation_logs_duration_check` CHECK(`duration_ms` BETWEEN 0 AND 120000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `classroom_operation_logs_request_unique` ON `classroom_operation_logs` (`request_id`);
--> statement-breakpoint
CREATE INDEX `classroom_operation_logs_time_idx` ON `classroom_operation_logs` (`occurred_at`);
--> statement-breakpoint
CREATE INDEX `classroom_operation_logs_outcome_time_idx` ON `classroom_operation_logs` (`outcome`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `classroom_operation_logs_route_time_idx` ON `classroom_operation_logs` (`route`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `classroom_operation_logs_scope_time_idx` ON `classroom_operation_logs` (`scope_type`,`scope_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `classroom_operation_logs_security_time_idx` ON `classroom_operation_logs` (`security_relevant`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `classroom_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`source_request_id` text,
	`verification_request_id` text,
	`symptom` text NOT NULL,
	`root_cause` text DEFAULT '' NOT NULL,
	`resolution` text DEFAULT '' NOT NULL,
	`fix_release` text DEFAULT '' NOT NULL,
	`regression_check` text DEFAULT '' NOT NULL,
	`regression_command` text DEFAULT '' NOT NULL,
	`regression_evidence` text DEFAULT '' NOT NULL,
	`verification_result` text DEFAULT 'not_run' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`updated_by_user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`detected_at` text NOT NULL,
	`resolved_at` text,
	`verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_request_id`) REFERENCES `classroom_operation_logs`(`request_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`verification_request_id`) REFERENCES `classroom_operation_logs`(`request_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `classroom_users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `classroom_users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `classroom_incidents_severity_check` CHECK(`severity` IN ('low','medium','high','critical')),
	CONSTRAINT `classroom_incidents_status_check` CHECK(`status` IN ('open','investigating','resolved')),
	CONSTRAINT `classroom_incidents_verification_result_check` CHECK(`verification_result` IN ('not_run','passed','failed')),
	CONSTRAINT `classroom_incidents_resolved_evidence_check` CHECK(
		`status` != 'resolved' OR (
			`source_request_id` IS NOT NULL AND
			`verification_request_id` IS NOT NULL AND
			`source_request_id` != `verification_request_id` AND
			`verification_result` = 'passed' AND
			length(trim(`root_cause`)) > 0 AND
			length(trim(`resolution`)) > 0 AND
			length(trim(`fix_release`)) > 0 AND
			`fix_release` NOT LIKE '%-unverified' AND
			length(trim(`regression_check`)) > 0 AND
			length(trim(`regression_command`)) > 0 AND
			length(trim(`regression_evidence`)) > 0 AND
			`resolved_at` IS NOT NULL AND
			`verified_at` IS NOT NULL
		)
	),
	CONSTRAINT `classroom_incidents_version_check` CHECK(`version` >= 1)
);
--> statement-breakpoint
CREATE INDEX `classroom_incidents_status_time_idx` ON `classroom_incidents` (`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `classroom_incidents_severity_time_idx` ON `classroom_incidents` (`severity`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `classroom_incidents_source_request_idx` ON `classroom_incidents` (`source_request_id`);
--> statement-breakpoint
CREATE INDEX `classroom_incidents_verification_request_idx` ON `classroom_incidents` (`verification_request_id`);
--> statement-breakpoint
UPDATE `classroom_schema_state`
SET `schema_version` = 9,
    `schema_fingerprint` = 'classroom-schema-v9-20260808',
    `updated_at` = '2026-08-08T00:00:00.000Z'
WHERE `singleton_id` = 1;
