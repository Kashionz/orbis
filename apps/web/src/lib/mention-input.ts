// 留言輸入框的 @mention 自動完成（ARCHITECTURE §12.3）。插入的是契約的明確 token
// （`@[名稱](member:<id>)`、`@[名稱](agent:<id>)`，見 api-contract 的 mention.ts）。

import {
  formatMention,
  type MentionCandidates,
  type MentionTarget,
  parseMentions,
} from "@orbis/api-contract";

export interface MentionQuery {
  /** `@` 的位置。 */
  start: number;
  /** `@` 之後、游標之前的文字。 */
  query: string;
}

/**
 * 游標前是不是正在輸入 `@名稱`：`@` 在開頭或空白之後，`@` 到游標之間沒有空白或括號。
 * 不是時回傳 null。
 */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@[\]()]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

export interface MentionOption {
  key: string;
  label: string;
  /** 次要說明，例如成員的名稱或「Agent」。 */
  detail: string;
  target: MentionTarget;
}

/** 依輸入過濾候選對象：成員比對 GitHub login 與名稱，Agent 比對顯示名稱與 id（不分大小寫）。 */
export function mentionOptions(candidates: MentionCandidates, query: string): MentionOption[] {
  const q = query.toLowerCase();
  const matches = (...values: (string | null)[]) =>
    values.some((v) => v?.toLowerCase().includes(q));
  return [
    ...candidates.agents
      .filter((a) => matches(a.label, a.agent))
      .map(
        (a): MentionOption => ({
          key: `agent:${a.agent}`,
          label: a.label,
          detail: `Agent（${a.agent}）`,
          target: { type: "agent", agent: a.agent },
        }),
      ),
    ...candidates.members
      .filter((m) => matches(m.githubLogin, m.name))
      .map(
        (m): MentionOption => ({
          key: `member:${m.memberId}`,
          label: m.githubLogin,
          detail: m.name ?? "",
          target: { type: "member", memberId: m.memberId },
        }),
      ),
  ];
}

/** 把 `@查詢` 換成 mention token（後面補一個空白），回傳新的文字與游標位置。 */
export function insertMention(
  text: string,
  query: MentionQuery,
  caret: number,
  option: Pick<MentionOption, "label" | "target">,
): { text: string; caret: number } {
  const token = `${formatMention(option.label, option.target)} `;
  return {
    text: text.slice(0, query.start) + token + text.slice(caret),
    caret: query.start + token.length,
  };
}

/** 文字中提及的 Agent（@agent 送出後會建立 consult Run）。 */
export function mentionedAgents(text: string): string[] {
  return [
    ...new Set(
      parseMentions(text).flatMap((m) => (m.target.type === "agent" ? [m.target.agent] : [])),
    ),
  ];
}
