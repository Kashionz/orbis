import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiRequest, errorMessage } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failWith(status: number, body: unknown): Promise<unknown> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status })),
  );
  return apiRequest("/api/x", z.unknown()).catch((e: unknown) => e);
}

describe("ApiError", () => {
  it("讀出契約 ApiError 的 issues 與 missing", async () => {
    const error = await failWith(409, {
      error: "invalid_transition",
      message: "還不能進入 Ready：尚未指定 Repo",
      missing: ["repo", "acceptance_criteria"],
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "invalid_transition", issues: [] });
    expect((error as ApiError).missing).toEqual(["repo", "acceptance_criteria"]);
  });

  it("回應不符合契約時只保留 HTTP 狀態碼", async () => {
    const error = await failWith(502, { unexpected: true });
    expect(error).toMatchObject({ status: 502, code: null, message: "HTTP 502" });
  });
});

describe("errorMessage", () => {
  it("Ready 條件不足時列出缺少的項目", () => {
    const error = new ApiError(
      409,
      "invalid_transition",
      "x",
      [],
      ["repo", "description", "acceptance_criteria"],
    );
    expect(errorMessage(error)).toBe(
      "還不能進入 Ready，缺少：指定 Repo、描述或 Spec、至少一條 Acceptance Criterion",
    );
  });

  it("驗證失敗時每個欄位的問題各一行", () => {
    const error = new ApiError(400, "invalid_input", "輸入格式不正確", [
      { path: ["permissionPolicy"], message: "Team Runner 不能使用 yolo" },
      { path: [], message: "至少要更新一個欄位" },
    ]);
    expect(errorMessage(error)).toBe(
      "輸入格式不正確\npermissionPolicy：Team Runner 不能使用 yolo\n至少要更新一個欄位",
    );
  });

  it("403 標示沒有權限", () => {
    expect(errorMessage(new ApiError(403, "forbidden", "需要 admin 以上的 Role"))).toBe(
      "沒有權限：需要 admin 以上的 Role",
    );
  });
});
