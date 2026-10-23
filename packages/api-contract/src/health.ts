// Server 的健康檢查（`API_ROUTES.health`）。不需要登入。

import { z } from "zod";

/**
 * `apiOrigin` 是 Server 設定的公開網址（Runner 連 `<apiOrigin>/runner`）。Desktop 用 Web 的 origin
 * 呼叫這個端點（開發時經過 Vite 的 `/api` proxy，正式部署時兩者通常是同一個 origin），
 * 取得 apiOrigin 後交給 Runner（ARCHITECTURE §16）。
 */
export const HealthResponse = z.object({
  ok: z.literal(true),
  apiOrigin: z.url(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
