// App JWT 與 installation token 快取。

import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APP_JWT_CLOCK_SKEW_SECONDS,
  APP_JWT_TTL_SECONDS,
  createAppJwtSigner,
} from "../src/auth/app-jwt";
import {
  INSTALLATION_TOKEN_REFRESH_MARGIN_MS,
  type InstallationToken,
  InstallationTokenCache,
} from "../src/auth/installation-tokens";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function decode(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
}

describe("App JWT", () => {
  it("RS256 簽章可以用公鑰驗證，claims 符合 GitHub 的要求", () => {
    const now = Date.parse("2026-10-23T08:00:00Z");
    const jwt = createAppJwtSigner({ appId: 42, privateKey, now: () => now }).token();
    const [header, payload, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    const nowSeconds = now / 1000;
    expect(claims).toEqual({
      iss: 42,
      iat: nowSeconds - APP_JWT_CLOCK_SKEW_SECONDS,
      exp: nowSeconds + APP_JWT_TTL_SECONDS,
    });
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(privateKey),
      Buffer.from(signature ?? "", "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("快到期前重複使用同一個 JWT，快到期時重新簽發", () => {
    let now = Date.parse("2026-10-23T08:00:00Z");
    const signer = createAppJwtSigner({ appId: 1, privateKey, now: () => now });
    const first = signer.token();
    now += 5 * 60_000;
    expect(signer.token()).toBe(first);
    now += 3.5 * 60_000; // 剩不到 1 分鐘
    expect(signer.token()).not.toBe(first);
  });
});

describe("installation token 快取", () => {
  function setup() {
    let now = Date.parse("2026-10-23T08:00:00Z");
    const calls: number[] = [];
    let counter = 0;
    let fail = false;
    const cache = new InstallationTokenCache({
      now: () => now,
      fetchToken: async (id): Promise<InstallationToken> => {
        calls.push(id);
        await Promise.resolve();
        if (fail) throw new Error("GitHub 掛了");
        counter++;
        return { token: `token-${id}-${counter}`, expiresAt: new Date(now + 60 * 60_000) };
      },
    });
    return {
      cache,
      calls,
      advance: (ms: number) => {
        now += ms;
      },
      setFail: (v: boolean) => {
        fail = v;
      },
    };
  }

  it("有效期間內重複使用", async () => {
    const t = setup();
    expect(await t.cache.get(1)).toBe("token-1-1");
    t.advance(30 * 60_000);
    expect(await t.cache.get(1)).toBe("token-1-1");
    expect(t.calls).toEqual([1]);
  });

  it("到期前 5 分鐘內換新的", async () => {
    const t = setup();
    await t.cache.get(1);
    t.advance(60 * 60_000 - INSTALLATION_TOKEN_REFRESH_MARGIN_MS + 1);
    expect(await t.cache.get(1)).toBe("token-1-2");
  });

  it("不同 installation 各自快取", async () => {
    const t = setup();
    await t.cache.get(1);
    await t.cache.get(2);
    await t.cache.get(1);
    expect(t.calls).toEqual([1, 2]);
  });

  it("同時多個請求只打一次 API", async () => {
    const t = setup();
    const tokens = await Promise.all([1, 2, 3, 4].map(() => t.cache.get(7)));
    expect(new Set(tokens)).toEqual(new Set(["token-7-1"]));
    expect(t.calls).toEqual([7]);
  });

  it("失敗不快取，下一次重試", async () => {
    const t = setup();
    t.setFail(true);
    await expect(t.cache.get(1)).rejects.toThrow("GitHub 掛了");
    t.setFail(false);
    expect(await t.cache.get(1)).toBe("token-1-1");
    expect(t.calls).toEqual([1, 1]);
  });

  it("invalidate 之後重新取得", async () => {
    const t = setup();
    await t.cache.get(1);
    t.cache.invalidate(1);
    expect(await t.cache.get(1)).toBe("token-1-2");
  });
});
