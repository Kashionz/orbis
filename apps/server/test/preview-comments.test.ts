// Review Gate 退回時的 Preview 留言（ARCHITECTURE §13）：網址必須是這個 Run 的 Preview 網址
// （`<scheme>://<run-id>.<Preview 網域>/`），截圖必須是這個 Run 的 blob；留言與截圖打包進同一個 prompt。

import { Gate } from "@orbis/api-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blobs } from "../src/db/schema";
import { previewShareUrl } from "../src/preview/domain";
import { expectContract, resetDatabase } from "./helpers/api";
import { createTestDatabase, dbSkipReason, type TestDatabase } from "./helpers/db";
import {
  AWAITING_REVIEW,
  control,
  type Flow,
  openGate,
  RUN_DIFF,
  type StartedRun,
  startFlow,
  startRun,
} from "./helpers/flow";

const PREVIEW_DOMAIN = "preview.test:4500";
const OTHER_RUN_ID = "0192f3a0-0000-7000-8000-0000000000ff";

describe.skipIf(dbSkipReason !== null)("Preview 留言", () => {
  let database: TestDatabase;
  let flow: Flow;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  afterEach(async () => {
    await flow.close();
  });

  async function openReviewGate(started: StartedRun) {
    await started.send(RUN_DIFF);
    await started.send(AWAITING_REVIEW);
    await started.mine.answerVerification(started.offer.dispatch_id, started.run.id);
    return openGate(flow, started.task.id);
  }

  const reject = (gateId: string, url: string, screenshotBlobId: string | null = null) =>
    flow.as("member").post(`/api/gates/${gateId}/decision`, {
      action: "reject",
      previewComments: [{ body: "按鈕歪了", url, selector: "#login", screenshotBlobId }],
    });

  describe("有設定 Preview 網域", () => {
    beforeEach(async () => {
      await resetDatabase(database.db);
      flow = await startFlow(database.db, {}, { previewDomain: PREVIEW_DOMAIN });
    });

    it("這個 Run 的 Preview 網址：留言與截圖打包進 prompt", async () => {
      const started = await startRun(flow);
      const gate = await openReviewGate(started);
      const [blob] = await database.db
        .insert(blobs)
        .values({
          sha256: "e".repeat(64),
          size: 10,
          mediaType: "image/png",
          storageKey: "screenshot",
          runId: started.run.id,
        })
        .returning();
      const url = `${previewShareUrl(started.run.id, { scheme: "http", host: PREVIEW_DOMAIN })}login`;
      const res = await reject(gate.id, url, blob?.id ?? null);
      expect(res.status).toBe(200);
      expect(expectContract(Gate, res.body).previewComments).toMatchObject([
        { url, selector: "#login", screenshotBlobId: blob?.id, body: "按鈕歪了" },
      ]);
      await control(started.mine, "gate_result");
      const prompt = await control(started.mine, "prompt");
      if (prompt.action !== "prompt") throw new Error("unreachable");
      expect((prompt.prompt[0] as { text: string }).text).toContain(
        `${url}（#login）（截圖 1）：按鈕歪了`,
      );
      expect(prompt.prompt[1]).toMatchObject({ type: "image", blob_id: blob?.id });
    });

    it("不是這個 Run 的 Preview 網址、scheme 不同、或截圖不是這個 Run 的：422", async () => {
      const started = await startRun(flow);
      const gate = await openReviewGate(started);
      const runId = started.run.id;
      for (const url of [
        `http://${OTHER_RUN_ID}.${PREVIEW_DOMAIN}/`,
        `https://${runId}.${PREVIEW_DOMAIN}/`,
        `http://${runId}.preview.evil.test:4500/`,
        `http://${runId}.preview.test.evil.test:4500/`,
        `http://x.${runId}.${PREVIEW_DOMAIN}/`,
      ]) {
        expect((await reject(gate.id, url)).status, url).toBe(422);
      }
      const [otherBlob] = await database.db
        .insert(blobs)
        .values({ sha256: "f".repeat(64), size: 1, mediaType: "image/png", storageKey: "x" })
        .returning();
      const ok = previewShareUrl(runId, { scheme: "http", host: PREVIEW_DOMAIN });
      expect((await reject(gate.id, ok, otherBlob?.id ?? null)).status).toBe(422);
      // 網址的 host 不分大小寫。
      expect((await reject(gate.id, ok.toUpperCase().replace("HTTP://", "http://"))).status).toBe(
        200,
      );
    });
  });

  it("沒有設定 Preview 網域時不接受 Preview 留言", async () => {
    await resetDatabase(database.db);
    flow = await startFlow(database.db);
    const started = await startRun(flow);
    const gate = await openReviewGate(started);
    const url = `http://${started.run.id}.${PREVIEW_DOMAIN}/`;
    expect((await reject(gate.id, url)).status).toBe(422);
  });
});
