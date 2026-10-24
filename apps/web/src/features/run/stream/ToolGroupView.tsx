// 工具群組：預設收合成一行摘要（標題、各類的次數、+/−、失敗數、時長）；展開後每個 tool call 一列，
// 編輯有行內 diff 預覽、執行有終端機輸出。

import type { ToolCallContent } from "@orbis/protocol";
import { FileText, Pencil, Search, SquareTerminal } from "lucide-react";
import { useMemo } from "react";
import { blobUrl } from "../../../api/resources";
import { FluidList, fluidItem } from "../../../components/FluidList";
import { StatusDot } from "../../../components/StatusDot";
import { useT } from "../../../i18n";
import { usePreferences } from "../../../lib/preferences";
import { baseName, type CodeRow, diffRows } from "../panel/diff-lines";
import { shellPrompt } from "../panel/terminal-blocks";
import { useStreamEnv } from "./stream-context";
import { type StreamItem, type ToolBucket, type ToolCallItem, toolBucket } from "./stream-model";
import { duration } from "./time-format";

type ToolGroup = Extract<StreamItem, { kind: "tool_group" }>;

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

function BucketIcon({ bucket }: { bucket: ToolBucket }) {
  switch (bucket) {
    case "edit":
      return <Pencil {...ICON} />;
    case "execute":
      return <SquareTerminal {...ICON} />;
    case "search":
      return <Search {...ICON} />;
    default:
      return <FileText {...ICON} />;
  }
}

type DiffContent = Extract<ToolCallContent, { type: "diff" }>;
type TerminalContent = Extract<ToolCallContent, { type: "terminal" }>;

interface DiffStats {
  adds: number;
  dels: number;
  rows: CodeRow[];
}

/** tool call 中內嵌的 diff 的 +/− 與行（放在 blob 的大檔不預覽）。 */
function diffOf(content: DiffContent): DiffStats | null {
  if (content.old?.type === "blob" || content.new?.type === "blob") return null;
  const { rows, adds, dels } = diffRows(content.old?.text ?? "", content.new?.text ?? "");
  return { adds, dels, rows: rows.filter((r): r is CodeRow => r.kind !== "hunk") };
}

function firstOf<T extends ToolCallContent["type"]>(tool: ToolCallItem, type: T) {
  return tool.content.find((c): c is Extract<ToolCallContent, { type: T }> => c.type === type);
}

export function ToolGroupView({ item }: { item: ToolGroup }) {
  const t = useT();
  const w = t.workspace.stream;
  const env = useStreamEnv();
  const open = env.isOpen(item.key, item.defaultOpen);

  // 每個檔案只算一次 +/−
  const stats = useMemo(() => {
    const seen = new Set<string>();
    let adds = 0;
    let dels = 0;
    for (const tool of item.tools) {
      for (const content of tool.content) {
        if (content.type !== "diff" || seen.has(content.path)) continue;
        seen.add(content.path);
        const diff = diffOf(content);
        adds += diff?.adds ?? 0;
        dels += diff?.dels ?? 0;
      }
    }
    return { adds, dels };
  }, [item.tools]);

  const icon: ToolBucket =
    item.counts.edit > 0
      ? "edit"
      : item.counts.execute > 0
        ? "execute"
        : item.counts.search > 0 && item.counts.read === 0
          ? "search"
          : "read";
  const buckets = (["read", "search", "edit", "execute", "other"] as const).filter(
    (b) => item.counts[b] > 0,
  );

  return (
    <div className="st-group">
      <button
        type="button"
        className="st-group-toggle"
        aria-expanded={open}
        onClick={() => env.toggle(item.key, item.defaultOpen)}
      >
        <span
          className="st-group-icon"
          data-tone={item.running ? "accent" : item.failed > 0 ? "danger" : "muted"}
        >
          {item.running ? <StatusDot color="currentColor" live /> : <BucketIcon bucket={icon} />}
        </span>
        <span className="st-group-label">{w.toolGroup[item.label]}</span>
        <span className="st-group-summary">
          {buckets.map((bucket) => (
            <span key={bucket}>{w.toolCount[bucket](item.counts[bucket])}</span>
          ))}
        </span>
        {stats.adds + stats.dels > 0 && (
          <span className="st-stats">
            <span className="st-add">+{stats.adds}</span>
            <span className="st-del">−{stats.dels}</span>
          </span>
        )}
        {item.failed > 0 && <span className="st-group-failed">{w.failedCount(item.failed)}</span>}
        <span className="st-spacer" />
        <span className="st-group-duration">{duration(item.durationSeconds, t.common)}</span>
      </button>
      {open && (
        <FluidList axis="y" className="st-tools">
          {item.tools.map((tool) => (
            <ToolRow key={tool.key} tool={tool} />
          ))}
        </FluidList>
      )}
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolCallItem }) {
  const t = useT();
  const w = t.workspace.stream;
  const env = useStreamEnv();
  const bucket = toolBucket(tool.toolKind);
  const diffContent = firstOf(tool, "diff");
  const terminal = firstOf(tool, "terminal");
  const text = firstOf(tool, "text");
  const diff = useMemo(() => (diffContent ? diffOf(diffContent) : null), [diffContent]);
  const location = tool.locations[0]?.path.replace(/\\/g, "/");

  let primary = tool.title;
  let secondary = "";
  if (bucket === "execute") {
    primary = terminal?.command ?? tool.title;
  } else if (bucket === "search") {
    secondary = location ?? "";
  } else if (location) {
    primary = baseName(location);
    const slash = location.lastIndexOf("/");
    secondary = slash < 0 ? "" : location.slice(0, slash);
  }

  const canExpand = diffContent !== undefined || terminal !== undefined || text !== undefined;
  const failedCommand =
    terminal !== undefined && terminal.exit_code !== null && terminal.exit_code !== 0;
  const defaultOpen =
    (bucket === "edit" && diff !== null) ||
    (bucket === "execute" && (tool.status !== "completed" || failedCommand));
  const detailKey = `${tool.key}-detail`;
  const open = canExpand && env.isOpen(detailKey, defaultOpen);
  const running = tool.status === "in_progress";

  return (
    <div className="st-tool">
      <div
        {...fluidItem}
        className="st-tool-row"
        data-expandable={canExpand}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? open : undefined}
        data-tool-status={tool.status}
        onClick={() => canExpand && env.toggle(detailKey, defaultOpen)}
        onKeyDown={(event) => {
          if (canExpand && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            env.toggle(detailKey, defaultOpen);
          }
        }}
      >
        <span className="st-tool-icon" data-tip={t.labels.toolKind[tool.toolKind]}>
          <BucketIcon bucket={bucket} />
        </span>
        <span className="st-tool-primary">{primary}</span>
        <span className="st-tool-secondary">{secondary}</span>
        {diff && (
          <span className="st-stats">
            <span className="st-add">+{diff.adds}</span>
            <span className="st-del">−{diff.dels}</span>
          </span>
        )}
        {tool.status !== "completed" && (
          <span className="st-tool-status" data-status={tool.status}>
            {running && <StatusDot color="currentColor" live />}
            {t.labels.toolCallStatus[tool.status]}
          </span>
        )}
        {diffContent && (
          <button
            type="button"
            className="st-link"
            onClick={(event) => {
              event.stopPropagation();
              env.openFile(diffContent.path);
            }}
          >
            {w.openInDiff}
          </button>
        )}
      </div>
      {open && (
        <div className="st-tool-detail">
          {diffContent && <DiffSnippet content={diffContent} diff={diff} />}
          {terminal && <TerminalSnippet content={terminal} />}
          {!diffContent && !terminal && text && <pre className="st-tool-out">{text.text}</pre>}
        </div>
      )}
    </div>
  );
}

/** 從第一個變更的前一行開始顯示 5 行。 */
const SNIPPET_LINES = 5;

function DiffSnippet({ content, diff }: { content: DiffContent; diff: DiffStats | null }) {
  const t = useT();
  if (!diff) {
    const body = content.new?.type === "blob" ? content.new : content.old;
    return (
      <div className="st-tool-out">
        {body?.type === "blob" && (
          <a href={blobUrl(body.blob_id)} target="_blank" rel="noreferrer">
            {t.workspace.stream.openBlob}
          </a>
        )}
      </div>
    );
  }
  const start = Math.max(0, diff.rows.findIndex((r) => r.kind !== "ctx") - 1);
  const shown = diff.rows.slice(start, start + SNIPPET_LINES);
  const more = diff.rows.length - shown.length;
  return (
    <div className="st-snippet">
      {shown.map((row, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 的行沒有其他穩定的 key
          key={index}
          className="st-snippet-line"
          data-kind={row.kind}
        >
          <span className="st-snippet-num">{row.newLine ?? row.oldLine}</span>
          <span className="st-snippet-sign">
            {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
          </span>
          <span className="st-snippet-text">{row.text}</span>
        </div>
      ))}
      {more > 0 && <div className="st-snippet-more">{t.workspace.stream.moreLines(more)}</div>}
    </div>
  );
}

/** 終端機輸出的前 7 行。 */
const TERMINAL_LINES = 7;

function TerminalSnippet({ content }: { content: TerminalContent }) {
  const t = useT();
  const w = t.workspace.stream;
  const { terminalShell } = usePreferences();
  const output =
    content.output.type === "inline"
      ? (() => {
          const lines = content.output.text.split("\n");
          return (
            lines.slice(0, TERMINAL_LINES).join("\n") + (lines.length > TERMINAL_LINES ? "\n…" : "")
          );
        })()
      : null;
  return (
    <div className="st-term">
      {content.command && (
        <div className="st-term-cmd">
          <span className="st-term-prompt">{shellPrompt(terminalShell)} </span>
          {content.command}
        </div>
      )}
      {output !== null ? (
        <div className="st-term-out">{output}</div>
      ) : (
        content.output.type === "blob" && (
          <a href={blobUrl(content.output.blob_id)} target="_blank" rel="noreferrer">
            {w.blobOutput(content.output.size.toLocaleString())}
          </a>
        )
      )}
      {content.exit_code !== null && (
        <div className="st-term-exit" data-failed={content.exit_code !== 0}>
          {w.exitCode(content.exit_code)}
        </div>
      )}
    </div>
  );
}
