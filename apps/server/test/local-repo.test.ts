// 本機 Repo（ADR-0013）：登記、派工選項與 DispatchOffer、核准後的本機合併（成功、被擋下與重試）、
// 合併後轉 Done 並封存、Repo Spec 經由 Local Runner 提交、不進 GitHub 整合。

import {
  API_ROUTES,
  apiPath,
  DispatchOptions,
  Gate,
  LocalMergeRetryRequested,
  NeedsYouListResponse,
  Notification,
  Repo,
  RepoSpecCommitResponse,
} from "@orbis/api-contract";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentAvailabilities, notifications, repoSpecs } from "../src/db/schema";
import { GitHubDomainService } from "../src/domain/github-domain";
import { expectContract, seedReadyTask } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_REVIEW,
  control,
  type Flow,
  RUN_DIFF,
  type StartedRun,
  startFlow,
  startRun,
  taskRow,
} from "./helpers/flow";
import { type MockRunner, waitUntil } from "./helpers/runner-harness";

const LOCAL = "my-notes";

describe.skipIf(dbSkipReason !== null)("本機 Repo", () => {
  let database: TestDatabase;
  let flow: Flow;
  let localRepoId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    flow = await startFlow(database.db);
    const res = await flow
      .as("admin")
      .post(apiPath(API_ROUTES.projectRepos, { projectId: flow.project.id }), {
        kind: "local",
        name: LOCAL,
        defaultBranch: "trunk",
      });
    expect(res.status).toBe(201);
    localRepoId = expectContract(Repo, res.body).id;
  });

  afterEach(async () => {
    await flow?.close();
  });

  /** Member 的 Local Runner，runner.toml 有對應（或沒有對應）這個本機 Repo。 */
  async function localRunner(mapped: boolean): Promise<MockRunner> {
    const runner = await flow.h.pairRunner(flow.team.members.member, "local");
    runner.availability([{ id: "claude-code" }], mapped ? [LOCAL] : []);
    await waitUntil(async () => {
      const rows = await flow.db
        .select({ details: agentAvailabilities.details })
        .from(agentAvailabilities)
        .where(eq(agentAvailabilities.runnerId, runner.runnerId));
      return rows.some(
        (r) =>
          ((r.details as { mappedRepos?: string[] }).mappedRepos ?? []).includes(LOCAL) === mapped,
      );
    });
    return runner;
  }

  async function atReviewGate(): Promise<{ started: StartedRun; gate: z.infer<typeof Gate> }> {
    const runner = await localRunner(true);
    const started = await startRun(flow, { runner, task: { repoId: localRepoId } });
    await started.send(RUN_DIFF);
    await started.send(AWAITING_REVIEW);
    await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
    const list = await flow.as("viewer").get(`/api/tasks/${started.task.id}/gates`);
    const gate = expectContract(z.array(Gate), list.body).find((g) => g.decision === null);
    if (!gate) throw new Error("沒有等待中的 Gate");
    return { started, gate };
  }

  it("登記：只有名稱，沒有 owner 與 GitHub 狀態；同名 409 repo_exists；名稱檢查", async () => {
    const list = await flow
      .as("viewer")
      .get(apiPath(API_ROUTES.projectRepos, { projectId: flow.project.id }));
    const local = expectContract(z.array(Repo), list.body).find((r) => r.id === localRepoId);
    expect(local).toMatchObject({
      kind: "local",
      owner: null,
      github: null,
      name: LOCAL,
      defaultBranch: "trunk",
    });
    const dup = await flow
      .as("admin")
      .post(apiPath(API_ROUTES.projectRepos, { projectId: flow.project.id }), {
        kind: "local",
        name: LOCAL,
      });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: "repo_exists" });
    const bad = await flow
      .as("admin")
      .post(apiPath(API_ROUTES.projectRepos, { projectId: flow.project.id }), {
        kind: "local",
        name: "CON",
      });
    expect(bad.status).toBe(400);
    expect(
      (
        await flow
          .as("member")
          .post(apiPath(API_ROUTES.projectRepos, { projectId: flow.project.id }), {
            kind: "local",
            name: "x",
          })
      ).status,
    ).toBe(403);
  });

  it("派工選項：Team Runner 不能選；Local Runner 沒有對應時 repo_not_mapped；DispatchOffer 是本機 Repo 的形狀", async () => {
    await flow.h.pairRunner(flow.team.members.admin, "team");
    const runner = await localRunner(false);
    const task = await seedReadyTask(flow.db, flow.project, localRepoId);
    const path = `${apiPath(API_ROUTES.projectDispatchOptions, { projectId: flow.project.id })}?taskId=${task.id}`;
    const before = expectContract(DispatchOptions, (await flow.as("member").get(path)).body);
    expect(before.team).toBeNull();
    expect(before.local?.unavailableReason).toBe("repo_not_mapped");
    const withoutTask = expectContract(
      DispatchOptions,
      (
        await flow
          .as("member")
          .get(apiPath(API_ROUTES.projectDispatchOptions, { projectId: flow.project.id }))
      ).body,
    );
    expect(withoutTask.team).not.toBeNull();

    runner.availability([{ id: "claude-code" }], [LOCAL]);
    await waitUntil(async () => {
      const after = expectContract(DispatchOptions, (await flow.as("member").get(path)).body);
      return after.local?.unavailableReason === null;
    });

    const team = await flow
      .as("member")
      .post(`/api/tasks/${task.id}/runs`, { agent: "claude-code", runnerKind: "team" });
    expect(team.status).toBe(422);
    const created = await flow.as("member").post<{ id: string }>(`/api/tasks/${task.id}/runs`, {
      agent: "claude-code",
      runnerKind: "local",
    });
    await flow.h.ctx.services.dispatcher.kick();
    const offer = await runner.next("dispatch_offer", (o) => o.run_id === created.body.id);
    expect(offer.repo).toEqual({
      kind: "local",
      name: LOCAL,
      default_branch: "trunk",
      base_ref: "trunk",
    });
  });

  it("沒有對應的 Local Runner 時不派工", async () => {
    const runner = await localRunner(false);
    const task = await seedReadyTask(flow.db, flow.project, localRepoId);
    const created = await flow.as("member").post<{ id: string }>(`/api/tasks/${task.id}/runs`, {
      agent: "claude-code",
      runnerKind: "local",
    });
    await flow.h.ctx.services.dispatcher.kick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runner.pending("dispatch_offer").filter((o) => o.run_id === created.body.id)).toEqual(
      [],
    );
  });

  it("核准後送 merge_local（Project 的設定）；Task 留在 Review Gate；local_merged 後轉 Done、Run 結束後封存", async () => {
    await flow.as("admin").patch(apiPath(API_ROUTES.project, { projectId: flow.project.id }), {
      policy: { localMergeStrategy: "merge", localPushBase: true },
    });
    const { started, gate } = await atReviewGate();
    const approve = await flow
      .as("member")
      .post(`/api/gates/${gate.id}/decision`, { action: "approve" });
    expect(approve.status).toBe(200);
    expect(await control(started.mine, "gate_result")).toMatchObject({ decision: "approved" });
    const merge = await control(started.mine, "merge_local");
    expect(merge).toMatchObject({ strategy: "merge", push_base: true });
    expect((await taskRow(flow.db, started.task.id)).status).toBe("review_gate");
    expect(started.mine.pending("run_control").some((f) => f.action === "push_branch")).toBe(false);

    await started.send({
      kind: "local_merged",
      commit_sha: "c".repeat(40),
      base_branch: "trunk",
      pushed: true,
    });
    const done = await taskRow(flow.db, started.task.id);
    expect(done).toMatchObject({ status: "done", doneReason: "completed" });
    await started.send({ kind: "status_changed", status: "completed", gate: null, message: null });
    const archive = await started.mine.next("run_control", (f) => f.action === "archive");
    expect(archive.run_id).toBe(started.run.id);
  });

  it("合併被擋下：停下來的 Run（local_merge_blocked）、通知帶代碼；重試重送 merge_local；沒有被擋下時 409", async () => {
    const { started, gate } = await atReviewGate();
    await flow.as("member").post(`/api/gates/${gate.id}/decision`, { action: "approve" });
    await control(started.mine, "gate_result");
    await control(started.mine, "merge_local", {
      outcome: "rejected",
      reason: "failed",
      message: "error: Your local changes would be overwritten",
    });
    await waitUntil(async () => {
      const items = expectContract(
        NeedsYouListResponse,
        (await flow.as("member").get(API_ROUTES.needsYou)).body,
      );
      return items.some((i) => i.kind === "stopped_run");
    });
    const items = expectContract(
      NeedsYouListResponse,
      (await flow.as("member").get(API_ROUTES.needsYou)).body,
    );
    expect(items.find((i) => i.kind === "stopped_run")).toMatchObject({
      reasonCode: "local_merge_blocked",
      attempt: null,
      detail: "error: Your local changes would be overwritten",
    });
    const [note] = await flow.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.kind, "run_stopped"), eq(notifications.runId, started.run.id)));
    const parsed = expectContract(Notification, {
      ...note,
      taskKey: started.task.key,
      readAt: null,
      createdAt: note?.createdAt.toISOString(),
    });
    expect(parsed.stoppedRun).toMatchObject({ reasonCode: "local_merge_blocked" });

    const path = apiPath(API_ROUTES.runMergeLocal, { runId: started.run.id });
    expect((await flow.as("viewer").post(path)).status).toBe(403);
    const retry = await flow.as("member").post(path);
    expect(retry.status).toBe(202);
    const sent = expectContract(LocalMergeRetryRequested, retry.body);
    const again = await started.mine.next("run_control", (f) => f.action === "merge_local");
    expect(again.control_id).toBe(sent.controlId);
    const after = expectContract(
      NeedsYouListResponse,
      (await flow.as("member").get(API_ROUTES.needsYou)).body,
    );
    expect(after.some((i) => i.kind === "stopped_run")).toBe(false);
    const twice = await flow.as("member").post(path);
    expect(twice.status).toBe(409);
  });

  it("Repo Spec：經由 Local Runner 直接 commit，版本加 1；內容沒變時不 commit；Runner 不在線 409", async () => {
    const runner = await localRunner(true);
    const [spec] = await flow.db
      .insert(repoSpecs)
      .values({ repoId: localRepoId, path: "docs/spec.md" })
      .returning();
    if (!spec) throw new Error("建立 Spec 失敗");
    const path = apiPath(API_ROUTES.repoSpecCommit, { repoSpecId: spec.id });
    const pending = flow.as("member").post(path, {});
    const frame = await runner.next("repo_spec_commit");
    expect(frame).toMatchObject({ repo: LOCAL, base_branch: "trunk", path: "docs/spec.md" });
    expect(frame.message).toContain("Co-authored-by:");
    runner.send({
      type: "repo_spec_commit_result",
      commit_id: frame.commit_id,
      outcome: "committed",
      commit_sha: "d".repeat(40),
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(expectContract(RepoSpecCommitResponse, res.body).localCommit).toEqual({
      commitSha: "d".repeat(40),
      changed: true,
    });
    const [after] = await flow.db.select().from(repoSpecs).where(eq(repoSpecs.id, spec.id));
    expect(after?.version).toBe(1);

    const second = flow.as("member").post(path, {});
    const frame2 = await runner.next("repo_spec_commit");
    runner.send({
      type: "repo_spec_commit_result",
      commit_id: frame2.commit_id,
      outcome: "unchanged",
      commit_sha: "d".repeat(40),
    });
    expect(expectContract(RepoSpecCommitResponse, (await second).body).localCommit?.changed).toBe(
      false,
    );

    const third = flow.as("member").post(path, {});
    const frame3 = await runner.next("repo_spec_commit");
    runner.send({
      type: "repo_spec_commit_result",
      commit_id: frame3.commit_id,
      outcome: "failed",
      reason: "working_tree_dirty",
      message: "dirty",
    });
    expect((await third).status).toBe(409);

    runner.close();
    await waitUntil(async () => !flow.h.ctx.services.hub.isOnline(runner.runnerId));
    const offline = await flow.as("member").post(path, {});
    expect(offline.body).toMatchObject({ error: "runner_offline" });
  });

  it("不進 GitHub 整合：GitHub 的 domain 查不到本機 Repo", async () => {
    const domain = new GitHubDomainService(flow.db, flow.h.ctx.services.lifecycle);
    expect(await domain.getRepo(localRepoId)).toBeNull();
    expect(await domain.listReposByFullName("", LOCAL)).toEqual([]);
  });
});
