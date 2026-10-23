// Desktop 的 main 程序呼叫的 Server API。fetch 由呼叫端提供：正式環境用 Electron session 的 fetch，
// 帶著 Web UI 登入後的 session cookie；測試用假的 fetch。

import { MeResponse, NeedsYouItem } from "@orbis/api-contract";
import { z } from "zod";

// TODO(contract): 路徑與 schema 以 contract/web-api PR 的 API_ROUTES 為準，合併後改用 @orbis/api-contract
export const API_PATHS = {
  me: "/api/auth/me",
  pairingTokens: "/api/runner-pairing-tokens",
  needsYou: "/api/needs-you",
  runner: (runnerId: string) => `/api/runners/${encodeURIComponent(runnerId)}`,
} as const;

// TODO(contract): Local Runner Pairing token 的回應格式（B1）
const PairingTokenResponse = z.object({
  token: z.string().min(1),
  expiresAt: z.string().nullable().optional(),
});
export type PairingToken = { token: string; expiresAt: string | null };

// TODO(contract): Needs You 清單的回應格式（B1）；暫時同時接受陣列與 `{ items: [...] }`
const NeedsYouListResponse = z.union([
  z.array(z.unknown()),
  z.object({ items: z.array(z.unknown()) }).transform((r) => r.items),
]);

/** Server 回 401：沒有登入或 session 已失效。 */
export class UnauthorizedError extends Error {
  constructor() {
    super("尚未登入");
    this.name = "UnauthorizedError";
  }
}

export interface ServerApi {
  /** 目前登入的人；沒有登入時回傳 null。 */
  me(): Promise<MeResponse | null>;
  /** 為目前的 Member 建立 Local Runner 的 Pairing token。 */
  createLocalPairingToken(): Promise<PairingToken>;
  /** 等待自己處理的 Needs You 項目。看不懂的項目（例如新的 kind）略過。 */
  listNeedsYou(): Promise<NeedsYouItem[]>;
  /** 撤銷 Runner（`DELETE /api/runners/:id`）。Server 已經沒有這台 Runner（404）時視為成功。 */
  revokeRunner(runnerId: string): Promise<void>;
}

export function createServerApi(serverUrl: string, fetchFn: typeof fetch): ServerApi {
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetchFn(`${serverUrl}${path}`, {
      ...init,
      headers: { accept: "application/json", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
    if (response.status === 401) throw new UnauthorizedError();
    return response;
  }

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await send(path, init);
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} 失敗：HTTP ${response.status}`);
    }
    return response.json();
  }

  return {
    async me() {
      try {
        return MeResponse.parse(await request(API_PATHS.me));
      } catch (error) {
        if (error instanceof UnauthorizedError) return null;
        throw error;
      }
    },
    async createLocalPairingToken() {
      const body = PairingTokenResponse.parse(
        await request(API_PATHS.pairingTokens, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "local" }),
        }),
      );
      return { token: body.token, expiresAt: body.expiresAt ?? null };
    },
    async listNeedsYou() {
      const raw = NeedsYouListResponse.parse(await request(API_PATHS.needsYou));
      return raw.flatMap((item) => {
        const parsed = NeedsYouItem.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
    },
    async revokeRunner(runnerId) {
      const path = API_PATHS.runner(runnerId);
      const response = await send(path, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new Error(`DELETE ${path} 失敗：HTTP ${response.status}`);
      }
    },
  };
}
