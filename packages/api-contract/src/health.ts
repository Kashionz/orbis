// Server 的健康檢查（`API_ROUTES.health`）。不需要登入。

import { z } from "zod";

/**
 * Server 各項版本（ARCHITECTURE §16「版本相容」）：
 * - `server`：Server 套件的版本字串，只供顯示。
 * - `api`：Server 實作的契約版本（`API_VERSION`），Web 與 Desktop 拿自己編譯進去的值比對。
 * - `protocol`：Server 實作的 Runner↔Server 協定版本（`PROTOCOL_VERSION`），Desktop 拿內建 Runner 的值比對。
 */
export const ServerVersions = z.object({
  server: z.string(),
  api: z.number().int().nonnegative(),
  protocol: z.number().int().nonnegative(),
});
export type ServerVersions = z.infer<typeof ServerVersions>;

/**
 * `apiOrigin` 是 Server 設定的公開網址（Runner 連 `<apiOrigin>/runner`）。Desktop 用 Web 的 origin
 * 呼叫這個端點（開發時經過 Vite 的 `/api` proxy，正式部署時兩者通常是同一個 origin），
 * 取得 apiOrigin 後交給 Runner（ARCHITECTURE §16）。
 *
 * `versions` 是 Phase 1 發布（API 版本 1）才加入的欄位；更早的 Server 不會回報，
 * Web 與 Desktop 把沒有 `versions` 的 Server 視為過舊。
 */
export const HealthResponse = z.object({
  ok: z.literal(true),
  apiOrigin: z.url(),
  versions: ServerVersions.optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
