import type { ContentBlock, PermissionOption, PermissionOptionKind } from "@orbis/protocol";
import Markdown from "react-markdown";
import { formatTime } from "../../lib/format";
import {
  RUN_ERROR_LABELS,
  RUN_STATUS_LABELS,
  TOOL_CALL_STATUS_LABELS,
  TOOL_KIND_LABELS,
} from "../../lib/labels";
import { DiffPreview } from "./DiffPreview";
import type { TimelineItem } from "./timeline";

export interface ItemControls {
  /** 這個項目（或其中的區塊）是否已展開。 */
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  /** 可以回覆權限請求嗎（依 Role）。 */
  canRespond: boolean;
  /** 正在送出回覆的權限請求。 */
  respondingRequestId: string | null;
  respond: (requestId: string, optionId: string) => void;
}

function Blocks({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "text":
            return (
              <div key={key} className="markdown">
                <Markdown>{block.text}</Markdown>
              </div>
            );
          case "resource_link":
            return (
              <p key={key}>
                <a href={block.uri} target="_blank" rel="noreferrer">
                  {block.name}
                </a>
              </p>
            );
          case "image":
            return (
              <p key={key} className="hint">
                圖片（{block.media_type}，{block.size.toLocaleString()} bytes）
              </p>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

const ALLOW_KINDS: readonly PermissionOptionKind[] = ["allow_once", "allow_always"];

function optionClass(option: PermissionOption): string {
  return ALLOW_KINDS.includes(option.kind) ? "primary" : "danger";
}

/** 時間軸中的一個項目。 */
export function TimelineItemView({
  item,
  controls,
}: {
  item: TimelineItem;
  controls: ItemControls;
}) {
  switch (item.type) {
    case "message":
      return (
        <div className="event event-message">
          <Blocks blocks={item.blocks} />
        </div>
      );

    case "thought": {
      const open = controls.isExpanded(item.key);
      const firstLine = item.text.split("\n")[0] ?? "";
      return (
        <div className="event event-thought">
          <button
            type="button"
            className="thought-toggle"
            aria-expanded={open}
            onClick={() => controls.toggle(item.key)}
          >
            {open ? "▾" : "▸"} 思考
            {!open && <span className="hint"> {firstLine}</span>}
          </button>
          {open && <div className="thought-text">{item.text}</div>}
        </div>
      );
    }

    case "tool_call":
      return (
        <div className="event event-tool-call" data-tool-status={item.status}>
          <div className="tool-header">
            <span className="tool-kind">{TOOL_KIND_LABELS[item.toolKind]}</span>
            <span className="tool-title">{item.title}</span>
            <span className="status-badge" data-status={item.status}>
              {TOOL_CALL_STATUS_LABELS[item.status]}
            </span>
          </div>
          {item.locations.length > 0 && (
            <div className="tool-locations">
              {item.locations.map((location) => (
                <code key={`${location.path}:${location.line ?? ""}`}>
                  {location.path}
                  {location.line !== null && `:${location.line}`}
                </code>
              ))}
            </div>
          )}
          {item.content.map((content, index) => {
            const key = `${item.key}-${index}`;
            switch (content.type) {
              case "text":
                return (
                  <pre key={key} className="tool-text">
                    {content.text}
                  </pre>
                );
              case "diff":
                return (
                  <DiffPreview
                    key={key}
                    path={content.path}
                    old={content.old}
                    new={content.new}
                    expanded={controls.isExpanded(key)}
                    onToggle={() => controls.toggle(key)}
                  />
                );
              case "terminal":
                return (
                  <div key={key} className="terminal">
                    {content.command && <div className="terminal-command">$ {content.command}</div>}
                    <pre>
                      {content.output.type === "inline"
                        ? content.output.text
                        : `（輸出存在 blob，${content.output.size.toLocaleString()} bytes）`}
                    </pre>
                    {content.exit_code !== null && (
                      <div className="hint">exit code {content.exit_code}</div>
                    )}
                  </div>
                );
              default:
                return null;
            }
          })}
        </div>
      );

    case "permission": {
      const selected = item.options.find((o) => o.option_id === item.resolved?.selectedOptionId);
      const responding = controls.respondingRequestId === item.requestId;
      return (
        <div
          className="event event-permission"
          data-resolved={item.resolved ? "true" : "false"}
          id={item.key}
        >
          <div className="permission-title">
            <strong>權限請求</strong> {item.title}
          </div>
          {item.resolved ? (
            <div className="hint">
              {item.resolved.selectedOptionId === null
                ? "請求已取消"
                : `已回覆：${selected?.name ?? item.resolved.selectedOptionId}`}
            </div>
          ) : controls.canRespond ? (
            <div className="permission-options">
              {item.options.map((option) => (
                <button
                  key={option.option_id}
                  type="button"
                  className={optionClass(option)}
                  disabled={responding}
                  onClick={() => controls.respond(item.requestId, option.option_id)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="hint">等待有權限的 Member 回覆</div>
          )}
        </div>
      );
    }

    case "plan":
      return (
        <div className="event event-plan">
          <strong>Plan</strong>
          <ol>
            {item.entries.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plan 項目沒有 id
              <li key={index} data-status={entry.status}>
                {entry.content}
              </li>
            ))}
          </ol>
        </div>
      );

    case "status":
      return (
        <div className="event event-status">
          狀態：{RUN_STATUS_LABELS[item.status]}
          {item.gate && `（${item.gate === "plan" ? "Plan Gate" : "Review Gate"}）`}
          {item.message && <span className="hint"> — {item.message}</span>}
        </div>
      );

    case "error":
      return (
        <div className="event event-error" role="alert">
          <strong>{RUN_ERROR_LABELS[item.code]}</strong>
          {item.fatal && <span className="tag">Run 已停止</span>} {item.message}
        </div>
      );

    case "rate_limited":
      return (
        <div className="event event-rate-limited">
          <strong>Rate limit</strong> {item.message}
          {item.resetsAt && <span className="hint">（預計 {formatTime(item.resetsAt)} 恢復）</span>}
        </div>
      );

    case "preview_ready":
      // Preview 分頁由 E 軌提供（apps/web/src/features/preview）
      return <div className="event event-status">Preview 已就緒（port {item.port}）</div>;

    case "worktree_ready":
      return (
        <div className="event event-status">
          Worktree 已就緒：<code>{item.branch ?? "（無分支）"}</code>，base{" "}
          <code>{item.baseCommit.slice(0, 7)}</code>
        </div>
      );
  }
}
