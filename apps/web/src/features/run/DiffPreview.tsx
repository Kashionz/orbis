import type { TextBody } from "@orbis/protocol";
import { structuredPatch } from "diff";
import { API_PATHS } from "../../api/paths";

/** 預設顯示的行數，超過時要展開才看得到全部。 */
const COLLAPSED_LINES = 40;

interface DiffPreviewProps {
  path: string;
  old: TextBody | null;
  new: TextBody | null;
  expanded: boolean;
  onToggle: () => void;
}

function BlobNotice({ body }: { body: Extract<TextBody, { type: "blob" }> }) {
  // TODO(api): blob 的下載端點待 B 軌確定
  return (
    <p className="hint">
      內容較大，存在 blob（{body.size.toLocaleString()} bytes）。
      <a href={API_PATHS.blob(body.blob_id)} target="_blank" rel="noreferrer">
        開啟完整內容
      </a>
    </p>
  );
}

/** Tool call 中的 diff 預覽：行內 unified diff。 */
export function DiffPreview({ path, old, new: next, expanded, onToggle }: DiffPreviewProps) {
  if (old?.type === "blob") return <BlobNotice body={old} />;
  if (next?.type === "blob") return <BlobNotice body={next} />;

  const patch = structuredPatch(path, path, old?.text ?? "", next?.text ?? "", "", "", {
    context: 3,
  });
  const lines = patch.hunks.flatMap((hunk) => [
    {
      kind: "hunk" as const,
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    },
    ...hunk.lines.map((line) => ({
      kind: line.startsWith("+")
        ? ("add" as const)
        : line.startsWith("-")
          ? ("del" as const)
          : ("ctx" as const),
      text: line,
    })),
  ]);
  const visible = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  const label = old === null ? "新增" : next === null ? "刪除" : "修改";

  return (
    <div className="diff-preview">
      <div className="diff-path">
        <span className="diff-change">{label}</span> {path}
      </div>
      <pre>
        {visible.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 的行沒有其他穩定的 key
          <div key={index} className={`diff-line diff-${line.kind}`}>
            {line.text}
          </div>
        ))}
      </pre>
      {lines.length > COLLAPSED_LINES && (
        <button type="button" className="link-button" onClick={onToggle}>
          {expanded ? "收合" : `顯示全部 ${lines.length} 行`}
        </button>
      )}
    </div>
  );
}
