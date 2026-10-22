CREATE TYPE "public"."acceptance_criterion_kind" AS ENUM('command', 'agent', 'browser', 'manual');--> statement-breakpoint
CREATE TYPE "public"."delegation_mode" AS ENUM('consult', 'branch');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('offered', 'accepted', 'rejected', 'expired', 'completed');--> statement-breakpoint
CREATE TYPE "public"."gate_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."gate_kind" AS ENUM('plan', 'review');--> statement-breakpoint
CREATE TYPE "public"."needs_you_kind" AS ENUM('permission_request', 'gate', 'stopped_run');--> statement-breakpoint
CREATE TYPE "public"."permission_policy" AS ENUM('manual', 'auto', 'yolo');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'dispatched', 'starting', 'running', 'awaiting_permission', 'rate_limited', 'awaiting_gate', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."runner_kind" AS ENUM('local', 'team');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('backlog', 'ready', 'planning', 'plan_gate', 'running', 'verifying', 'review_gate', 'pr_open', 'done');--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"github_name" text,
	"github_avatar_url" text,
	"current_team_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "gates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" "gate_kind" NOT NULL,
	"subject" jsonb,
	"decision" "gate_decision",
	"decided_by_member_id" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gates_decision_complete" CHECK (("gates"."decision" IS NULL) = ("gates"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "needs_you_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"member_id" uuid,
	"kind" "needs_you_kind" NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"gate_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_member_id" uuid,
	"resolution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "needs_you_items_gate_has_gate_id" CHECK ("needs_you_items"."kind" <> 'gate' OR "needs_you_items"."gate_id" IS NOT NULL),
	CONSTRAINT "needs_you_items_run_kinds_have_run_id" CHECK ("needs_you_items"."kind" = 'gate' OR "needs_you_items"."run_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "project_member_roles" (
	"project_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_roles_project_id_member_id_pk" PRIMARY KEY("project_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"task_key_prefix" text NOT NULL,
	"next_task_number" integer DEFAULT 1 NOT NULL,
	"plan_gate_enabled" boolean DEFAULT true NOT NULL,
	"delegation_enabled" boolean DEFAULT true NOT NULL,
	"delegation_allowed_agents" text[],
	"forbid_self_approval" boolean DEFAULT false NOT NULL,
	"allow_member_team_runner_dispatch" boolean DEFAULT true NOT NULL,
	"default_permission_policy" "permission_policy" DEFAULT 'auto' NOT NULL,
	"verification_max_retries" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_team_id_task_key_prefix_unique" UNIQUE("team_id","task_key_prefix"),
	CONSTRAINT "projects_next_task_number_positive" CHECK ("projects"."next_task_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "repo_specs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"path" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_specs_repo_id_path_unique" UNIQUE("repo_id","path")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"github_owner" text NOT NULL,
	"github_name" text NOT NULL,
	"github_repo_id" bigint,
	"default_branch" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_project_id_github_owner_github_name_unique" UNIQUE("project_id","github_owner","github_name")
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"media_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	CONSTRAINT "blobs_size_non_negative" CHECK ("blobs"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"status" "dispatch_status" DEFAULT 'offered' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_events_seq_positive" CHECK ("run_events"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"parent_run_id" uuid,
	"delegation_mode" "delegation_mode",
	"agent" text NOT NULL,
	"model" text,
	"permission_policy" "permission_policy" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"target" "runner_kind" NOT NULL,
	"requested_by_member_id" uuid,
	"runner_id" uuid,
	"worktree_path" text,
	"branch" text,
	"base_commit" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_child_has_delegation_mode" CHECK ("runs"."parent_run_id" IS NULL OR "runs"."delegation_mode" IS NOT NULL),
	CONSTRAINT "runs_not_own_parent" CHECK ("runs"."parent_run_id" IS NULL OR "runs"."parent_run_id" <> "runs"."id")
);
--> statement-breakpoint
CREATE TABLE "agent_availabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"runner_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"credential" text NOT NULL,
	"max_concurrency" integer NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"details" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_availabilities_runner_id_agent_credential_unique" UNIQUE("runner_id","agent","credential"),
	CONSTRAINT "agent_availabilities_max_concurrency_positive" CHECK ("agent_availabilities"."max_concurrency" >= 1)
);
--> statement-breakpoint
CREATE TABLE "runner_pairing_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"member_id" uuid,
	"kind" "runner_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_member_id" uuid,
	"expires_at" timestamp with time zone,
	"used_by_runner_id" uuid,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_pairing_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "runner_pairing_tokens_kind_binding" CHECK (("runner_pairing_tokens"."kind" = 'local') = ("runner_pairing_tokens"."member_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"member_id" uuid,
	"kind" "runner_kind" NOT NULL,
	"name" text NOT NULL,
	"runner_version" text NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_connected_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "runners_kind_binding" CHECK (("runners"."kind" = 'local') = ("runners"."member_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "acceptance_criteria" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "acceptance_criterion_kind" NOT NULL,
	"description" text NOT NULL,
	"command" text,
	"passed" boolean,
	"evidence" jsonb,
	"checked_at" timestamp with time zone,
	"checked_by_member_id" uuid,
	"checked_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acceptance_criteria_command_required" CHECK ("acceptance_criteria"."kind" <> 'command' OR "acceptance_criteria"."command" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "draft_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"proposed_by_run_id" uuid,
	"repo_id" uuid,
	"spec" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed_task_id" uuid,
	"confirmed_by_member_id" uuid,
	"confirmed_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_tasks_confirmed_or_dismissed" CHECK ("draft_tasks"."confirmed_at" IS NULL OR "draft_tasks"."dismissed_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependencies_not_self" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"key" text NOT NULL,
	"repo_id" uuid,
	"repo_spec_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "task_status" DEFAULT 'backlog' NOT NULL,
	"assignee_member_id" uuid,
	"created_by_member_id" uuid,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"plan_gate_enabled" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_project_id_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "tasks_project_id_key_unique" UNIQUE("project_id","key"),
	CONSTRAINT "tasks_number_positive" CHECK ("tasks"."number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_team_id_github_user_id_unique" UNIQUE("team_id","github_user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_current_team_id_teams_id_fk" FOREIGN KEY ("current_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_decided_by_member_id_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD CONSTRAINT "needs_you_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD CONSTRAINT "needs_you_items_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD CONSTRAINT "needs_you_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD CONSTRAINT "needs_you_items_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD CONSTRAINT "needs_you_items_gate_id_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."gates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs_you_items" ADD CONSTRAINT "needs_you_items_resolved_by_member_id_members_id_fk" FOREIGN KEY ("resolved_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member_roles" ADD CONSTRAINT "project_member_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member_roles" ADD CONSTRAINT "project_member_roles_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_specs" ADD CONSTRAINT "repo_specs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_requested_by_member_id_members_id_fk" FOREIGN KEY ("requested_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_availabilities" ADD CONSTRAINT "agent_availabilities_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairing_tokens" ADD CONSTRAINT "runner_pairing_tokens_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairing_tokens" ADD CONSTRAINT "runner_pairing_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairing_tokens" ADD CONSTRAINT "runner_pairing_tokens_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pairing_tokens" ADD CONSTRAINT "runner_pairing_tokens_used_by_runner_id_runners_id_fk" FOREIGN KEY ("used_by_runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_checked_by_member_id_members_id_fk" FOREIGN KEY ("checked_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_checked_by_run_id_runs_id_fk" FOREIGN KEY ("checked_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_tasks" ADD CONSTRAINT "draft_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_tasks" ADD CONSTRAINT "draft_tasks_proposed_by_run_id_runs_id_fk" FOREIGN KEY ("proposed_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_tasks" ADD CONSTRAINT "draft_tasks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_tasks" ADD CONSTRAINT "draft_tasks_confirmed_task_id_tasks_id_fk" FOREIGN KEY ("confirmed_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_tasks" ADD CONSTRAINT "draft_tasks_confirmed_by_member_id_members_id_fk" FOREIGN KEY ("confirmed_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_spec_id_repo_specs_id_fk" FOREIGN KEY ("repo_spec_id") REFERENCES "public"."repo_specs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_member_id_members_id_fk" FOREIGN KEY ("assignee_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_github_user_id_idx" ON "sessions" USING btree ("github_user_id");--> statement-breakpoint
CREATE INDEX "gates_task_id_idx" ON "gates" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "needs_you_items_member_id_open_idx" ON "needs_you_items" USING btree ("member_id") WHERE "needs_you_items"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "needs_you_items_project_id_open_idx" ON "needs_you_items" USING btree ("project_id") WHERE "needs_you_items"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "blobs_run_id_idx" ON "blobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "blobs_expires_at_idx" ON "blobs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "dispatches_run_id_idx" ON "dispatches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "dispatches_runner_id_status_idx" ON "dispatches" USING btree ("runner_id","status");--> statement-breakpoint
CREATE INDEX "runs_task_id_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_parent_run_id_idx" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runners_team_id_idx" ON "runners" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "runners_member_id_idx" ON "runners" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "acceptance_criteria_task_id_idx" ON "acceptance_criteria" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "draft_tasks_project_id_idx" ON "draft_tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_depends_on_task_id_idx" ON "task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE INDEX "tasks_project_id_status_idx" ON "tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "tasks_assignee_member_id_idx" ON "tasks" USING btree ("assignee_member_id");--> statement-breakpoint
CREATE INDEX "members_github_user_id_idx" ON "members" USING btree ("github_user_id");