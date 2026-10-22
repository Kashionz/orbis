import type { NeedsYouItem } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { API_PATHS, createServerApi, UnauthorizedError } from "./server-api";

type Handler = (url: string, init: RequestInit) => Response;

function fakeFetch(handler: Handler) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchFn, requests };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const gate: NeedsYouItem = {
  kind: "gate",
  id: "n1",
  memberId: "m1",
  taskId: "t1",
  taskKey: "ORB-12",
  runId: "r1",
  createdAt: "2026-10-23T00:00:00.000Z",
  gateKind: "review",
};

describe("createServerApi", () => {
  it("me() 在 401 時回傳 null，其他錯誤丟出", async () => {
    const unauthorized = fakeFetch(() => json(401, { error: "unauthorized" }));
    expect(await createServerApi("http://s", unauthorized.fetchFn).me()).toBeNull();
    expect(unauthorized.requests[0]?.url).toBe(`http://s${API_PATHS.me}`);

    const broken = fakeFetch(() => json(500, {}));
    await expect(createServerApi("http://s", broken.fetchFn).me()).rejects.toThrow("HTTP 500");
  });

  it("createLocalPairingToken() 以 POST 送出 kind: local", async () => {
    const { fetchFn, requests } = fakeFetch(() => json(201, { token: "pt_abc", expiresAt: null }));
    expect(await createServerApi("http://s", fetchFn).createLocalPairingToken()).toEqual({
      token: "pt_abc",
      expiresAt: null,
    });
    expect(requests[0]?.url).toBe(`http://s${API_PATHS.pairingTokens}`);
    expect(requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ kind: "local" });
  });

  it("createLocalPairingToken() 在 401 時丟出 UnauthorizedError", async () => {
    const { fetchFn } = fakeFetch(() => json(401, {}));
    await expect(createServerApi("http://s", fetchFn).createLocalPairingToken()).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it("listNeedsYou() 接受陣列或 { items }，看不懂的項目略過", async () => {
    const asArray = fakeFetch(() => json(200, [gate, { kind: "future_kind", id: "x" }]));
    expect(await createServerApi("http://s", asArray.fetchFn).listNeedsYou()).toEqual([gate]);
    const asObject = fakeFetch(() => json(200, { items: [gate] }));
    expect(await createServerApi("http://s", asObject.fetchFn).listNeedsYou()).toEqual([gate]);
  });
});
