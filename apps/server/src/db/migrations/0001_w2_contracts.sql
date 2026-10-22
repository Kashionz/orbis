CREATE TYPE "public"."github_webhook_delivery_status" AS ENUM('processing', 'completed');--> statement-breakpoint
CREATE TYPE "public"."pull_request_state" AS ENUM('open', 'closed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."review_comment_side" AS ENUM('old', 'new');--> statement-breakpoint
CREATE TYPE "public"."run_control_action" AS ENUM('cancel', 'prompt', 'permission_response', 'gate_result', 'push_branch');--> statement-breakpoint
CREATE TYPE "public"."task_done_reason" AS ENUM('completed', 'not_planned');--> statement-breakpoint
CREATE TABLE "review_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gate_id" uuid NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"side" "review_comment_side" NOT NULL,
	"body" text NOT NULL,
	"author_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_comments_line_positive" CHECK ("review_comments"."line" >= 1)
);
--> statement-breakpoint
CREATE TABLE "github_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"status" "github_webhook_delivery_status" NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"github_repo_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"repo_id" uuid NOT NULL,
	"head_branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"url" text NOT NULL,
	"state" "pull_request_state" DEFAULT 'open' NOT NULL,
	"ci_fix_count" integer DEFAULT 0 NOT NULL,
	"review_fix_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_github_repo_id_number_unique" UNIQUE("github_repo_id","number"),
	CONSTRAINT "pull_requests_fix_counts_nonnegative" CHECK ("pull_requests"."ci_fix_count" >= 0 AND "pull_requests"."review_fix_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_issue_links" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_id" bigint NOT NULL,
	"issue_url" text NOT NULL,
	"summary_comment_id" bigint,
	"summary_hash" text,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_controls" (
	"control_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"action" "run_control_action" NOT NULL,
	"payload" jsonb NOT NULL,
	"requested_by_member_id" uuid,
	"sent_at" timestamp with time zone,
	"outcome" text,
	"outcome_payload" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_controls_outcome_complete" CHECK (("run_controls"."outcome" IS NULL) = ("run_controls"."resolved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "gates" ADD COLUMN "assignee_member_id_at_creation" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_create_issues" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "github_installation_id" bigint;--> statement-breakpoint
ALTER TABLE "runner_pairing_tokens" ADD COLUMN "created_by_session_id" uuid;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "paired_session_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "done_reason" "task_done_reason";--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_issue_links" ADD CONSTRAINT "task_issue_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_issue_links" ADD CONSTRAINT "task_issue_links_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_controls" ADD CONSTRAINT "run_controls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_controls" ADD CONSTRAINT "run_controls_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_controls" ADD CONSTRAINT "run_controls_requested_by_member_id_members_id_fk" FOREIGN KEY ("requested_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_comments_gate_id_idx" ON "review_comments" USING btree ("gate_id");--> statement-breakpoint
CREATE INDEX "pull_requests_task_id_idx" ON "pull_requests" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_issue_links_github_repo_id_issue_number_idx" ON "task_issue_links" USING btree ("github_repo_id","issue_number");--> statement-breakpoint
CREATE INDEX "run_controls_run_id_idx" ON "run_controls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_controls_pending_idx" ON "run_controls" USING btree ("dispatch_id") WHERE "run_controls"."resolved_at" IS NULL;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_assignee_member_id_at_creation_members_id_fk" FOREIGN KEY ("assignee_member_id_at_creation") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairing_tokens" ADD CONSTRAINT "runner_pairing_tokens_created_by_session_id_sessions_id_fk" FOREIGN KEY ("created_by_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_paired_session_id_sessions_id_fk" FOREIGN KEY ("paired_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runners_paired_session_id_idx" ON "runners" USING btree ("paired_session_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_done_reason_only_when_done" CHECK ("tasks"."done_reason" IS NULL OR "tasks"."status" = 'done');