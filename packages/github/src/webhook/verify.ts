// webhook 簽章驗證（`X-Hub-Signature-256`）。
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/** 計算 body 的簽章（`sha256=<hex>`）。測試用它產生合法的 header。 */
export function signWebhookBody(secret: string, body: Uint8Array | string): string {
  return `${PREFIX}${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** 以固定時間比較驗證簽章；header 缺少或格式不對一律視為不合法。 */
export function verifyWebhookSignature(
  secret: string,
  body: Uint8Array | string,
  header: string | null | undefined,
): boolean {
  if (!header?.startsWith(PREFIX)) return false;
  const expected = Buffer.from(signWebhookBody(secret, body));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
