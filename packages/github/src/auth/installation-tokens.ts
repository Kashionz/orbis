// installation token 的取得與快取。token 有效 1 小時；到期前一段時間就換新的，
// 同一個 installation 同時有多個請求時只打一次 API。

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

/** 到期前多久就視為需要更新。 */
export const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class InstallationTokenCache {
  readonly #fetchToken: (installationId: number) => Promise<InstallationToken>;
  readonly #now: () => number;
  readonly #cache = new Map<number, InstallationToken>();
  readonly #pending = new Map<number, Promise<InstallationToken>>();

  constructor(options: {
    /** 實際向 GitHub 換 token（`POST /app/installations/{id}/access_tokens`）。 */
    fetchToken: (installationId: number) => Promise<InstallationToken>;
    now?: () => number;
  }) {
    this.#fetchToken = options.fetchToken;
    this.#now = options.now ?? Date.now;
  }

  /** 取得可用的 token。失敗不會被快取，下一次呼叫會重試。 */
  async get(installationId: number): Promise<string> {
    const cached = this.#cache.get(installationId);
    if (cached && cached.expiresAt.getTime() - this.#now() > INSTALLATION_TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }

    let pending = this.#pending.get(installationId);
    if (!pending) {
      pending = this.#fetchToken(installationId).finally(() => {
        this.#pending.delete(installationId);
      });
      this.#pending.set(installationId, pending);
    }
    const fresh = await pending;
    this.#cache.set(installationId, fresh);
    return fresh.token;
  }

  /** 丟掉快取，例如 App 被移除安裝，或 GitHub 回 401。 */
  invalidate(installationId: number): void {
    this.#cache.delete(installationId);
  }
}
