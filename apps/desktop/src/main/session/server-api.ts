// Desktop 的 main 程序呼叫的 Server API。fetch 由呼叫端提供：正式環境用 Electron session 的 fetch，
// 帶著 Web UI 登入後的 session cookie；測試用假的 fetch。

import {
  API_ROUTES,
  apiPath,
  type CreatePairingTokenInput,
  MeResponse,
  NeedsYouItem,
  PairingTokenCreated,
} from "@orbis/api-contract";
import { z } from "zod";

/**
 * Needs You 清單（NeedsYouListResponse）逐項解析：協定之後新增的 kind 看不懂就略過，
 * 不要因為一個項目讓整個清單失敗。
 */
const NeedsYouListRaw = z.array(z.unknown());

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
  createLocalPairingToken(): Promise<PairingTokenCreated>;
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
        return MeResponse.parse(await request(API_ROUTES.authMe));
      } catch (error) {
        if (error instanceof UnauthorizedError) return null;
        throw error;
      }
    },
    async createLocalPairingToken() {
      const input: CreatePairingTokenInput = { kind: "local" };
      return PairingTokenCreated.parse(
        await request(API_ROUTES.pairingTokens, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
    },
    async listNeedsYou() {
      const raw = NeedsYouListRaw.parse(await request(API_ROUTES.needsYou));
      return raw.flatMap((item) => {
        const parsed = NeedsYouItem.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
    },
    async revokeRunner(runnerId) {
      const path = apiPath(API_ROUTES.runner, { runnerId });
      const response = await send(path, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new Error(`DELETE ${path} 失敗：HTTP ${response.status}`);
      }
    },
  };
}
