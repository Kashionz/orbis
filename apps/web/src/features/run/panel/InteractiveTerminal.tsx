// 互動式終端機（ADR-0014、ARCHITECTURE §6.5）：Runner 在 Run 的 Worktree 中開 PTY，輸入輸出經由 Server 的
// WebSocket（`API_ROUTES.terminalWs`）到這裡的 xterm.js。資料以 base64 傳送。
// - 關閉分頁（或 WebSocket 斷線）就關閉終端機，不支援重新接上。
// - 終端機的查詢（例如 ConPTY 開始時的 `ESC[6n` 游標位置）由 xterm.js 回覆，經由輸入送回 Runner。

import {
  type TerminalClientMessage,
  type TerminalExitReason,
  TerminalServerMessage,
} from "@orbis/api-contract";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n";
import "@xterm/xterm/css/xterm.css";

/** UTF-8 字串轉成 base64。 */
export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 轉成位元組（輸出可能在多位元組字元的中間斷開，交給 xterm.js 組回）。 */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 同源的 WebSocket 網址（`wsUrl` 是路徑）。 */
export function terminalSocketUrl(wsUrl: string, location: Location = window.location): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${wsUrl}`;
}

export type TerminalEnd =
  | { kind: "exited"; code: number | null; reason: TerminalExitReason }
  | { kind: "error"; message: string };

export function InteractiveTerminal({
  wsUrl,
  active,
  onEnd,
}: {
  wsUrl: string;
  /** 目前顯示的分頁（切換回來時重新調整大小）。 */
  active: boolean;
  onEnd: (end: TerminalEnd) => void;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const [ended, setEnded] = useState<TerminalEnd | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      fontSize: 12,
      convertEol: false,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // 容器還沒有大小（例如分頁隱藏中）
    }
    const socket = new WebSocket(terminalSocketUrl(wsUrl));
    const send = (message: TerminalClientMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const finish = (end: TerminalEnd) => {
      setEnded((current) => current ?? end);
      onEndRef.current(end);
    };
    socket.addEventListener("open", () => {
      send({ type: "resize", cols: term.cols, rows: term.rows });
      term.focus();
    });
    socket.addEventListener("message", (event) => {
      let parsed: TerminalServerMessage;
      try {
        parsed = TerminalServerMessage.parse(JSON.parse(String(event.data)));
      } catch {
        return;
      }
      if (parsed.type === "output") term.write(decodeBase64(parsed.data));
      else if (parsed.type === "exited") {
        finish({ kind: "exited", code: parsed.code, reason: parsed.reason });
      } else finish({ kind: "error", message: parsed.message });
    });
    socket.addEventListener("close", () =>
      finish({ kind: "exited", code: null, reason: "closed" }),
    );
    const input = term.onData((data) => send({ type: "input", data: encodeBase64(data) }));
    const resize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // 分頁隱藏時沒有大小
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket.close();
      term.dispose();
      fitRef.current = null;
    };
  }, [wsUrl]);

  useEffect(() => {
    if (!active) return;
    try {
      fitRef.current?.fit();
    } catch {
      // 還沒有大小
    }
  }, [active]);

  return (
    <div className="rp-xterm-wrap">
      <div ref={containerRef} className="rp-xterm" data-testid="interactive-terminal" />
      {ended && (
        <div className="rp-xterm-ended" role="status">
          {ended.kind === "exited"
            ? t.workspace.terminal.ended(t.workspace.terminal.exitReason[ended.reason] ?? "")
            : ended.message}
        </div>
      )}
    </div>
  );
}
