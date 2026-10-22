// token 的產生與雜湊。DB 只存 token 的 SHA-256，不存原文。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 產生 32 bytes 的隨機 token（base64url）。 */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 以固定時間比較兩個字串，避免從回應時間推測 token。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}
