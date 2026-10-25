// 工作區的預覽分頁（ARCHITECTURE §13、README「Preview」）：重新載入、狀態、網址、桌面／行動裝置寬度、
// 分享給團隊。
// - Desktop：經由 bridge 在這個區塊疊上內嵌瀏覽器（自己的 Run 開 localhost，別人的 Run 開 Preview 網址），
//   可以選取元素留言（附截圖、selector 與 URL）。
// - 一般瀏覽器：以 iframe 開 Preview 網址，不能選取元素，只能附整頁截圖。

import {
  type DesktopPreviewBridge,
  getDesktopBridge,
  type PreviewNavState,
} from "@orbis/desktop/bridge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Monitor,
  MousePointerClick,
  RotateCw,
  Share2,
  Smartphone,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ErrorText } from "../../components/ErrorText";
import { type Messages, useT } from "../../i18n";
import {
  type PreviewState,
  previewStateQuery,
  restartPreview,
  unavailableReason,
  uploadScreenshot,
} from "./preview-api";
import {
  loadPreviewDrafts,
  type PreviewCommentDraft,
  savePreviewDrafts,
  subscribePreviewDrafts,
} from "./preview-drafts";
import { canCaptureTab, captureElement, imageFromClipboard } from "./screenshot";
import "./preview.css";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

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

type Width = "desktop" | "mobile";

function stateLabel(t: Messages, state: PreviewState): { label: string; tone: string } {
  const p = t.workspace.preview;
  switch (state.status) {
    case "ready":
      return { label: p.stateLive, tone: "success" };
    case "starting":
      return { label: p.stateStarting, tone: "accent" };
    case "stopped":
      return { label: p.stateStopped, tone: "danger" };
    default:
      return { label: p.stateNone, tone: "muted" };
  }
}

export function PreviewPanel({ runId, canComment, canRestart }: PreviewPanelProps) {
  const t = useT();
  const p = t.workspace.preview;
  const [bridge] = useState(() => getDesktopBridge()?.preview ?? null);
  const queryClient = useQueryClient();
  const query = previewStateQuery(runId);
  const { data: state, error } = useQuery(query);
  const [capture, setCapture] = useState<PreviewCapture | null>(null);
  const [drafts, setDrafts] = useState(() => loadPreviewDrafts(runId));
  const [width, setWidth] = useState<Width>("desktop");
  const [reloads, setReloads] = useState(0);
  const [copied, setCopied] = useState(false);
  // 差異分頁退回後會清掉草稿：跟著更新
  useEffect(
    () => subscribePreviewDrafts(runId, () => setDrafts(loadPreviewDrafts(runId))),
    [runId],
  );
  const restart = useMutation({
    mutationFn: () => restartPreview(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  });
  if (error) return <ErrorText error={error} />;
  if (!state) return <div className="pv-center pv-muted">{t.common.loading}</div>;

  const reason = unavailableReason(state, bridge !== null);
  const { label, tone } = stateLabel(t, state);
  const url = state.shareUrl ?? state.localUrl ?? "";
  const onCapture = canComment ? setCapture : undefined;
  const update = (next: PreviewCommentDraft[]) => savePreviewDrafts(runId, next);

  function share() {
    if (!state?.shareUrl) return;
    void navigator.clipboard?.writeText(state.shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  const toolbar = (extra?: ReactNode) => (
    <div className="pv-toolbar">
      {!bridge && (
        <button
          type="button"
          className="pv-icon-btn"
          aria-label={p.reload}
          data-tip={p.reload}
          onClick={() => setReloads((n) => n + 1)}
        >
          <RotateCw {...ICON} />
        </button>
      )}
      <span className="pv-state" data-tone={tone}>
        <span className="pv-state-dot" />
        {label}
      </span>
      {extra ?? (
        <a
          className="pv-url"
          href={url || undefined}
          target="_blank"
          rel="noopener noreferrer"
          data-tip={url}
          data-tip-mono=""
        >
          {url}
        </a>
      )}
      <div className="pv-width" role="radiogroup" aria-label={p.width}>
        {(["desktop", "mobile"] as const).map((value) => (
          // biome-ignore lint/a11y/useSemanticElements: 圖示分段按鈕
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={width === value}
            aria-label={p[value]}
            data-tip={p[value]}
            className="pv-width-btn"
            onClick={() => setWidth(value)}
          >
            {value === "desktop" ? <Monitor {...ICON} /> : <Smartphone {...ICON} />}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="pv-btn"
        aria-disabled={!state.shareUrl || undefined}
        data-tip={state.shareUrl ? undefined : t.common.notAvailableYet}
        onClick={share}
      >
        <Share2 {...ICON} />
        {copied ? t.common.copied : p.share}
      </button>
    </div>
  );

  if (reason) {
    return (
      <div className="pv">
        {toolbar(<span className="pv-url" />)}
        <div className="pv-center">
          {reason === "starting" ? (
            <div className="pv-progress" role="progressbar" aria-label={p.stateStarting}>
              <div className="pv-progress-bar" />
            </div>
          ) : (
            <span className="pv-muted">
              {reason === "stopped"
                ? state.stopped
                  ? p.stoppedWith(
                      t.labels.previewStopReason[state.stopped.reason],
                      state.stopped.exitCode,
                    )
                  : p.notStarted
                : reason === "not_configured"
                  ? p.notConfigured
                  : p.noDomain}
            </span>
          )}
          {state.status === "stopped" && state.stopped?.output && (
            <pre className="pv-output">{state.stopped.output}</pre>
          )}
          {state.status === "stopped" && canRestart && (
            <button
              type="button"
              className="o-btn"
              data-variant="secondary"
              disabled={restart.isPending}
              onClick={() => restart.mutate()}
            >
              {state.stopped ? p.restart : p.start}
            </button>
          )}
          <ErrorText error={restart.error} />
        </div>
      </div>
    );
  }

  return (
    <div className="pv">
      {bridge ? (
        <DesktopPreview
          runId={runId}
          bridge={bridge}
          width={width}
          toolbar={toolbar}
          onCapture={onCapture}
        />
      ) : (
        <BrowserPreview
          url={state.shareUrl ?? ""}
          width={width}
          reloads={reloads}
          toolbar={toolbar}
          onCapture={onCapture}
        />
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
        <section className="pv-drafts" aria-label={p.drafts}>
          <div className="pv-drafts-head">
            <span className="pv-drafts-title">{p.drafts}</span>
            <span className="pv-mono-muted">{drafts.length}</span>
          </div>
          <span className="pv-muted">{p.draftsHint}</span>
          <ul>
            {drafts.map((draft, index) => (
              // 每則草稿的截圖都是剛上傳的 blob，ID 不會重複
              <li key={draft.screenshotBlobId ?? `${draft.url}|${draft.body}`}>
                <span className="pv-draft-body">{draft.body}</span>
                {draft.selector && <code className="pv-mono-muted">{draft.selector}</code>}
                <button
                  type="button"
                  className="pv-text-btn"
                  onClick={() => update(drafts.filter((_, i) => i !== index))}
                >
                  {t.common.delete}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ErrorText error={restart.error} />
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
  const t = useT();
  const p = t.workspace.preview;
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
      className="pv-comment"
      aria-label={p.commentForm}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <img className="pv-comment-shot" src={image} alt={p.shot} />
      <dl className="pv-comment-meta">
        {capture.selector && (
          <>
            <dt>{p.element}</dt>
            <dd>
              <code>{capture.selector}</code>
            </dd>
          </>
        )}
        <dt>{p.url}</dt>
        <dd>{capture.url}</dd>
      </dl>
      <textarea
        className="pv-textarea"
        aria-label={p.commentBody}
        placeholder={p.commentBody}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <ErrorText error={save.error} />
      <div className="pv-actions">
        <button type="button" className="o-btn" data-variant="ghost" onClick={onCancel}>
          {t.common.cancel}
        </button>
        <button
          type="submit"
          className="o-btn"
          data-variant="primary"
          disabled={body.trim() === "" || save.isPending}
        >
          {save.isPending ? p.uploading : p.addDraft}
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
  width,
  toolbar,
  onCapture,
}: {
  runId: string;
  bridge: DesktopPreviewBridge;
  width: Width;
  toolbar: (extra?: ReactNode) => ReactNode;
  onCapture?: (capture: PreviewCapture) => void;
}) {
  const t = useT();
  const p = t.workspace.preview;
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
    // 版面改變（視窗大小、側欄、分割線、寬度切換、捲動）時更新內嵌瀏覽器的位置
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
    <section className="pv-panel" aria-label={p.title}>
      {toolbar(
        <form className="pv-nav" onSubmit={go}>
          <button
            type="button"
            className="pv-icon-btn"
            aria-label={p.back}
            data-tip={p.back}
            disabled={!nav?.canGoBack}
            onClick={() => void bridge.goBack()}
          >
            <ArrowLeft {...ICON} />
          </button>
          <button
            type="button"
            className="pv-icon-btn"
            aria-label={p.forward}
            data-tip={p.forward}
            disabled={!nav?.canGoForward}
            onClick={() => void bridge.goForward()}
          >
            <ArrowRight {...ICON} />
          </button>
          <button
            type="button"
            className="pv-icon-btn"
            aria-label={p.reload}
            data-tip={p.reload}
            onClick={() => void bridge.reload()}
          >
            <RotateCw {...ICON} />
          </button>
          <input
            className="pv-address"
            aria-label={p.address}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>,
      )}
      <div className="pv-subbar">
        <button type="button" className="pv-text-btn" onClick={() => void bridge.openDevTools()}>
          {p.devTools}
        </button>
        {onCapture && (
          <button type="button" className="pv-btn" disabled={picking} onClick={() => void pick()}>
            <MousePointerClick {...ICON} />
            {picking ? p.picking : p.pick}
          </button>
        )}
      </div>
      {failure && <p className="pv-muted pv-failure">{failure}</p>}
      <div className="pv-stage">
        {/* 內嵌瀏覽器由 Desktop 疊在這個區塊上 */}
        <div ref={area} className="pv-frame" data-width={width} data-testid="preview-area" />
      </div>
    </section>
  );
}

function BrowserPreview({
  url,
  width,
  reloads,
  toolbar,
  onCapture,
}: {
  url: string;
  width: Width;
  reloads: number;
  toolbar: (extra?: ReactNode) => ReactNode;
  onCapture?: (capture: PreviewCapture) => void;
}) {
  const t = useT();
  const p = t.workspace.preview;
  const frame = useRef<HTMLIFrameElement>(null);
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
    <section className="pv-panel" aria-label={p.title}>
      {toolbar()}
      {onCapture && (
        <div className="pv-subbar">
          <button
            type="button"
            className="pv-btn"
            onClick={() => (canCaptureTab() ? void capture() : setPasting(true))}
          >
            <MousePointerClick {...ICON} />
            {p.capture}
          </button>
        </div>
      )}
      {pasting && (
        <div
          className="pv-paste"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 要能接收貼上
          tabIndex={0}
          onPaste={(event) => attachImage(imageFromClipboard(event.clipboardData))}
        >
          {captureError ? <ErrorText error={captureError} /> : null}
          <p>{p.pasteHint}</p>
          <input
            type="file"
            accept="image/*"
            aria-label={p.chooseImage}
            onChange={(event) => attachImage(event.target.files?.[0])}
          />
        </div>
      )}
      <div className="pv-stage">
        <iframe
          key={reloads}
          ref={frame}
          className="pv-frame"
          data-width={width}
          title={p.title}
          src={url}
          // Preview 是 Agent 寫的程式：跑在自己的 origin（Preview 網址），不給 top navigation
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
        />
      </div>
    </section>
  );
}
