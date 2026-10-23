CREATE TYPE "public"."feedback_fix_status" AS ENUM('sent', 'pushed', 'failed', 'limit_reached');--> statement-breakpoint
CREATE TYPE "public"."feedback_source" AS ENUM('review', 'ci');--> statement-breakpoint
CREATE TYPE "public"."mention_source" AS ENUM('task_comment', 'review_comment', 'collab_document');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('permission_request', 'gate_pending', 'verification_failed', 'feedback_limit_reached', 'mentioned', 'task_assigned', 'task_merged', 'task_rejected', 'run_stopped');--> statement-breakpoint
CREATE TYPE "public"."review_comment_kind" AS ENUM('diff', 'preview');--> statement-breakpoint
CREATE TYPE "public"."run_origin" AS ENUM('dispatch', 'delegation', 'verification', 'mention', 'feedback_loop');--> statement-breakpoint
CREATE TYPE "public"."task_note_source" AS ENUM('agent', 'feedback_loop');--> statement-breakpoint
CREATE TYPE "public"."verification_outcome" AS ENUM('passed', 'failed', 'error');--> statement-breakpoint
CREATE TYPE "public"."verification_resolution" AS ENUM('retry', 'skip', 'abort');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('running', 'passed', 'failed', 'error', 'canceled');--> statement-breakpoint
ALTER TYPE "public"."needs_you_kind" ADD VALUE 'child_question';--> statement-breakpoint
ALTER TYPE "public"."run_control_action" ADD VALUE 'verify';--> statement-breakpoint
ALTER TYPE "public"."run_control_action" ADD VALUE 'archive';--> statement-breakpoint
ALTER TYPE "public"."run_control_action" ADD VALUE 'restart_preview';--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'verifying' BEFORE 'awaiting_permission';--> statement-breakpoint
CREATE TABLE "collab_documents" (
	"name" text PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"acceptance_criterion_id" uuid,
	"repo_spec_id" uuid,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collab_documents_single_owner" CHECK (num_nonnulls("collab_documents"."task_id", "collab_documents"."acceptance_criterion_id", "collab_documents"."repo_spec_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"source_kind" "mention_source" NOT NULL,
	"source_id" text NOT NULL,
	"node_id" text NOT NULL,
	"member_id" uuid,
	"agent" text,
	"created_by_member_id" uuid,
	"consult_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentions_source_node_unique" UNIQUE("source_kind","source_id","node_id"),
	CONSTRAINT "mentions_single_target" CHECK (("mentions"."member_id" IS NULL) <> ("mentions"."agent" IS NULL)),
	CONSTRAINT "mentions_task_required_outside_collab" CHECK ("mentions"."task_id" IS NOT NULL OR "mentions"."source_kind" = 'collab_document')
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"author_member_id" uuid,
	"author_run_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_comments_single_author" CHECK ("task_comments"."author_member_id" IS NULL OR "task_comments"."author_run_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "task_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"source" "task_note_source" NOT NULL,
	"body" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "child_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"child_run_id" uuid NOT NULL,
	"parent_run_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"answered_by_run_id" uuid,
	"answered_by_member_id" uuid,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "child_questions_answer_complete" CHECK (("child_questions"."answer" IS NULL) = ("child_questions"."answered_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "orbis_tool_calls" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "orbis_tool_calls_result_complete" CHECK (("orbis_tool_calls"."result" IS NULL) = ("orbis_tool_calls"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "feedback_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"source" "feedback_source" NOT NULL,
	"head_sha" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_batches_pr_source_unique" UNIQUE("github_repo_id","pr_number","source"),
	CONSTRAINT "feedback_batches_head_sha_only_for_ci" CHECK (("feedback_batches"."source"::text = 'ci') = ("feedback_batches"."head_sha" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "feedback_fixes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"source" "feedback_source" NOT NULL,
	"previous_run_id" uuid,
	"run_id" uuid,
	"trigger" jsonb NOT NULL,
	"status" "feedback_fix_status" NOT NULL,
	"pr_comment_id" bigint,
	"commit_sha" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_spec_pull_requests" (
	"github_repo_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"repo_spec_id" uuid NOT NULL,
	"head_branch" text NOT NULL,
	"url" text NOT NULL,
	"state" "pull_request_state" DEFAULT 'open' NOT NULL,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_spec_pull_requests_github_repo_id_number_pk" PRIMARY KEY("github_repo_id","number")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"disabled_kinds" "notification_kind"[] DEFAULT '{}'::notification_kind[] NOT NULL,
	"quiet_hours_start_minute" integer,
	"quiet_hours_end_minute" integer,
	"time_zone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_quiet_hours_complete" CHECK (("notification_preferences"."quiet_hours_start_minute" IS NULL) = ("notification_preferences"."quiet_hours_end_minute" IS NULL)
        AND ("notification_preferences"."quiet_hours_start_minute" IS NULL OR "notification_preferences"."time_zone" IS NOT NULL)),
	CONSTRAINT "notification_preferences_quiet_hours_range" CHECK (("notification_preferences"."quiet_hours_start_minute" IS NULL OR "notification_preferences"."quiet_hours_start_minute" BETWEEN 0 AND 1439)
        AND ("notification_preferences"."quiet_hours_end_minute" IS NULL OR "notification_preferences"."quiet_hours_end_minute" BETWEEN 0 AND 1439))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"gate_id" uuid,
	"actor_member_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"desktop" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_credentials" (
	"runner_id" uuid NOT NULL,
	"credential" text NOT NULL,
	"max_concurrent_runs_override" integer,
	"rate_limited_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_credentials_runner_id_credential_pk" PRIMARY KEY("runner_id","credential"),
	CONSTRAINT "runner_credentials_override_positive" CHECK ("runner_credentials"."max_concurrent_runs_override" IS NULL OR "runner_credentials"."max_concurrent_runs_override" >= 1)
);
--> statement-breakpoint
CREATE TABLE "verification_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"verification_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"outcome" "verification_outcome" NOT NULL,
	"summary" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"judged_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_results_verification_id_criterion_id_unique" UNIQUE("verification_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" "verification_status" DEFAULT 'running' NOT NULL,
	"resolution" "verification_resolution",
	"resolved_by_member_id" uuid,
	"comment" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "verifications_attempt_positive" CHECK ("verifications"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "review_comments" ALTER COLUMN "path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ALTER COLUMN "line" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ALTER COLUMN "side" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD COLUMN "child_question_id" uuid;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "kind" "review_comment_kind" DEFAULT 'diff' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "selector" text;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "screenshot_blob_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "feedback_bot_allowlist" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_specs" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_specs" ADD COLUMN "committed_sha" text;--> statement-breakpoint
ALTER TABLE "repo_specs" ADD COLUMN "committed_blob_sha" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "origin" "run_origin" DEFAULT 'dispatch' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "credential" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "consult_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resumes_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD COLUMN "result_summary" text;--> statement-breakpoint
ALTER TABLE "draft_tasks" ADD COLUMN "batch_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "draft_tasks" ADD COLUMN "position" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_acceptance_criterion_id_acceptance_criteria_id_fk" FOREIGN KEY ("acceptance_criterion_id") REFERENCES "public"."acceptance_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collab_documents" ADD CONSTRAINT "collab_documents_repo_spec_id_repo_specs_id_fk" FOREIGN KEY ("repo_spec_id") REFERENCES "public"."repo_specs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_consult_run_id_runs_id_fk" FOREIGN KEY ("consult_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_run_id_runs_id_fk" FOREIGN KEY ("author_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_questions" ADD CONSTRAINT "child_questions_child_run_id_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_questions" ADD CONSTRAINT "child_questions_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_questions" ADD CONSTRAINT "child_questions_answered_by_run_id_runs_id_fk" FOREIGN KEY ("answered_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_questions" ADD CONSTRAINT "child_questions_answered_by_member_id_members_id_fk" FOREIGN KEY ("answered_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orbis_tool_calls" ADD CONSTRAINT "orbis_tool_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_fixes" ADD CONSTRAINT "feedback_fixes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_fixes" ADD CONSTRAINT "feedback_fixes_previous_run_id_runs_id_fk" FOREIGN KEY ("previous_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_fixes" ADD CONSTRAINT "feedback_fixes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_spec_pull_requests" ADD CONSTRAINT "repo_spec_pull_requests_repo_spec_id_repo_specs_id_fk" FOREIGN KEY ("repo_spec_id") REFERENCES "public"."repo_specs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_spec_pull_requests" ADD CONSTRAINT "repo_spec_pull_requests_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_credentials" ADD CONSTRAINT "runner_credentials_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_criterion_id_acceptance_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."acceptance_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_judged_by_run_id_runs_id_fk" FOREIGN KEY ("judged_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_resolved_by_member_id_members_id_fk" FOREIGN KEY ("resolved_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mentions_task_id_idx" ON "mentions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "mentions_member_id_idx" ON "mentions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "task_comments_task_id_idx" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_notes_task_id_idx" ON "task_notes" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "child_questions_parent_run_id_open_idx" ON "child_questions" USING btree ("parent_run_id") WHERE "child_questions"."answered_at" IS NULL;--> statement-breakpoint
CREATE INDEX "child_questions_child_run_id_idx" ON "child_questions" USING btree ("child_run_id");--> statement-breakpoint
CREATE INDEX "orbis_tool_calls_run_id_idx" ON "orbis_tool_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "orbis_tool_calls_pending_idx" ON "orbis_tool_calls" USING btree ("run_id") WHERE "orbis_tool_calls"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "feedback_batches_due_at_idx" ON "feedback_batches" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "feedback_fixes_pr_idx" ON "feedback_fixes" USING btree ("github_repo_id","pr_number","created_at");--> statement-breakpoint
CREATE INDEX "feedback_fixes_run_id_idx" ON "feedback_fixes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "feedback_fixes_task_id_idx" ON "feedback_fixes" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "repo_spec_pull_requests_repo_spec_id_idx" ON "repo_spec_pull_requests" USING btree ("repo_spec_id");--> statement-breakpoint
CREATE INDEX "notifications_member_id_created_at_idx" ON "notifications" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_member_id_unread_idx" ON "notifications" USING btree ("member_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_member_id_desktop_idx" ON "notifications" USING btree ("member_id","created_at") WHERE "notifications"."desktop";--> statement-breakpoint
CREATE INDEX "verifications_run_id_idx" ON "verifications" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "verifications_task_id_idx" ON "verifications" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD CONSTRAINT "needs_you_items_child_question_id_child_questions_id_fk" FOREIGN KEY ("child_question_id") REFERENCES "public"."child_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_screenshot_blob_id_blobs_id_fk" FOREIGN KEY ("screenshot_blob_id") REFERENCES "public"."blobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_consult_of_run_id_runs_id_fk" FOREIGN KEY ("consult_of_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_resumes_run_id_runs_id_fk" FOREIGN KEY ("resumes_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_resumes_run_id_idx" ON "runs" USING btree ("resumes_run_id");--> statement-breakpoint
CREATE INDEX "draft_tasks_batch_id_idx" ON "draft_tasks" USING btree ("batch_id","position");--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD CONSTRAINT "needs_you_items_child_question_has_id" CHECK ("needs_you_items"."kind"::text <> 'child_question' OR "needs_you_items"."child_question_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_kind_fields" CHECK (("review_comments"."kind" = 'diff' AND "review_comments"."path" IS NOT NULL AND "review_comments"."line" IS NOT NULL AND "review_comments"."side" IS NOT NULL AND "review_comments"."url" IS NULL AND "review_comments"."selector" IS NULL AND "review_comments"."screenshot_blob_id" IS NULL)
        OR ("review_comments"."kind" = 'preview' AND "review_comments"."url" IS NOT NULL AND "review_comments"."path" IS NULL AND "review_comments"."line" IS NULL AND "review_comments"."side" IS NULL));--> statement-breakpoint
ALTER TABLE "draft_tasks" ADD CONSTRAINT "draft_tasks_position_positive" CHECK ("draft_tasks"."position" >= 1);