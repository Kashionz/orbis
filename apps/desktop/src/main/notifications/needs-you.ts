// Needs You 的桌面通知（ARCHITECTURE §12.3）：main 程序每 5 秒輪詢 `GET /api/needs-you`
// （使用者核准的決定 D7），出現新項目時發出原生通知，點擊後跳到對應的頁面。

import type { NeedsYouItem } from "@orbis/api-contract";

export const NEEDS_YOU_POLL_INTERVAL_MS = 5_000;

/**
 * 點擊通知後要前往的 Web UI 路徑，和 Web UI 的 Needs You 頁「一鍵跳到」的位置相同：
 * Review Gate 到 diff review，權限請求到 Run 頁並聚焦在該請求，其他到 Run 頁。
 * 路由對應 apps/web 的 `src/router.tsx`（`/runs/$runId`、`/runs/$runId/review`、`focus` search 參數）
 * 與 `src/features/needs-you/NeedsYouPage.tsx` 的 `JumpLink`。apps/web 依賴 @orbis/desktop，
 * 不能反過來匯入，Web 改路由時要一起改這裡。
 */
export function needsYouHref(item: NeedsYouItem): string {
  const run = `/runs/${encodeURIComponent(item.runId)}`;
  if (item.kind === "gate" && item.gateKind === "review") return `${run}/review`;
  if (item.kind === "permission_request") {
    return `${run}?focus=${encodeURIComponent(`permission-${item.permissionRequestId}`)}`;
  }
  return run;
}

const GATE_LABELS: Record<string, string> = { plan: "Plan Gate", review: "Review Gate" };

export interface NotificationContent {
  title: string;
  body: string;
  href: string;
}

export function needsYouNotification(item: NeedsYouItem): NotificationContent {
  const href = needsYouHref(item);
  switch (item.kind) {
    case "permission_request":
      return { title: `${item.taskKey} 需要你核准權限`, body: item.title, href };
    case "gate":
      return {
        title: `${item.taskKey} 的 ${GATE_LABELS[item.gateKind] ?? "Gate"} 等待核准`,
        body: "點擊查看並核准",
        href,
      };
    case "stopped_run":
      return { title: `${item.taskKey} 的 Run 停下來了`, body: item.reason, href };
    case "child_question":
      return { title: `${item.taskKey} 的 Child Run 有問題要問`, body: item.question, href };
  }
}

export interface NeedsYouPollerDeps {
  list: () => Promise<NeedsYouItem[]>;
  /** 每次輪詢成功後呼叫；newItems 是這次才出現的項目（第一次輪詢只建立基準，不算新項目）。 */
  onItems: (items: NeedsYouItem[], newItems: NeedsYouItem[]) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
}

export class NeedsYouPoller {
  private timer: NodeJS.Timeout | null = null;
  private seen: Set<string> | null = null;
  private generation = 0;

  constructor(private readonly deps: NeedsYouPollerDeps) {}

  get running(): boolean {
    return this.timer !== null;
  }

  /** 開始輪詢；已經在跑時不做任何事。 */
  start(): void {
    if (this.timer) return;
    this.seen = null;
    const generation = ++this.generation;
    const tick = async () => {
      await this.poll(generation);
      if (generation !== this.generation) return;
      this.timer = setTimeout(tick, this.deps.intervalMs ?? NEEDS_YOU_POLL_INTERVAL_MS);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.seen = null;
  }

  private async poll(generation: number): Promise<void> {
    let items: NeedsYouItem[];
    try {
      items = await this.deps.list();
    } catch (error) {
      if (generation === this.generation) this.deps.onError?.(error);
      return;
    }
    // stop() 之後才回來的結果丟掉
    if (generation !== this.generation) return;
    const seen = this.seen;
    const newItems = seen === null ? [] : items.filter((item) => !seen.has(item.id));
    this.seen = new Set(items.map((item) => item.id));
    this.deps.onItems(items, newItems);
  }
}
