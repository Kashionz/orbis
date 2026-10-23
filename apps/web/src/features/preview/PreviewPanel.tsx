// Run 頁面的 Preview 分頁（ARCHITECTURE §13）。C 軌的 Run 頁面掛載 `<PreviewPanel runId />`。
// - Desktop：經由 bridge 在這個區塊疊上內嵌瀏覽器（自己的 Run 開 localhost，別人的 Run 開 Preview 網址），
//   可以選取元素留言（附截圖、selector 與 URL）。
// - 一般瀏覽器：以 iframe 開 Preview 網址，不能選取元素，只能附整頁截圖。

import {
  type DesktopPreviewBridge,
  getDesktopBridge,
  type PreviewNavState,
} from "@orbis/desktop/bridge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ErrorText } from "../../components/ErrorText";
import {
  previewStateQuery,
  restartPreview,
  unavailableMessage,
  uploadScreenshot,
} from "./preview-api";
import { loadPreviewDrafts, type PreviewCommentDraft, savePreviewDrafts } from "./preview-drafts";
import { canCaptureTab, captureElement, imageFromClipboard } from "./screenshot";
import "./preview.css";

/** 在 Preview 上擷取的內容，交給留言框（Preview 留言的附件）。 */
export interface PreviewCapture {
  url: string;
  /** 在 Desktop 中選取的元素；一般瀏覽器中沒有。 */
  selector: string | null;
  screenshot: Blob;
}

export interface PreviewPanelProps {
  runId: string;
  /** 能不能留言（和 Review Gate 退回的權限相同）。 */
  canComment: boolean;
  /** 能不能重新啟動 Preview（和取消 Run 的權限相同）。 */
  canRestart: boolean;
}

export function PreviewPanel({ runId, canComment, canRestart }: PreviewPanelProps) {
  const [bridge] = useState(() => getDesktopBridge()?.preview ?? null);
  const queryClient = useQueryClient();
  const query = previewStateQuery(runId);
  const { data: state, error } = useQuery(query);
  const [capture, setCapture] = useState<PreviewCapture | null>(null);
  const [drafts, setDrafts] = useState(() => loadPreviewDrafts(runId));
  const restart = useMutation({
    mutationFn: () => restartPreview(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  });
  if (error) return <ErrorText error={error} />;
  if (!state) return <p className="preview-message">載入中…</p>;
  const restartButton = canRestart && state.status !== "not_configured" && (
    <button type="button" disabled={restart.isPending} onClick={() => restart.mutate()}>
      重新啟動 Preview
    </button>
  );
  const message = unavailableMessage(state, bridge !== null);
  if (message) {
    return (
      <div className="preview-tab">
        <p className="preview-message">{message}</p>
        {state.status === "stopped" && state.stopped?.output && (
          <pre className="preview-output">{state.stopped.output}</pre>
        )}
        {state.status === "stopped" && restartButton}
        <ErrorText error={restart.error} />
      </div>
    );
  }

  const onCapture = canComment ? setCapture : undefined;
  const update = (next: PreviewCommentDraft[]) => {
    savePreviewDrafts(runId, next);
    setDrafts(next);
  };
  return (
    <div className="preview-tab">
      {restartButton && <div className="preview-toolbar">{restartButton}</div>}
      <ErrorText error={restart.error} />
      {bridge ? (
        <DesktopPreview runId={runId} bridge={bridge} onCapture={onCapture} />
      ) : (
        <BrowserPreview url={state.shareUrl ?? ""} onCapture={onCapture} />
      )}
      {/* 留言框與草稿放在 Preview 下方：Desktop 的內嵌瀏覽器疊在上面的區塊，不會蓋住它們 */}
      {capture && (
        <PreviewCommentForm
          runId={runId}
          capture={capture}
          onSaved={(draft) => {
            update([...drafts, draft]);
            setCapture(null);
          }}
          onCancel={() => setCapture(null)}
        />
      )}
      {drafts.length > 0 && (
        <section className="preview-drafts" aria-label="Preview 留言草稿">
          <h3>Preview 留言草稿（{drafts.length}）</h3>
          <p className="preview-message">Review Gate 退回時，會和 diff 行內留言一起送給 Agent。</p>
          <ul>
            {drafts.map((draft, index) => (
              // 每則草稿的截圖都是剛上傳的 blob，ID 不會重複
              <li key={draft.screenshotBlobId ?? `${draft.url}|${draft.body}`}>
                <span>{draft.body}</span>
                {draft.selector && <code>{draft.selector}</code>}
                <button type="button" onClick={() => update(drafts.filter((_, i) => i !== index))}>
                  刪除
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** 留言框：附上截圖、selector 與網址；加入草稿時上傳截圖。 */
function PreviewCommentForm({
  runId,
  capture,
  onSaved,
  onCancel,
}: {
  runId: string;
  capture: PreviewCapture;
  onSaved: (draft: PreviewCommentDraft) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [image] = useState(() => URL.createObjectURL(capture.screenshot));
  useEffect(() => () => URL.revokeObjectURL(image), [image]);
  const save = useMutation({
    mutationFn: async (): Promise<PreviewCommentDraft> => ({
      body: body.trim(),
      url: capture.url,
      selector: capture.selector,
      screenshotBlobId: await uploadScreenshot(runId, capture.screenshot),
    }),
    onSuccess: onSaved,
  });
  return (
    <form
      className="preview-comment"
      aria-label="Preview 留言"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <img className="preview-comment-shot" src={image} alt="Preview 的截圖" />
      <dl>
        {capture.selector && (
          <>
            <dt>元素</dt>
            <dd>
              <code>{capture.selector}</code>
            </dd>
          </>
        )}
        <dt>網址</dt>
        <dd>{capture.url}</dd>
      </dl>
      <textarea
        aria-label="留言內容"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <ErrorText error={save.error} />
      <div className="preview-toolbar">
        <button type="submit" disabled={body.trim() === "" || save.isPending}>
          {save.isPending ? "上傳截圖中…" : "加入 Review 留言草稿"}
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 依元素的位置算出內嵌瀏覽器的範圍（CSS 像素，相對於 viewport）。 */
function boundsOf(element: Element) {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function DesktopPreview({
  runId,
  bridge,
  onCapture,
}: {
  runId: string;
  bridge: DesktopPreviewBridge;
  onCapture?: (capture: PreviewCapture) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nav, setNav] = useState<PreviewNavState | null>(null);
  const [address, setAddress] = useState("");
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    let active = true;
    void bridge.show(runId, boundsOf(element)).then((result) => {
      if (!active) return;
      setFailure(result.ok ? null : result.message);
      if (result.ok) setAddress(result.url);
    });
    // 版面改變（視窗大小、側欄、捲動）時更新內嵌瀏覽器的位置
    const update = () => void bridge.setBounds(boundsOf(element));
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const unsubscribe = bridge.onNavState((state) => {
      if (state.runId !== runId) return;
      setNav(state);
      setAddress(state.url);
    });
    return () => {
      active = false;
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      unsubscribe();
      void bridge.hide();
    };
  }, [bridge, runId]);

  async function pick() {
    setPicking(true);
    try {
      const result = await bridge.pickElement();
      if (result && onCapture) {
        onCapture({
          url: result.url,
          selector: result.selector,
          screenshot: new Blob([result.screenshot as Uint8Array<ArrayBuffer>], {
            type: "image/png",
          }),
        });
      }
    } finally {
      setPicking(false);
    }
  }

  function go(event: FormEvent) {
    event.preventDefault();
    void bridge.navigate(address).then((result) => {
      if (!result.ok) setFailure(result.message);
    });
  }

  return (
    <section className="preview-panel" aria-label="Preview">
      <form className="preview-toolbar" onSubmit={go}>
        <button
          type="button"
          aria-label="上一頁"
          disabled={!nav?.canGoBack}
          onClick={() => void bridge.goBack()}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="下一頁"
          disabled={!nav?.canGoForward}
          onClick={() => void bridge.goForward()}
        >
          →
        </button>
        <button type="button" aria-label="重新整理" onClick={() => void bridge.reload()}>
          ⟳
        </button>
        <input
          className="preview-address"
          aria-label="網址"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button type="button" onClick={() => void bridge.openDevTools()}>
          DevTools
        </button>
        {onCapture && (
          <button type="button" disabled={picking} onClick={() => void pick()}>
            {picking ? "點選元素（Esc 取消）" : "選取元素留言"}
          </button>
        )}
      </form>
      {failure && <p className="preview-message">{failure}</p>}
      {/* 內嵌瀏覽器由 Desktop 疊在這個區塊上 */}
      <div ref={area} className="preview-frame" data-testid="preview-area" />
    </section>
  );
}

function BrowserPreview({
  url,
  onCapture,
}: {
  url: string;
  onCapture?: (capture: PreviewCapture) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [reloads, setReloads] = useState(0);
  const [captureError, setCaptureError] = useState<unknown>(null);
  const [pasting, setPasting] = useState(false);

  async function capture() {
    const element = frame.current;
    if (!element || !onCapture) return;
    setCaptureError(null);
    try {
      onCapture({ url, selector: null, screenshot: await captureElement(element) });
    } catch (error) {
      // 使用者拒絕或不支援：改成貼上或上傳圖片
      setCaptureError(error);
      setPasting(true);
    }
  }

  function attachImage(file: File | null | undefined) {
    if (!file || !onCapture) return;
    setPasting(false);
    onCapture({ url, selector: null, screenshot: file });
  }

  return (
    <section className="preview-panel" aria-label="Preview">
      <div className="preview-toolbar">
        <button type="button" aria-label="重新整理" onClick={() => setReloads((n) => n + 1)}>
          ⟳
        </button>
        <a className="preview-address" href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>
        {onCapture && (
          <button
            type="button"
            onClick={() => (canCaptureTab() ? void capture() : setPasting(true))}
          >
            附上整頁截圖留言
          </button>
        )}
      </div>
      {pasting && (
        <div
          className="preview-paste"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 要能接收貼上
          tabIndex={0}
          onPaste={(event) => attachImage(imageFromClipboard(event.clipboardData))}
        >
          {captureError ? <ErrorText error={captureError} /> : null}
          <p>無法自動截圖。請在這裡貼上截圖，或選擇圖片檔：</p>
          <input
            type="file"
            accept="image/*"
            aria-label="選擇截圖"
            onChange={(event) => attachImage(event.target.files?.[0])}
          />
        </div>
      )}
      <iframe
        key={reloads}
        ref={frame}
        className="preview-frame"
        title="Preview"
        src={url}
        // Preview 是 Agent 寫的程式：跑在自己的 origin（Preview 網址），不給 top navigation
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
      />
    </section>
  );
}
