// Preview（ARCHITECTURE §13）：Preview 網址的換票、登入保護與轉送。這個目錄屬於 E 軌。

import type { Clock } from "../clock";
import type { Database } from "../db/client";
import { canViewRun } from "./access";
import { PreviewAuth } from "./auth";
import { type PreviewDomain, parsePreviewDomain } from "./domain";

export interface PreviewService {
  /** Server 沒有設定 Preview 網域時是 null：不提供 Preview 網址，本機開啟不受影響。 */
  domain: PreviewDomain | null;
  /** Web UI 的網址（authorize 與登入頁）。 */
  publicUrl: string;
  auth: PreviewAuth;
}

export function createPreviewService(options: {
  db: Database;
  clock: Clock;
  /** Preview 網域的設定值（CONFIG_ENV.previewDomain）。 */
  domain: string | null | undefined;
  publicUrl: string;
}): PreviewService {
  const { db, clock } = options;
  return {
    domain: parsePreviewDomain(options.domain, options.publicUrl),
    publicUrl: options.publicUrl,
    auth: new PreviewAuth(clock, (sessionId, runId) => canViewRun(db, clock, sessionId, runId)),
  };
}
