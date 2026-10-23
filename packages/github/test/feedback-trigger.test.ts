// Feedback Loop 的觸發過濾與合併再送（ARCHITECTURE §5.2），以錄製的 webhook payload 為底。

import { describe, expect, it, vi } from "vitest";
import type { GitHubUserRef } from "../src/client/types";
import { LOOSE_COMMENT_DELAY_MS } from "../src/feedback/dispatch";
import { createWorld, HEAD_SHA, type World } from "./helpers/world";

const NEW_SHA = "fedcba9876543210fedcba9876543210fedcba98";

/** webhook 處理結果中的 Feedback Loop outcome。 */
async function outcome(w: World, event: string, payload: unknown) {
  const response = await w.deliver(event, payload);
  if (response.status !== 200 || !("result" in response.body)) {
    throw new Error(`webhook 沒有處理：${JSON.stringify(response)}`);
  }
  return response.body.result;
}

const coderabbit: GitHubUserRef = { id: 7001, login: "coderabbitai[bot]", type: "Bot" };
const otherBot: GitHubUserRef = { id: 7002, login: "random-bot[bot]", type: "Bot" };

describe("觸發來源的過濾", () => {
  it("有寫入權限的人送出 review：送回原 Run 修正", async () => {
    const w = createWorld();
    const { task, number } = await w.openPullRequest();
    const result = await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, {
        author: w.userRef(w.alice),
        body: "有兩個地方要改。",
        comments: [{ body: "標題維持原本的「計算機」。" }, { body: "縮排改成兩個空白。" }],
      }),
    );
    expect(result).toMatchObject({ kind: "queued", source: "review", flush: { kind: "sent" } });
    expect(w.feedbackRuns.requests).toHaveLength(1);
    expect(w.feedbackRuns.requests[0]).toMatchObject({
      taskId: task.id,
      previousRunId: "run-1",
      source: "review",
      pullRequestUrl: `${w.repo.htmlUrl}/pull/${number}`,
    });
  });

  it("沒有寫入權限的人（Team 外、只有 read 或 triage）的 review 與 PR 留言不觸發", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    for (const role of ["none", "read", "triage"] as const) {
      w.github.roles.set(w.outsider.login, role);
      expect(
        await outcome(
          w,
          "pull_request_review",
          w.reviewPayload(number, {
            author: w.outsider,
            body: "改一下",
            state: "changes_requested",
          }),
        ),
        role,
      ).toEqual({ kind: "ignored", reason: "no_write_permission" });
      expect(
        await outcome(
          w,
          "issue_comment",
          w.prCommentPayload(number, { author: w.outsider, body: "改" }),
        ),
      ).toEqual({ kind: "ignored", reason: "no_write_permission" });
    }
    expect(w.feedbackRuns.requests).toEqual([]);
    expect(await w.store.getFeedbackBatch(w.repo.id, number, "review")).toBeNull();
  });

  it("對 repo 沒有角色、但在 Project 中能編輯 Task 的 Member 可以觸發（與 Issue 同步同一套檢查）", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.github.roles.delete(w.alice.githubLogin);
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "請改" }),
    );
    expect(w.feedbackRuns.requests).toHaveLength(1);
  });

  it("不在白名單中的 bot 不觸發；白名單中的 bot 觸發（不分大小寫，不檢查寫入權限）", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.botAllowlist.push("CodeRabbitAI[bot]");
    expect(
      await outcome(
        w,
        "pull_request_review",
        w.reviewPayload(number, { author: otherBot, body: "nit" }),
      ),
    ).toEqual({ kind: "ignored", reason: "bot_not_allowlisted" });
    expect(
      await outcome(
        w,
        "issue_comment",
        w.prCommentPayload(number, { author: otherBot, body: "nit" }),
      ),
    ).toEqual({ kind: "ignored", reason: "bot_not_allowlisted" });
    expect(w.feedbackRuns.requests).toEqual([]);

    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: coderabbit, body: "建議處理 null 的情況。" }),
    );
    expect(w.feedbackRuns.requests).toHaveLength(1);
    expect(w.feedbackRuns.requests[0]?.prompt).toContain("建議處理 null 的情況。");
  });

  it("App 自己的留言（例如自動修正的紀錄）不觸發，就算 App 在白名單中", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.botAllowlist.push(w.bot.login);
    expect(
      await outcome(
        w,
        "issue_comment",
        w.prCommentPayload(number, { author: w.bot, body: "紀錄" }),
      ),
    ).toEqual({ kind: "ignored", reason: "own_app" });
  });

  it("approved 的 review 不觸發，就算附了留言", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    expect(
      await outcome(
        w,
        "pull_request_review",
        w.reviewPayload(number, {
          author: w.userRef(w.bob),
          state: "approved",
          body: "LGTM，順便改一下錯字",
          comments: [{ body: "typo" }],
        }),
      ),
    ).toEqual({ kind: "ignored", reason: "approved" });
    expect(w.feedbackRuns.requests).toEqual([]);
  });

  it("沒有內容的 review（沒有 body、沒有行內留言）不觸發", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    expect(
      await outcome(
        w,
        "pull_request_review",
        w.reviewPayload(number, { author: w.userRef(w.alice), body: null }),
      ),
    ).toEqual({ kind: "ignored", reason: "empty" });
  });

  it("不是以 App 開出的 PR、已經關閉的 PR 不觸發", async () => {
    const w = createWorld();
    expect(
      await outcome(
        w,
        "pull_request_review",
        w.reviewPayload(999, { author: w.userRef(w.alice), body: "改" }),
      ),
    ).toEqual({ kind: "ignored", reason: "not_linked" });

    const { number } = await w.openPullRequest();
    await w.deliver(
      "pull_request",
      w.pullRequestPayload("closed", number, { merged: false, sender: w.userRef(w.bob) }),
    );
    expect(
      await outcome(
        w,
        "pull_request_review",
        w.reviewPayload(number, { author: w.userRef(w.alice), body: "改" }),
      ),
    ).toEqual({ kind: "ignored", reason: "pr_not_open" });
  });

  it("Server 沒有提供 Feedback Loop 的依賴時一律略過", async () => {
    const w = createWorld({ feedback: false });
    const { number } = await w.openPullRequest();
    expect(
      await outcome(
        w,
        "pull_request_review",
        w.reviewPayload(number, { author: w.userRef(w.alice), body: "改" }),
      ),
    ).toEqual({ kind: "ignored", reason: "feedback_disabled" });
    expect(await outcome(w, "check_suite", w.checkSuitePayload(number))).toEqual({
      kind: "ignored",
      reason: "feedback_disabled",
    });
  });
});

describe("合併再送", () => {
  it("同一份 review 中的留言（含 review 本身的內容）合併成一批，在 review 送出時觸發", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, {
        author: w.userRef(w.alice),
        body: "整體可以，有兩個地方要改。",
        comments: [{ body: "第一則" }, { body: "第二則" }],
      }),
    );
    const [request] = w.feedbackRuns.requests;
    expect(w.feedbackRuns.requests).toHaveLength(1);
    expect(request?.prompt).toContain("整體可以，有兩個地方要改。");
    expect(request?.prompt).toContain("第一則");
    expect(request?.prompt).toContain("第二則");
    const [fix] = await w.store.listFeedbackFixes(w.repo.id, number);
    expect(fix?.trigger.items).toHaveLength(3);
  });

  it("changes_requested 的 review 就算只有一則留言也立刻觸發", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, {
        author: w.userRef(w.alice),
        state: "changes_requested",
        comments: [{ body: "這裡不對" }],
      }),
    );
    expect(w.feedbackRuns.requests).toHaveLength(1);
  });

  it("零散的單則留言：最後一則之後 2 分鐘才送出，期間的留言合併成一批", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    // GitHub 的「Add single comment」：只有一則行內留言、沒有內容的 commented review
    const first = await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), comments: [{ body: "第一則" }] }),
    );
    expect(first).toMatchObject({
      kind: "queued",
      items: 1,
      dueAt: new Date(w.clock.now().getTime() + LOOSE_COMMENT_DELAY_MS).toISOString(),
      flush: { kind: "nothing" },
    });

    w.clock.advance(60_000);
    await outcome(
      w,
      "issue_comment",
      w.prCommentPayload(number, { author: w.userRef(w.bob), body: "PR 對話中的第二則" }),
    );
    // 第一則的 2 分鐘到了，但時間窗從最後一則重新起算
    w.clock.advance(LOOSE_COMMENT_DELAY_MS - 60_000);
    expect(await w.integration.flushDueFeedback()).toEqual([]);
    expect(w.feedbackRuns.requests).toEqual([]);

    w.clock.advance(60_000 - 1);
    expect(await w.integration.flushDueFeedback()).toEqual([]);
    w.clock.advance(1);
    const flushed = await w.integration.flushDueFeedback();
    expect(flushed).toEqual([expect.objectContaining({ kind: "sent", source: "review" })]);
    expect(w.feedbackRuns.requests).toHaveLength(1);
    expect(w.feedbackRuns.requests[0]?.prompt).toContain("第一則");
    expect(w.feedbackRuns.requests[0]?.prompt).toContain("PR 對話中的第二則");
    // 送出後批次清空
    expect(await w.integration.flushDueFeedback()).toEqual([]);
  });

  it("零散留言還在等的時候送出完整的 review：一起送出", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    await outcome(
      w,
      "issue_comment",
      w.prCommentPayload(number, { author: w.userRef(w.bob), body: "先留一則" }),
    );
    w.clock.advance(30_000);
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "正式的 review" }),
    );
    expect(w.feedbackRuns.requests).toHaveLength(1);
    expect(w.feedbackRuns.requests[0]?.prompt).toContain("先留一則");
    expect(w.feedbackRuns.requests[0]?.prompt).toContain("正式的 review");
    expect(await w.store.getFeedbackBatch(w.repo.id, number, "review")).toBeNull();
  });

  it("同一則 webhook 重送不會重複觸發", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    const payload = w.reviewPayload(number, { author: w.userRef(w.alice), body: "改" });
    await w.deliver("pull_request_review", payload, { deliveryId: "same" });
    expect(await w.deliver("pull_request_review", payload, { deliveryId: "same" })).toEqual({
      status: 200,
      body: { ok: true, duplicate: true },
    });
    expect(w.feedbackRuns.requests).toHaveLength(1);
  });

  it("修正還沒 push 時，新的回饋先留著；修正 push 後自動送出", async () => {
    const w = createWorld();
    const { task, number } = await w.openPullRequest();
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "第一輪" }),
    );
    const second = await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "第二輪" }),
    );
    expect(second).toMatchObject({ kind: "queued", flush: { kind: "held" } });
    expect(w.feedbackRuns.requests).toHaveLength(1);
    // 到期也不送
    w.clock.advance(LOOSE_COMMENT_DELAY_MS);
    expect(await w.integration.flushDueFeedback()).toEqual([
      expect.objectContaining({ kind: "held" }),
    ]);

    // 第一輪的修正 push 了（Server 照常呼叫 onBranchPushed，runId 是修正的 Run）
    await w.integration.onBranchPushed({
      taskId: task.id,
      runId: "fix-run-1",
      branch: `feature/${task.key}`,
      commitSha: NEW_SHA,
    });
    expect(w.feedbackRuns.requests).toHaveLength(2);
    // 接續的是上一次修正的 Run
    expect(w.feedbackRuns.requests[1]).toMatchObject({ previousRunId: "fix-run-1" });
    expect(w.feedbackRuns.requests[1]?.prompt).toContain("第二輪");
    const fixes = await w.store.listFeedbackFixes(w.repo.id, number);
    expect(fixes.map((f) => [f.status, f.commitSha])).toEqual([
      ["pushed", NEW_SHA],
      ["sent", null],
    ]);
  });

  it("修正的 Run 沒有 push 就結束：紀錄標成失敗，送出累積的回饋", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "第一輪" }),
    );
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "第二輪" }),
    );
    const ended = await w.integration.onFeedbackRunEnded({ runId: "fix-run-1" });
    expect(ended).toMatchObject({ status: "failed", runId: "fix-run-1" });
    expect(w.feedbackRuns.requests).toHaveLength(2);
    // 不是 Feedback Loop 的 Run
    expect(await w.integration.onFeedbackRunEnded({ runId: "run-1" })).toBeNull();
  });

  it("Server 開不成 Run（例如 Runner 離線）：留下失敗的紀錄，不卡住之後的回饋", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.feedbackRuns.failNext("run_not_resumable", "Runner 離線");
    const first = await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "改" }),
    );
    expect(first).toMatchObject({ flush: { kind: "failed", message: "Runner 離線" } });
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "再改" }),
    );
    const fixes = await w.store.listFeedbackFixes(w.repo.id, number);
    expect(fixes.map((f) => f.status)).toEqual(["failed", "sent"]);
  });

  it("startFeedbackTimer 定時送出到期的批次", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    await outcome(
      w,
      "issue_comment",
      w.prCommentPayload(number, { author: w.userRef(w.alice), body: "零散留言" }),
    );
    w.clock.advance(LOOSE_COMMENT_DELAY_MS);
    const timer = w.integration.startFeedbackTimer(5);
    try {
      await vi.waitFor(() => expect(w.feedbackRuns.requests).toHaveLength(1));
    } finally {
      timer.stop();
    }
  });
});

describe("CI 失敗", () => {
  it("PR head 的 check suite 都完成且有失敗：合併失敗的 check 送出；沒有 check run 的 suite 不等", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.setChecks(HEAD_SHA, [
      { id: 1, name: "lint", conclusion: "success" },
      { id: 2, name: "test", conclusion: "failure" },
      { id: 3, name: "e2e", conclusion: "timed_out" },
    ]);
    const result = await outcome(w, "check_suite", w.checkSuitePayload(number));
    expect(result).toEqual([
      expect.objectContaining({
        kind: "queued",
        source: "ci",
        items: 2,
        flush: expect.objectContaining({ kind: "sent" }),
      }),
    ]);
    const [request] = w.feedbackRuns.requests;
    expect(request?.source).toBe("ci");
    expect(request?.prompt).toContain("`test`（failure）");
    expect(request?.prompt).toContain("`e2e`（timed_out）");
    expect(request?.prompt).not.toContain("`lint`");
  });

  it("全部通過、或只有 cancelled／skipped／neutral：不觸發", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.setChecks(HEAD_SHA, [
      { id: 1, name: "lint", conclusion: "success" },
      { id: 2, name: "deploy", conclusion: "cancelled" },
      { id: 3, name: "docs", conclusion: "skipped" },
      { id: 4, name: "bench", conclusion: "neutral" },
      { id: 5, name: "approve", conclusion: "action_required" },
    ]);
    expect(
      await outcome(w, "check_suite", w.checkSuitePayload(number, { conclusion: "success" })),
    ).toEqual([{ kind: "ignored", reason: "no_new_failures" }]);
    expect(
      await outcome(
        w,
        "check_run",
        w.checkRunPayload(number, { id: 2, name: "deploy", conclusion: "cancelled" }),
      ),
    ).toEqual({ kind: "ignored", reason: "no_new_failures" });
    expect(w.feedbackRuns.requests).toEqual([]);
  });

  it("不是 PR 目前 head 的結果不採用；PR 有新的 commit（synchronize）後以新的 head 為準", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.setChecks(NEW_SHA, [{ id: 1, name: "test", conclusion: "failure" }]);
    expect(await outcome(w, "check_suite", w.checkSuitePayload(number, { sha: NEW_SHA }))).toEqual([
      { kind: "ignored", reason: "not_head" },
    ]);

    // 有人直接 push 到 PR 的分支
    const sync = w.pullRequestPayload("opened", number, {
      merged: false,
      sender: w.userRef(w.bob),
    });
    (sync as { action: string }).action = "synchronize";
    (sync as { pull_request: { head: { sha: string } } }).pull_request.head.sha = NEW_SHA;
    expect(await outcome(w, "pull_request", sync)).toEqual({
      kind: "synchronized",
      headSha: NEW_SHA,
    });
    w.setChecks(HEAD_SHA, [{ id: 9, name: "test", conclusion: "failure" }]);
    expect(await outcome(w, "check_suite", w.checkSuitePayload(number))).toEqual([
      { kind: "ignored", reason: "not_head" },
    ]);
    await outcome(w, "check_suite", w.checkSuitePayload(number, { sha: NEW_SHA }));
    expect(w.feedbackRuns.requests).toHaveLength(1);
  });

  it("其他 check suite 還沒跑完時先等，最後一個完成時再送出", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.setChecks(HEAD_SHA, [{ id: 2, name: "test", conclusion: "failure" }], {
      extraSuites: [{ status: "in_progress", runs: 1 }],
    });
    expect(await outcome(w, "check_suite", w.checkSuitePayload(number))).toEqual([
      { kind: "ignored", reason: "waiting_for_checks" },
    ]);
    expect(w.feedbackRuns.requests).toEqual([]);

    w.setChecks(HEAD_SHA, [
      { id: 2, name: "test", conclusion: "failure" },
      { id: 3, name: "other-ci", conclusion: "failure", appSlug: "ci-0" },
    ]);
    await outcome(w, "check_suite", w.checkSuitePayload(number));
    expect(w.feedbackRuns.requests).toHaveLength(1);
    expect(w.feedbackRuns.requests[0]?.prompt).toContain("`other-ci`");
  });

  it("check_run 與 check_suite 都送到時，同一個失敗的 check 只觸發一次", async () => {
    const w = createWorld();
    const { number } = await w.openPullRequest();
    w.setChecks(HEAD_SHA, [{ id: 2, name: "test", conclusion: "failure" }]);
    await outcome(
      w,
      "check_run",
      w.checkRunPayload(number, { id: 2, name: "test", conclusion: "failure" }),
    );
    expect(await outcome(w, "check_suite", w.checkSuitePayload(number))).toEqual([
      { kind: "ignored", reason: "no_new_failures" },
    ]);
    expect(w.feedbackRuns.requests).toHaveLength(1);
  });

  it("同一個 PR 的 review 與 CI 都在等：先送 review，CI 的批次在新的 commit 之後作廢", async () => {
    const w = createWorld();
    const { task, number } = await w.openPullRequest();
    // 先有一次修正在進行中，讓兩種回饋都累積起來
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "第一輪" }),
    );
    w.setChecks(HEAD_SHA, [{ id: 2, name: "test", conclusion: "failure" }]);
    await outcome(w, "check_suite", w.checkSuitePayload(number));
    await outcome(
      w,
      "pull_request_review",
      w.reviewPayload(number, { author: w.userRef(w.alice), body: "第二輪" }),
    );
    expect(w.feedbackRuns.requests).toHaveLength(1);

    await w.integration.onBranchPushed({
      taskId: task.id,
      runId: "fix-run-1",
      branch: `feature/${task.key}`,
      commitSha: NEW_SHA,
    });
    expect(w.feedbackRuns.requests.map((r) => r.source)).toEqual(["review", "review"]);
    // 第二輪 push 之後，舊 commit 的 CI 批次作廢，不會送出
    await w.integration.onBranchPushed({
      taskId: task.id,
      runId: "fix-run-2",
      branch: `feature/${task.key}`,
      commitSha: "1".repeat(40),
    });
    expect(w.feedbackRuns.requests.map((r) => r.source)).toEqual(["review", "review"]);
    expect(await w.store.getFeedbackBatch(w.repo.id, number, "ci")).toBeNull();
  });
});
