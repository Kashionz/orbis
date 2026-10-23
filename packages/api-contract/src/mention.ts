// @mention 的寫法（ARCHITECTURE §12.3）。Task 留言、Review Gate 留言的 markdown 中，以明確的 token
// 表示提及的對象，Web 的自動完成與 Server 的解析不必猜 GitHub login：
//
//   @[顯示名稱](member:<Member ID>)     例如 @[octocat](member:0195f0a0-…)
//   @[顯示名稱](agent:<Agent Profile id>) 例如 @[claude](agent:claude-code)
//
// 共同編輯的文件（collab.ts）則用 TipTap 的 mention 節點，屬性 `id` 是同樣的 `member:…`／`agent:…`。
// 同步到 GitHub 時，Server 以 `replaceMentions` 把 member 換成 `@login`、agent 換成顯示名稱。

import { z } from "zod";
import { Id } from "./common";

/** 被提及的對象。 */
export const MentionTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("member"), memberId: Id }),
  /** `agent` 是 Agent Profile 的 id，例如 `claude-code`。 */
  z.object({ type: z.literal("agent"), agent: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/) }),
]);
export type MentionTarget = z.infer<typeof MentionTarget>;

/** 文字中的一個 mention。`start`／`end` 是 UTF-16 的位置（`end` 不含），可以直接用來 slice。 */
export interface MentionMatch {
  label: string;
  target: MentionTarget;
  start: number;
  end: number;
}

const MENTION_PATTERN = /@\[([^\]\n]+)\]\((member|agent):([^)\s]+)\)/g;

/** 把 `member:<id>`／`agent:<id>` 轉成 MentionTarget；格式不對時回傳 null。 */
export function parseMentionTargetId(value: string): MentionTarget | null {
  const index = value.indexOf(":");
  if (index < 0) return null;
  const type = value.slice(0, index);
  const id = value.slice(index + 1);
  const parsed = MentionTarget.safeParse(
    type === "member" ? { type, memberId: id } : { type, agent: id },
  );
  return parsed.success ? parsed.data : null;
}

/** MentionTarget 的字串形式：`member:<id>` 或 `agent:<id>`（也是 collab mention 節點的 `id` 屬性）。 */
export function formatMentionTargetId(target: MentionTarget): string {
  return target.type === "member" ? `member:${target.memberId}` : `agent:${target.agent}`;
}

/** 找出文字中所有的 mention，依出現順序。格式不對的 token 當成一般文字，略過。 */
export function parseMentions(text: string): MentionMatch[] {
  const matches: MentionMatch[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const [whole, label, type, id] = match;
    if (label === undefined || type === undefined || id === undefined) continue;
    const target = parseMentionTargetId(`${type}:${id}`);
    if (!target) continue;
    matches.push({ label, target, start: match.index, end: match.index + whole.length });
  }
  return matches;
}

/**
 * 組出一個 mention token。顯示名稱中的 `]` 與換行會換成空白，避免破壞格式；
 * 空的顯示名稱改用 id。
 */
export function formatMention(label: string, target: MentionTarget): string {
  const id = formatMentionTargetId(target);
  const safe = label.replace(/[\]\n\r]/g, " ").trim();
  return `@[${safe || id.slice(id.indexOf(":") + 1)}](${id})`;
}

/** 把每個 mention token 換成 `replace` 的結果，例如同步到 GitHub 時換成 `@login`。 */
export function replaceMentions(text: string, replace: (mention: MentionMatch) => string): string {
  let out = "";
  let last = 0;
  for (const mention of parseMentions(text)) {
    out += text.slice(last, mention.start) + replace(mention);
    last = mention.end;
  }
  return out + text.slice(last);
}

/** `GET` projectMentionCandidates 的回應：自動完成的候選對象。 */
export const MentionCandidates = z.object({
  members: z.array(
    z.object({
      memberId: Id,
      githubLogin: z.string().min(1),
      name: z.string().nullable(),
      avatarUrl: z.url().nullable(),
    }),
  ),
  /** 目前有 Runner 能跑的 Agent（Local Runner 或 Team Runner）。 */
  agents: z.array(
    z.object({
      /** Agent Profile 的 id。 */
      agent: z.string().min(1),
      /** 顯示名稱，例如 `claude`。 */
      label: z.string().min(1),
    }),
  ),
});
export type MentionCandidates = z.infer<typeof MentionCandidates>;
