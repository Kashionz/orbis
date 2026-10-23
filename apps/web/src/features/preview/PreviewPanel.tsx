// Run 頁面的 Preview 分頁（ARCHITECTURE §13）。C 軌的 Run 頁面掛載 `<PreviewPanel runId />`。
// - Desktop：經由 bridge 在這個區塊疊上內嵌瀏覽器（自己的 Run 開 localhost，別人的 Run 開 Preview 網址），
//   可以選取元素留言（附截圖、selector 與 URL）。
// - 一般瀏覽器：以 iframe 開 Preview 網址，不能選取元素，只能附整頁截圖。

import {
  type DesktopPreviewBridge,
  getDesktopBridge,
  type PreviewNavState,
} from "@orbis/desktop/bridge";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ErrorText } from "../../components/ErrorText";
import { previewStateQuery, unavailableMessage } from "./preview-api";
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
  /** 擷取到截圖時呼叫（之後開啟留言框）。 */
  onCapture?: (capture: PreviewCapture) => void;
}

export function PreviewPanel({ runId, onCapture }: PreviewPanelProps) {
  const [bridge] = useState(() => getDesktopBridge()?.preview ?? null);
  const { data: state, error } = useQuery(previewStateQuery(runId));
  if (error) return <ErrorText error={error} />;
  if (!state) return <p className="preview-message">載入中…</p>;
  const message = unavailableMessage(state, bridge !== null);
  if (message) return <p className="preview-message">{message}</p>;
  if (bridge) return <DesktopPreview runId={runId} bridge={bridge} onCapture={onCapture} />;
  return <BrowserPreview url={state.shareUrl ?? ""} onCapture={onCapture} />;
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
