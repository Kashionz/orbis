import { API_ROUTES, type NeedsYouItem } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { createServerApi, UnauthorizedError } from "./server-api";

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
    expect(unauthorized.requests[0]?.url).toBe(`http://s${API_ROUTES.authMe}`);

    const broken = fakeFetch(() => json(500, {}));
    await expect(createServerApi("http://s", broken.fetchFn).me()).rejects.toThrow("HTTP 500");
  });

  it("createLocalPairingToken() 以 POST 送出 kind: local，回應照 PairingTokenCreated 解析", async () => {
    const created = {
      id: "ptk_1",
      kind: "local",
      token: "pt_abc",
      expiresAt: "2026-10-23T00:10:00.000Z",
    };
    const { fetchFn, requests } = fakeFetch(() => json(201, created));
    expect(await createServerApi("http://s", fetchFn).createLocalPairingToken()).toEqual(created);
    expect(requests[0]?.url).toBe(`http://s${API_ROUTES.pairingTokens}`);
    expect(requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ kind: "local" });
    const malformed = fakeFetch(() => json(201, { token: "pt_abc" }));
    await expect(
      createServerApi("http://s", malformed.fetchFn).createLocalPairingToken(),
    ).rejects.toThrow();
  });

  it("createLocalPairingToken() 在 401 時丟出 UnauthorizedError", async () => {
    const { fetchFn } = fakeFetch(() => json(401, {}));
    await expect(createServerApi("http://s", fetchFn).createLocalPairingToken()).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it("listNeedsYou() 逐項解析 NeedsYouListResponse，看不懂的項目略過", async () => {
    const { fetchFn, requests } = fakeFetch(() =>
      json(200, [gate, { kind: "future_kind", id: "x" }]),
    );
    expect(await createServerApi("http://s", fetchFn).listNeedsYou()).toEqual([gate]);
    expect(requests[0]?.url).toBe(`http://s${API_ROUTES.needsYou}`);
  });

  it("revokeRunner() 以 DELETE 撤銷；Server 已經沒有這台 Runner（404）也算成功", async () => {
    const ok = fakeFetch(() => new Response(null, { status: 204 }));
    await createServerApi("http://s", ok.fetchFn).revokeRunner("rn/1");
    expect(ok.requests[0]?.url).toBe("http://s/api/runners/rn%2F1");
    expect(ok.requests[0]?.init.method).toBe("DELETE");
    const gone = fakeFetch(() => json(404, {}));
    await expect(createServerApi("http://s", gone.fetchFn).revokeRunner("rn_1")).resolves.toBe(
      undefined,
    );
    const broken = fakeFetch(() => json(500, {}));
    await expect(createServerApi("http://s", broken.fetchFn).revokeRunner("rn_1")).rejects.toThrow(
      "HTTP 500",
    );
  });
});
