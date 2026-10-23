import { formatMentionTargetId, replaceMentions } from "@orbis/api-contract";
import Markdown, { defaultUrlTransform } from "react-markdown";

/** mention token 在 markdown 中改寫成這個 scheme 的連結，再由 `a` 元件畫成標籤。 */
const MENTION_SCHEME = "orbis-mention:";

/**
 * 顯示含 @mention 的 markdown（留言）：token 畫成 `@名稱` 的標籤，程式碼中的 token 保留原樣。
 */
export function MentionMarkdown({ text }: { text: string }) {
  const source = replaceMentions(
    text,
    (m) =>
      `[@${m.label.replace(/[[\]]/g, "")}](${MENTION_SCHEME}${formatMentionTargetId(m.target)})`,
  );
  return (
    <div className="markdown">
      <Markdown
        urlTransform={(url) => (url.startsWith(MENTION_SCHEME) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) =>
            href?.startsWith(MENTION_SCHEME) ? (
              <span className="mention" data-mention={href.slice(MENTION_SCHEME.length)}>
                {children}
              </span>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
