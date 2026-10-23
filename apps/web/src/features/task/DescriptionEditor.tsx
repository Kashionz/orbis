import { useState } from "react";
import Markdown from "react-markdown";

interface DescriptionEditorProps {
  value: string;
  canEdit: boolean;
  saving: boolean;
  onSave: (value: string) => Promise<unknown>;
}

/**
 * Task 描述的 markdown 編輯器：編輯與預覽兩個分頁。
 * C2 會換成 TipTap 加 Yjs 的即時共同編輯。
 */
export function DescriptionEditor({ value, canEdit, saving, onSave }: DescriptionEditorProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");

  if (draft === null) {
    return (
      <section className="section" aria-labelledby="description-heading">
        <div className="section-header">
          <h2 id="description-heading">描述</h2>
          {canEdit && (
            <button type="button" className="link-button" onClick={() => setDraft(value)}>
              編輯描述
            </button>
          )}
        </div>
        <div className="markdown" data-testid="description">
          {value.trim() === "" ? <p className="empty">沒有描述</p> : <Markdown>{value}</Markdown>}
        </div>
      </section>
    );
  }

  return (
    <section className="section" aria-labelledby="description-heading">
      <div className="section-header">
        <h2 id="description-heading">描述</h2>
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "write"}
            onClick={() => setTab("write")}
          >
            編輯
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            onClick={() => setTab("preview")}
          >
            預覽
          </button>
        </div>
      </div>
      {tab === "write" ? (
        <textarea
          aria-label="描述（markdown）"
          className="markdown-input"
          rows={10}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <div className="markdown">
          <Markdown>{draft}</Markdown>
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={async () => {
            try {
              await onSave(draft);
              setDraft(null);
              setTab("write");
            } catch {
              // 失敗時保留草稿，錯誤訊息由 Task 頁顯示
            }
          }}
        >
          儲存描述
        </button>
        <button type="button" onClick={() => setDraft(null)}>
          取消
        </button>
      </div>
    </section>
  );
}
