// 共同編輯文件（TipTap 的 Y.XmlFragment，經 y-prosemirror 對應）與 markdown 的互轉（ARCHITECTURE §12.1）。
//
// - Server 存檔時把文件轉成 markdown，回寫 Task 描述與 Acceptance Criterion 的描述。
// - 文件第一次開啟、或描述被 REST／GitHub 改掉時，Server 從 markdown 重建文件內容。
//
// 文件結構沿用 TipTap StarterKit 加上 Mention 的節點名稱：
// - 區塊：paragraph、heading（level）、bulletList、orderedList（start）、listItem、blockquote、
//   codeBlock（language）、horizontalRule。
// - 行內：文字的 mark（bold、italic、strike、code、link（href））、hardBreak、mention（id、label）。
// - mention 的 id 是 `member:<uuid>` 或 `agent:<agent>`，markdown 寫成 `@[label](id)`。
// 不認得的節點保留文字內容。

import { lexer, type Token, type Tokens } from "marked";
import * as Y from "yjs";

// TODO(contract): 節點名稱、fragment 名稱與 mention 的寫法改用 packages/api-contract 的定義（ORB-3 契約 v2）。
/** TipTap Collaboration 擴充預設使用的 fragment 名稱。 */
export const COLLAB_FRAGMENT = "default";

const MENTION_ID = /^(member|agent):[A-Za-z0-9._-]+$/;

/**
 * 連結只接受 http、https、mailto 與相對路徑；其他 scheme（例如 `javascript:`）只保留文字。
 * 描述會同步到 GitHub、也會顯示在 Web，不在源頭留下危險的連結。
 */
export function isSafeHref(href: string): boolean {
  // 含控制字元、空白、角括號、括號或引號的一律不收：瀏覽器解析時會略過或改寫這些字元，
  // 也可能讓 markdown 的連結語法提早結束。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 刻意比對控制字元
  if (/[\u0000- \u007f<>()"'`\\]/.test(href) || href === "") return false;
  try {
    // 以瀏覽器的方式解析；相對路徑會以 placeholder 的 https 為基準。
    const { protocol } = new URL(href, "https://placeholder.invalid/");
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

/**
 * 文字中會改變 markdown 結構、或組出連結與 HTML 的字元前面加上 `\`
 * （marked 解析時會還原成原本的字元）。
 */
function escapeText(text: string): string {
  return text.replace(/[\\`[\]<>]/g, "\\$&");
}

/** 不會和內容中的反引號衝突的 code fence（比內容中最長的連續反引號多一個）。 */
function fenceFor(content: string, minimum: number): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(minimum, longest + 1));
}

type Marks = Record<string, Record<string, unknown>>;

// ── Y.XmlFragment → markdown ─────────────────────────────

/** 把文件內容轉成 markdown（結尾不帶換行）。 */
export function fragmentToMarkdown(fragment: Y.XmlFragment): string {
  return blocksToMarkdown(fragment.toArray()).trim();
}

/** `separator`：區塊之間的分隔；清單項目內是緊密的（只換行）。 */
function blocksToMarkdown(
  nodes: (Y.XmlElement | Y.XmlText | Y.XmlHook)[],
  separator = "\n\n",
): string {
  const blocks: string[] = [];
  for (const node of nodes) {
    if (node instanceof Y.XmlText) {
      const text = inlineToMarkdown([node]);
      if (text !== "") blocks.push(text);
    } else if (node instanceof Y.XmlElement) {
      blocks.push(blockToMarkdown(node));
    }
  }
  return blocks.join(separator);
}

function blockToMarkdown(element: Y.XmlElement): string {
  const children = element.toArray();
  switch (element.nodeName) {
    case "paragraph":
      return inlineToMarkdown(children);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(element.getAttribute("level")) || 1));
      return `${"#".repeat(level)} ${inlineToMarkdown(children)}`;
    }
    case "blockquote":
      return prefixLines(blocksToMarkdown(children), "> ", "> ");
    case "bulletList":
    case "orderedList": {
      const ordered = element.nodeName === "orderedList";
      const start = Number(element.getAttribute("start")) || 1;
      return children
        .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
        .map((item, index) => {
          const marker = ordered ? `${start + index}. ` : "- ";
          return prefixLines(
            blocksToMarkdown(item.toArray(), "\n"),
            marker,
            " ".repeat(marker.length),
          );
        })
        .join("\n");
    }
    case "codeBlock": {
      const language = element.getAttribute("language");
      const code = children
        .map((child) => (child instanceof Y.XmlText ? child.toString() : ""))
        .join("");
      const fence = fenceFor(code, 3);
      const info = typeof language === "string" ? language.replace(/[^\w+.-]/g, "") : "";
      return `${fence}${info}\n${code}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    default:
      return element.nodeName === "listItem"
        ? blocksToMarkdown(children)
        : inlineToMarkdown(children);
  }
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? first : line === "" ? rest.trimEnd() : rest) + line)
    .join("\n");
}

function inlineToMarkdown(nodes: (Y.XmlElement | Y.XmlText | Y.XmlHook)[]): string {
  let out = "";
  for (const node of nodes) {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as { insert: unknown; attributes?: Marks }[]) {
        if (typeof op.insert === "string") out += applyMarks(op.insert, op.attributes ?? {});
      }
    } else if (node instanceof Y.XmlElement) {
      if (node.nodeName === "hardBreak") out += "\\\n";
      else if (node.nodeName === "mention") {
        const id = String(node.getAttribute("id") ?? "");
        const label = String(node.getAttribute("label") ?? id);
        const safeLabel = label.replace(/[[\]\r\n]/g, "");
        out += MENTION_ID.test(id) ? `@[${safeLabel}](${id})` : `@${escapeText(safeLabel)}`;
      } else out += inlineToMarkdown(node.toArray());
    }
  }
  return out;
}

function applyMarks(text: string, marks: Marks): string {
  if (marks.code) {
    const fence = fenceFor(text, 1);
    const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
    return `${fence}${padded}${fence}`;
  }
  let out = escapeText(text);
  if (marks.bold) out = `**${out}**`;
  if (marks.italic) out = `*${out}*`;
  if (marks.strike) out = `~~${out}~~`;
  const href = marks.link?.href;
  if (typeof href === "string" && isSafeHref(href)) out = `[${out}](${href})`;
  return out;
}

// ── markdown → Y.XmlFragment ─────────────────────────────

/** 以 markdown 取代整份文件的內容（在同一個 transaction 中）。 */
export function replaceFragmentWithMarkdown(
  fragment: Y.XmlFragment,
  markdown: string,
  origin: unknown = null,
): void {
  const apply = () => {
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    appendBlocks(fragment, lexer(markdown));
  };
  if (fragment.doc) fragment.doc.transact(apply, origin);
  else apply();
}

type XmlParent = Y.XmlFragment | Y.XmlElement;

function appendElement(parent: XmlParent, name: string): Y.XmlElement {
  const element = new Y.XmlElement(name);
  parent.insert(parent.length, [element]);
  return element;
}

function appendBlocks(parent: XmlParent, tokens: Token[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "paragraph":
      case "text": {
        const t = token as Tokens.Paragraph | Tokens.Text;
        appendInline(appendElement(parent, "paragraph"), t.tokens ?? [token]);
        break;
      }
      case "heading": {
        const t = token as Tokens.Heading;
        const heading = appendElement(parent, "heading");
        heading.setAttribute("level", t.depth as unknown as string);
        appendInline(heading, t.tokens);
        break;
      }
      case "blockquote":
        appendBlocks(appendElement(parent, "blockquote"), (token as Tokens.Blockquote).tokens);
        break;
      case "list": {
        const t = token as Tokens.List;
        const list = appendElement(parent, t.ordered ? "orderedList" : "bulletList");
        if (t.ordered && typeof t.start === "number" && t.start !== 1) {
          list.setAttribute("start", t.start as unknown as string);
        }
        for (const item of t.items) appendBlocks(appendElement(list, "listItem"), item.tokens);
        break;
      }
      case "code": {
        const t = token as Tokens.Code;
        const code = appendElement(parent, "codeBlock");
        if (t.lang) code.setAttribute("language", t.lang);
        const text = new Y.XmlText();
        code.insert(0, [text]);
        text.insert(0, t.text);
        break;
      }
      case "hr":
        appendElement(parent, "horizontalRule");
        break;
      default: {
        // 表格、HTML 等不支援的區塊：保留原文。
        const raw = (token as { raw?: string }).raw?.trim() ?? "";
        if (raw !== "") {
          const paragraph = appendElement(parent, "paragraph");
          const text = new Y.XmlText();
          paragraph.insert(0, [text]);
          text.insert(0, raw);
        }
      }
    }
  }
}

function appendInline(parent: Y.XmlElement, tokens: Token[]): void {
  let text: Y.XmlText | null = null;
  const pushText = (value: string, marks: Marks) => {
    if (value === "") return;
    if (!text) {
      text = new Y.XmlText();
      parent.insert(parent.length, [text]);
    }
    text.insert(text.length, value, marks);
  };
  const pushNode = (name: string, attributes: Record<string, string> = {}) => {
    const element = new Y.XmlElement(name);
    parent.insert(parent.length, [element]);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    text = null;
  };
  // 尚未寫出的文字（用來處理 `@` 加上連結的 mention）。
  let pending: { value: string; marks: Marks } | null = null;
  const flush = () => {
    if (pending) pushText(pending.value, pending.marks);
    pending = null;
  };

  const walk = (items: Token[], marks: Marks) => {
    for (const token of items) {
      switch (token.type) {
        case "text":
        case "escape": {
          const t = token as Tokens.Text;
          if (t.tokens && t.tokens.length > 0) walk(t.tokens, marks);
          else {
            flush();
            pending = { value: t.text, marks };
          }
          break;
        }
        case "strong":
          walk((token as Tokens.Strong).tokens, { ...marks, bold: {} });
          break;
        case "em":
          walk((token as Tokens.Em).tokens, { ...marks, italic: {} });
          break;
        case "del":
          walk((token as Tokens.Del).tokens, { ...marks, strike: {} });
          break;
        case "codespan":
          flush();
          pushText((token as Tokens.Codespan).text, { ...marks, code: {} });
          break;
        case "br":
          flush();
          pushNode("hardBreak");
          break;
        case "link": {
          const t = token as Tokens.Link;
          const current = pending as { value: string; marks: Marks } | null;
          if (MENTION_ID.test(t.href) && current?.value.endsWith("@")) {
            current.value = current.value.slice(0, -1);
            flush();
            pushNode("mention", { id: t.href, label: t.text });
          } else {
            flush();
            walk(t.tokens, isSafeHref(t.href) ? { ...marks, link: { href: t.href } } : marks);
          }
          break;
        }
        default:
          flush();
          pushText((token as { raw?: string }).raw ?? "", marks);
      }
    }
    flush();
  };
  walk(tokens, {});
}

/** 從 markdown 建立一份新文件的完整快照（文件第一次開啟時用）。 */
export function markdownToDocUpdate(markdown: string): Uint8Array {
  const doc = new Y.Doc();
  replaceFragmentWithMarkdown(doc.getXmlFragment(COLLAB_FRAGMENT), markdown);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
