// 第 1 波實作時補的契約：本機合併被擋下後的重試（ADR-0013）。
// sessions 的已驗證 email 只在 Server 的 DB，不經過 API。

import { describe, expect, it } from "vitest";
import { API_ROUTES, apiPath, LocalMergeRetryRequested } from "../src";

const ID = "0192f0c4-7b1a-7c3e-9a51-3f1d2c4b5a6e";

describe("local-repo：本機合併重試", () => {
  it("路由在 /api 之下，參數可以代入", () => {
    expect(API_ROUTES.runMergeLocal.startsWith("/api/")).toBe(true);
    expect(apiPath(API_ROUTES.runMergeLocal, { runId: ID })).toBe(`/api/runs/${ID}/merge-local`);
  });

  it("回應帶送出的 control id", () => {
    expect(LocalMergeRetryRequested.parse({ controlId: ID })).toEqual({ controlId: ID });
    expect(LocalMergeRetryRequested.safeParse({}).success).toBe(false);
  });
});
