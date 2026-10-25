CREATE TYPE "public"."effort" AS ENUM('fast', 'std', 'deep');--> statement-breakpoint
CREATE TYPE "public"."local_merge_strategy" AS ENUM('squash', 'merge');--> statement-breakpoint
CREATE TYPE "public"."repo_kind" AS ENUM('github', 'local');--> statement-breakpoint
CREATE TYPE "public"."task_general_access" AS ENUM('invited', 'team_view', 'team_edit');--> statement-breakpoint
CREATE TYPE "public"."task_share_role" AS ENUM('owner', 'edit', 'view');--> statement-breakpoint
ALTER TYPE "public"."prompt_source" ADD VALUE 'handoff';--> statement-breakpoint
ALTER TYPE "public"."run_control_action" ADD VALUE 'withdraw_prompt';--> statement-breakpoint
ALTER TYPE "public"."run_control_action" ADD VALUE 'set_session_config';--> statement-breakpoint
ALTER TYPE "public"."run_control_action" ADD VALUE 'set_permission_policy';--> statement-breakpoint
ALTER TYPE "public"."run_control_action" ADD VALUE 'switch_agent';--> statement-breakpoint
ALTER TYPE "public"."run_control_action" ADD VALUE 'merge_local';--> statement-breakpoint
CREATE TABLE "preview_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"github_user_id" bigint,
	"github_login" text,
	"email" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	CONSTRAINT "preview_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "preview_invites_one_invitee" CHECK (("preview_invites"."github_user_id" IS NULL) <> ("preview_invites"."email" IS NULL)),
	CONSTRAINT "preview_invites_login_with_user_id" CHECK (("preview_invites"."github_user_id" IS NULL) = ("preview_invites"."github_login" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "run_agent_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"agent" text NOT NULL,
	"model" text,
	"effort" "effort",
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "run_agent_segments_run_id_position_unique" UNIQUE("run_id","position"),
	CONSTRAINT "run_agent_segments_position_positive" CHECK ("run_agent_segments"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "task_share_role" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by_member_id" uuid,
	"accepted_at" timestamp with time zone,
	"accepted_by_member_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "task_invites_role_not_owner" CHECK ("task_invites"."role" <> 'owner'),
	CONSTRAINT "task_invites_accepted_or_revoked" CHECK ("task_invites"."accepted_at" IS NULL OR "task_invites"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "task_members" (
	"task_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"role" "task_share_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_members_task_id_member_id_pk" PRIMARY KEY("task_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "terminal_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"member_id" uuid,
	"runner_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text
);
--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT "repos_project_id_github_owner_github_name_unique";--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "github_owner" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "stopped_run" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "local_merge_strategy" "local_merge_strategy" DEFAULT 'squash' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "local_push_base" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "kind" "repo_kind" DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "effort" "effort";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "general_access" "task_general_access" DEFAULT 'team_edit' NOT NULL;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "allow_external_preview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "allow_team_runner_terminal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_invites" ADD CONSTRAINT "preview_invites_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_invites" ADD CONSTRAINT "preview_invites_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_agent_segments" ADD CONSTRAINT "run_agent_segments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_invites" ADD CONSTRAINT "task_invites_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_invites" ADD CONSTRAINT "task_invites_invited_by_member_id_members_id_fk" FOREIGN KEY ("invited_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_invites" ADD CONSTRAINT "task_invites_accepted_by_member_id_members_id_fk" FOREIGN KEY ("accepted_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_members" ADD CONSTRAINT "task_members_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_members" ADD CONSTRAINT "task_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_invites_run_id_idx" ON "preview_invites" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_agent_segments_one_open_per_run" ON "run_agent_segments" USING btree ("run_id") WHERE "run_agent_segments"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_invites_task_id_idx" ON "task_invites" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_members_member_id_idx" ON "task_members" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_members_one_owner_per_task" ON "task_members" USING btree ("task_id") WHERE "task_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "terminal_sessions_run_id_idx" ON "terminal_sessions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "terminal_sessions_member_id_idx" ON "terminal_sessions" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_project_id_github_owner_github_name_unique" ON "repos" USING btree ("project_id","github_owner","github_name") WHERE "repos"."kind" = 'github';--> statement-breakpoint
CREATE UNIQUE INDEX "repos_project_id_local_name_unique" ON "repos" USING btree ("project_id","github_name") WHERE "repos"."kind" = 'local';--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_github_has_owner" CHECK (("repos"."kind" = 'github') = ("repos"."github_owner" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_local_has_no_github_ids" CHECK ("repos"."kind" = 'github' OR ("repos"."github_repo_id" IS NULL AND "repos"."github_installation_id" IS NULL));--> statement-breakpoint
-- 既有 Task 的擁有者是建立的人（ADR-0012）；建立者已被移除的 Task 沒有擁有者，由 Admin 管理分享。
INSERT INTO "task_members" ("task_id", "member_id", "role") SELECT "id", "created_by_member_id", 'owner' FROM "tasks" WHERE "created_by_member_id" IS NOT NULL;