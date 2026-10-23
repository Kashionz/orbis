// Repo Spec 提交到 repo（ARCHITECTURE §12.1）：開分支、commit、開 PR；PR merge 後更新版本。

import { NAMES } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { REPO_SPEC_PULL_REQUEST_MARKER } from "../src/markdown";
import { blobSha } from "../src/testing";
import { createWorld, PROJECT_ID, REPO_ID, type World } from "./helpers/world";

const SPEC_PATH = "docs/specs/Login Flow.md";
const DRAFT = "# 登入流程\n\n使用 GitHub OAuth。\n";

function withSpec(overrides: Parameters<World["repoSpecs"]["addSpec"]>[0] | object = {}) {
  const w = createWorld();
  const spec = w.repoSpecs.addSpec({
    id: "spec-1",
    repoId: REPO_ID,
    path: SPEC_PATH,
    ...overrides,
  });
  return { w, spec };
}

/** 第 `index` 次呼叫 `method` 時的輸入（第三個參數）。 */
function inputOf<T>(w: World, method: "putFile" | "createPullRequest", index = 0): T {
  const call = w.github.callsTo(method)[index];
  if (!call) throw new Error(`沒有呼叫 ${method}`);
  return call.args[2] as T;
}

async function commit(w: World, markdown = DRAFT, memberId?: string) {
  return w.integration.commitRepoSpec({
    repoSpecId: "spec-1",
    markdown,
    requesterMemberId: memberId ?? w.alice.id,
  });
}

/** 送出 PR 被 merge 的 webhook（PR 先在 FakeGitHub 上 merge）。 */
async function merge(w: World, number: number) {
  const mergeSha = w.github.humanMergePullRequest(w.repo.id, number);
  const payload = w.pullRequestPayload("closed", number, {
    merged: true,
    sender: w.userRef(w.bob),
  }) as { pull_request: Record<string, unknown> };
  payload.pull_request.merge_commit_sha = mergeSha;
  const response = await w.deliver("pull_request", payload);
  return { mergeSha, response };
}

describe("提交到 repo", () => {
  it("從 default branch 開分支、commit 草稿、以 App 身分開 PR", async () => {
    const { w } = withSpec();
    const result = await commit(w);
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ created: true, overwritesUpstreamChanges: false });
    expect(result.commitSha).not.toBeNull();

    const [branchCall] = w.github.callsTo("createBranch");
    const branch = branchCall?.args[2] as string;
    expect(branch).toMatch(new RegExp(`^${NAMES.productSlug}/spec/login-flow-[0-9a-f]{6}$`));
    expect(branchCall?.args[3]).toBe(w.github.branches.get(w.repo.id)?.get("main"));
    expect(w.github.fileAt(w.repo.id, branch, SPEC_PATH)).toBe(DRAFT);
    // default branch 不變
    expect(w.github.fileAt(w.repo.id, "main", SPEC_PATH)).toBeNull();

    const { message } = inputOf<{ message: string }>(w, "putFile");
    expect(message).toBe(
      `docs(spec): 更新 ${SPEC_PATH}\n\nCo-authored-by: Codertocat <${w.alice.githubUserId}+Codertocat@users.noreply.github.com>`,
    );

    const input = inputOf<{ title: string; body: string; head: string; base: string }>(
      w,
      "createPullRequest",
    );
    expect(input).toMatchObject({
      title: `docs(spec): 更新 ${SPEC_PATH}`,
      head: branch,
      base: "main",
    });
    expect(input.body.startsWith(REPO_SPEC_PULL_REQUEST_MARKER)).toBe(true);
    expect(input.body).toContain("目前的版本：v0（merge 後成為 v1）");
    expect(input.body).toContain("提交者：@Codertocat");

    expect(await w.store.findOpenRepoSpecPullRequest("spec-1")).toEqual({
      repoSpecId: "spec-1",
      githubRepoId: w.repo.id,
      number: result.pullRequest.number,
      url: result.pullRequest.url,
      headBranch: branch,
      state: "open",
      createdByMemberId: w.alice.id,
    });
  });

  it("指定 commit 訊息時使用它", async () => {
    const { w } = withSpec();
    await w.integration.commitRepoSpec({
      repoSpecId: "spec-1",
      markdown: DRAFT,
      requesterMemberId: w.alice.id,
      message: "docs(spec): 補上登入流程",
    });
    expect(inputOf<{ message: string }>(w, "putFile").message).toMatch(
      /^docs\(spec\): 補上登入流程\n\n/,
    );
  });

  it("這份 Spec 還有開著的 PR：在同一個分支上再 commit，沿用 PR", async () => {
    const { w } = withSpec();
    const first = await commit(w);
    const second = await commit(w, `${DRAFT}\n補充：登出也要處理。\n`, w.bob.id);
    if (!first.ok || !second.ok) throw new Error("提交失敗");
    expect(second).toMatchObject({ created: false, pullRequest: first.pullRequest });
    expect(w.github.callsTo("createBranch")).toHaveLength(1);
    expect(w.github.callsTo("createPullRequest")).toHaveLength(1);
    const puts = w.github.callsTo("putFile").map((c) => c.args[2] as { sha?: string });
    expect(puts).toHaveLength(2);
    expect(puts[1]?.sha).toBe(blobSha(DRAFT));
    const branch = (await w.store.findOpenRepoSpecPullRequest("spec-1"))?.headBranch ?? "";
    expect(w.github.fileAt(w.repo.id, branch, SPEC_PATH)).toContain("登出也要處理");
    // 第一次提交的人仍是 PR 的建立者
    expect((await w.store.findOpenRepoSpecPullRequest("spec-1"))?.createdByMemberId).toBe(
      w.alice.id,
    );
  });

  it("草稿和分支上的內容相同時不 commit（重複送出是安全的）", async () => {
    const { w } = withSpec();
    await commit(w);
    const again = await commit(w);
    expect(again).toMatchObject({ ok: true, created: false, commitSha: null });
    expect(w.github.callsTo("putFile")).toHaveLength(1);
  });

  it("更新 repo 中既有的 Spec 檔：帶上目前的 blob SHA", async () => {
    const { w } = withSpec();
    w.github.humanCommit(w.repo.id, "main", SPEC_PATH, "# 舊版\n");
    const result = await commit(w);
    expect(result).toMatchObject({ ok: true, overwritesUpstreamChanges: false });
    expect(inputOf<{ sha?: string }>(w, "putFile").sha).toBe(blobSha("# 舊版\n"));
  });

  it("repo 中的檔案在上一次提交之後被別人改過：照常開 PR，但警告會覆蓋那些修改", async () => {
    const { w } = withSpec({ version: 2, committedBlobSha: blobSha("# v2\n") });
    w.github.humanCommit(w.repo.id, "main", SPEC_PATH, "# 有人直接改了 main\n");
    const result = await commit(w);
    expect(result).toMatchObject({ ok: true, overwritesUpstreamChanges: true });
    const { body } = inputOf<{ body: string }>(w, "createPullRequest");
    expect(body).toContain("會覆蓋那些修改");
    expect(body).toContain("目前的版本：v2（merge 後成為 v3）");
  });

  it("沒有被改過時不警告", async () => {
    const { w } = withSpec({ version: 1, committedBlobSha: blobSha("# v1\n") });
    w.github.humanCommit(w.repo.id, "main", SPEC_PATH, "# v1\n");
    expect(await commit(w)).toMatchObject({ ok: true, overwritesUpstreamChanges: false });
  });
});

describe("PR merge 後更新版本", () => {
  it("merge：版本 +1，記錄 merge commit 與檔案的 blob SHA", async () => {
    const { w } = withSpec();
    const result = await commit(w);
    if (!result.ok) throw new Error(result.message);
    const { mergeSha, response } = await merge(w, result.pullRequest.number);
    expect(response).toMatchObject({
      status: 200,
      body: {
        result: {
          kind: "repo_spec",
          outcome: { kind: "merged", repoSpecId: "spec-1", version: 1 },
        },
      },
    });
    expect(w.repoSpecs.specs.get("spec-1")).toMatchObject({
      version: 1,
      committedSha: mergeSha,
      committedBlobSha: blobSha(DRAFT),
    });
    expect(
      (await w.store.findRepoSpecPullRequest(w.repo.id, result.pullRequest.number))?.state,
    ).toBe("merged");
    // 不會被當成 Task 的 PR 處理
    expect(w.domain.transitions).toEqual([]);

    // 同一則 merge 的 webhook 再送一次（不同 delivery）不會再 +1
    const again = w.pullRequestPayload("closed", result.pullRequest.number, {
      merged: true,
      sender: w.userRef(w.bob),
    });
    await w.deliver("pull_request", again);
    expect(w.repoSpecs.specs.get("spec-1")?.version).toBe(1);
  });

  it("merge 之後再提交：開新的分支與 PR，版本從 v1 開始，repo 中的檔案沒被改過所以不警告", async () => {
    const { w } = withSpec();
    const first = await commit(w);
    if (!first.ok) throw new Error(first.message);
    await merge(w, first.pullRequest.number);
    const second = await commit(w, `${DRAFT}第二版\n`);
    expect(second).toMatchObject({ ok: true, created: true, overwritesUpstreamChanges: false });
    expect(w.github.callsTo("createBranch")).toHaveLength(2);
    const { body } = inputOf<{ body: string }>(w, "createPullRequest", 1);
    expect(body).toContain("目前的版本：v1（merge 後成為 v2）");
  });

  it("沒有 merge 就關閉：版本不變；之後再提交開新的 PR", async () => {
    const { w } = withSpec();
    const first = await commit(w);
    if (!first.ok) throw new Error(first.message);
    w.github.humanClosePullRequest(w.repo.id, first.pullRequest.number);
    const response = await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", first.pullRequest.number, {
        merged: false,
        sender: w.userRef(w.bob),
      }),
    );
    expect(response).toMatchObject({
      body: { result: { kind: "repo_spec", outcome: { kind: "closed" } } },
    });
    expect(w.repoSpecs.specs.get("spec-1")?.version).toBe(0);
    const second = await commit(w);
    expect(second).toMatchObject({ ok: true, created: true });
    if (second.ok) expect(second.pullRequest.number).not.toBe(first.pullRequest.number);
  });

  it("PR 在 GitHub 上已經關閉、但沒收到 webhook：再提交時開新的 PR", async () => {
    const { w } = withSpec();
    const first = await commit(w);
    if (!first.ok) throw new Error(first.message);
    w.github.humanClosePullRequest(w.repo.id, first.pullRequest.number);
    const second = await commit(w, `${DRAFT}改\n`);
    expect(second).toMatchObject({ ok: true, created: true });
    expect(
      (await w.store.findRepoSpecPullRequest(w.repo.id, first.pullRequest.number))?.state,
    ).toBe("closed");
  });
});

describe("無法提交的情況", () => {
  it("不是這個 Project 的 Member、或不能編輯 Task（Viewer）：forbidden", async () => {
    const { w } = withSpec();
    const carol = w.domain.addMember(
      { id: "member-carol", githubUserId: 4004, githubLogin: "carol" },
      ["other-project"],
    );
    expect(await commit(w, DRAFT, carol.id)).toMatchObject({ ok: false, reason: "forbidden" });
    w.domain.viewerMemberIds.add(w.bob.id);
    expect(await commit(w, DRAFT, w.bob.id)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await commit(w, DRAFT, "no-such-member")).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect(w.github.callsTo("createBranch")).toEqual([]);
  });

  it("Repo Spec 不存在、Repo 沒有安裝 App、Server 沒有啟用：各自回傳原因", async () => {
    const { w } = withSpec();
    expect(
      await w.integration.commitRepoSpec({
        repoSpecId: "no-such-spec",
        markdown: DRAFT,
        requesterMemberId: w.alice.id,
      }),
    ).toMatchObject({ ok: false, reason: "spec_not_found" });

    await w.domain.updateRepoGitHubInfo(REPO_ID, { installationId: null });
    expect(await commit(w)).toMatchObject({ ok: false, reason: "repo_not_connected" });

    const disabled = createWorld({ repoSpecs: false });
    expect(await commit(disabled)).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("只能提交 repo 內 .github/ 以外的 .md 檔（App 有 contents 的寫入權限）", async () => {
    for (const path of [
      ".github/workflows/ci.md",
      ".GitHub/CODEOWNERS.md",
      "package.json",
      "docs/spec.md.sh",
      "../outside.md",
      "docs/../../x.md",
      "/abs/spec.md",
      "docs//spec.md",
      "docs\\spec.md",
    ]) {
      const w = createWorld();
      w.repoSpecs.addSpec({ id: "spec-1", repoId: REPO_ID, path });
      expect(await commit(w), path).toMatchObject({ ok: false, reason: "invalid_path" });
      expect(w.github.callsTo("putFile")).toEqual([]);
    }
    const w = createWorld();
    w.repoSpecs.addSpec({ id: "spec-1", repoId: REPO_ID, path: "SPEC.MD" });
    expect(await commit(w)).toMatchObject({ ok: true });
  });

  it("GitHub 回錯：github_error，不留下 PR 對應", async () => {
    const { w } = withSpec();
    w.github.failNext("createBranch");
    expect(await commit(w)).toMatchObject({ ok: false, reason: "github_error" });
    expect(await w.store.findOpenRepoSpecPullRequest("spec-1")).toBeNull();
    // 之後可以重試
    expect(await commit(w)).toMatchObject({ ok: true, created: true });
  });

  it("同一個 Project 的 Task PR 不受影響（不是 Spec PR 時照 Task 的規則處理）", async () => {
    const { w } = withSpec();
    const { task, number } = await w.openPullRequest({ projectId: PROJECT_ID });
    w.github.humanMergePullRequest(w.repo.id, number);
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: true, sender: w.userRef(w.bob) }),
    );
    expect(w.domain.task(task.id).status).toBe("done");
    expect(w.repoSpecs.merges).toEqual([]);
  });
});
