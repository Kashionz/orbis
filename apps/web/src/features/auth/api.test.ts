import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMe, ME_PATH, UnauthorizedError } from "./api";

const me = {
  githubUserId: 1,
  githubLogin: "octocat",
  name: null,
  avatarUrl: null,
  member: null,
};

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchMe", () => {
  it("回傳經 MeResponse 驗證的登入狀態", async () => {
    const fetchMock = stubFetch(200, me);
    await expect(fetchMe()).resolves.toEqual(me);
    expect(fetchMock).toHaveBeenCalledWith(ME_PATH, expect.anything());
  });

  it("401 時丟出 UnauthorizedError", async () => {
    stubFetch(401, { error: "unauthorized" });
    await expect(fetchMe()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("其他錯誤狀態丟出一般錯誤", async () => {
    stubFetch(500, {});
    const error = await fetchMe().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
  });

  it("回應不符合 MeResponse 時丟出錯誤", async () => {
    stubFetch(200, { ...me, githubUserId: "1" });
    await expect(fetchMe()).rejects.toThrow();
  });
});
