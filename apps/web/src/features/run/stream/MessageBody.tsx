// Agent 訊息的內容：markdown（段落、清單、粗體、行內 code、檔名 chip、程式碼區塊＋複製）。

import type { ContentBlock } from "@orbis/protocol";
import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { useT } from "../../../i18n";
import { safeHref } from "./safe-href";
import { useStreamEnv } from "./stream-context";
import { fileReference } from "./stream-env";

interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties?: { className?: unknown };
  children?: (HastElement | HastText)[];
}

function textOf(node: HastElement | HastText | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function InlineCode({ children }: { children?: ReactNode }) {
  const env = useStreamEnv();
  const text = String(children ?? "");
  const path = fileReference(text, env.changedPaths);
  if (path) {
    return (
      <button type="button" className="st-file" onClick={() => env.openFile(path)}>
        {text}
      </button>
    );
  }
  return <code className="st-code">{text}</code>;
}

function CodeBlock({ node }: { node?: HastElement }) {
  const t = useT();
  const env = useStreamEnv();
  const code = node?.children?.find((c): c is HastElement => c.type === "element");
  const className = code?.properties?.className;
  const language =
    (Array.isArray(className) ? className : [])
      .map(String)
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length) ?? "text";
  const text = textOf(code).replace(/\n$/, "");
  return (
    <div className="st-codeblock">
      <div className="st-codeblock-head">
        <span>{language}</span>
        <button type="button" className="st-codeblock-copy" onClick={() => env.copy(text)}>
          <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
          {t.workspace.stream.copy}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <div className="st-p">{children}</div>,
  ul: ({ children }) => <ul className="st-ul">{children}</ul>,
  ol: ({ children }) => <ol className="st-ol">{children}</ol>,
  strong: ({ children }) => <strong className="st-strong">{children}</strong>,
  h1: ({ children }) => <div className="st-p st-strong">{children}</div>,
  h2: ({ children }) => <div className="st-p st-strong">{children}</div>,
  h3: ({ children }) => <div className="st-p st-strong">{children}</div>,
  h4: ({ children }) => <div className="st-p st-strong">{children}</div>,
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  pre: ({ node }) => <CodeBlock node={node as HastElement | undefined} />,
  a: ({ href, children }) => {
    // 網址來自 Agent，只有 http／https 做成連結
    const safe = href ? safeHref(href) : null;
    return safe ? (
      <a href={safe} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
};

/** 訊息（或 prompt）的內容區塊。 */
export function MessageBody({ blocks }: { blocks: readonly ContentBlock[] }) {
  const t = useT();
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "text":
            return (
              <div key={key} className="st-markdown">
                <Markdown components={COMPONENTS}>{block.text}</Markdown>
              </div>
            );
          case "resource_link": {
            const href = safeHref(block.uri);
            return (
              <div key={key} className="st-p">
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {block.name}
                  </a>
                ) : (
                  <span data-tip={block.uri}>{block.name}</span>
                )}
              </div>
            );
          }
          case "image":
            return (
              <div key={key} className="st-muted">
                {t.workspace.stream.image(block.media_type)}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** 內容區塊中的文字（使用者訊息的泡泡與複製用）。 */
export function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) =>
      block.type === "text" ? block.text : block.type === "resource_link" ? block.name : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}
