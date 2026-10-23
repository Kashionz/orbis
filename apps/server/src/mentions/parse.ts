// @mention 的解析（ARCHITECTURE §12.3）：Task 留言、Spec 共同編輯、diff 行內留言中的 @member 與 @agent。
//
// 標準寫法是明確的 token，Web 的自動完成直接產生，Server 不必猜 GitHub login：
// - `@[顯示名稱](member:<Member id>)`
// - `@[顯示名稱](agent:<Agent Profile id>)`，例如 `@[claude](agent:claude-code)`
// 程式碼區塊與行內程式碼中的 token 不算 mention。

// TODO(contract): 改用 packages/api-contract 的 parseMentions()／formatMention()（ORB-3 契約 v2）。

export type MentionTarget = { kind: "member"; memberId: string } | { kind: "agent"; agent: string };

export interface Mention {
  target: MentionTarget;
  /** 顯示名稱（token 中的文字）。 */
  label: string;
}

const MENTION_TOKEN =
  /@\[([^\]\n]{1,100})\]\((member:[0-9a-fA-F-]{36}|agent:[A-Za-z0-9._-]{1,64})\)/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 把 fenced code block 與行內程式碼換成等長的空白（其他文字的位置不變）。 */
function stripCode(markdown: string): string {
  let fence: string | null = null;
  const lines = markdown.split("\n").map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return " ".repeat(line.length);
    }
    if (marker) {
      fence = marker;
      return " ".repeat(line.length);
    }
    return line.replace(/`[^`]*`/g, (code) => " ".repeat(code.length));
  });
  return lines.join("\n");
}

/** 解析文字中的 mention，依出現順序、同一個對象只回傳一次。 */
export function parseMentions(markdown: string): Mention[] {
  const seen = new Set<string>();
  const mentions: Mention[] = [];
  for (const match of stripCode(markdown).matchAll(MENTION_TOKEN)) {
    const label = match[1] ?? "";
    const id = match[2] ?? "";
    const separator = id.indexOf(":");
    const kind = id.slice(0, separator);
    const value = id.slice(separator + 1);
    let target: MentionTarget;
    if (kind === "member") {
      const memberId = value.toLowerCase();
      if (!UUID.test(memberId)) continue;
      target = { kind: "member", memberId };
    } else target = { kind: "agent", agent: value };
    const key = mentionKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({ target, label });
  }
  return mentions;
}

/** mention 對象的識別字串，例如 `member:<uuid>`、`agent:claude-code`。 */
export function mentionKey(target: MentionTarget): string {
  return target.kind === "member" ? `member:${target.memberId}` : `agent:${target.agent}`;
}

/** 產生標準寫法的 token。顯示名稱中的 `]` 與換行會被移除。 */
export function formatMention(target: MentionTarget, label: string): string {
  const safe = label.replace(/[\]\n\r]/g, "").slice(0, 100) || "?";
  return `@[${safe}](${mentionKey(target)})`;
}

/**
 * 把 mention 換成其他文字（例如同步到 GitHub 時換成 `@login`）。
 * `replace` 回傳 null 時保留顯示名稱（不加 @，避免 GitHub 通知到不相干的人）。
 */
export function replaceMentions(
  markdown: string,
  replace: (mention: Mention) => string | null,
): string {
  const code = stripCode(markdown);
  return markdown.replace(MENTION_TOKEN, (token, label: string, id: string, offset: number) => {
    // 程式碼中的 token 保留原樣。
    if (code.slice(offset, offset + token.length) !== token) return token;
    const [mention] = parseMentions(`@[${label}](${id})`);
    if (!mention) return token;
    return replace(mention) ?? label;
  });
}
