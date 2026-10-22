// GitHub App 的 JWT（RS256），用來以 App 身分呼叫 API，例如查詢安裝狀態、換 installation token。
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app

import { createPrivateKey, type KeyObject, sign } from "node:crypto";

/** GitHub 允許的 JWT 有效期最長 10 分鐘；留一點餘裕。 */
export const APP_JWT_TTL_SECONDS = 9 * 60;
/** 簽發時間往回撥，容忍本機與 GitHub 的時鐘誤差。 */
export const APP_JWT_CLOCK_SKEW_SECONDS = 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface AppJwtSigner {
  /** 回傳一個可用的 JWT；同一個 JWT 在到期前 1 分鐘內會重複使用。 */
  token(): string;
}

/** 建立 App JWT 的簽發器。`now` 回傳毫秒，測試可以注入。 */
export function createAppJwtSigner(options: {
  appId: number;
  privateKey: string;
  now?: () => number;
}): AppJwtSigner {
  const key: KeyObject = createPrivateKey(options.privateKey);
  const now = options.now ?? Date.now;
  let cached: { jwt: string; exp: number } | null = null;

  return {
    token() {
      const nowSeconds = Math.floor(now() / 1000);
      if (cached && cached.exp - nowSeconds > 60) return cached.jwt;

      const iat = nowSeconds - APP_JWT_CLOCK_SKEW_SECONDS;
      const exp = nowSeconds + APP_JWT_TTL_SECONDS;
      const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const payload = base64url(JSON.stringify({ iat, exp, iss: options.appId }));
      const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
      cached = { jwt: `${header}.${payload}.${base64url(signature)}`, exp };
      return cached.jwt;
    },
  };
}
