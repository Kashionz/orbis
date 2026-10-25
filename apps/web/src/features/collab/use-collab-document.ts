// 共同編輯文件的連線（ARCHITECTURE §12.1）：Yjs over y-websocket，路徑 `API_ROUTES.collab`。
// 以 session cookie 認證；Server 以 COLLAB_CLOSE_CODES 關閉時（未登入、沒有權限、找不到文件）不再重連。

import {
  API_ROUTES,
  COLLAB_CLOSE_CODES,
  type CollabDocumentRef,
  formatCollabDocName,
} from "@orbis/api-contract";
import { useEffect, useState, useSyncExternalStore } from "react";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

export type CollabStatus = "connecting" | "connected" | "disconnected";

/** 連線被 Server 關閉、不會再重連的原因。 */
export type CollabFailure = "unauthorized" | "forbidden" | "not_found";

const FAILURES: Record<number, CollabFailure> = {
  [COLLAB_CLOSE_CODES.unauthorized]: "unauthorized",
  [COLLAB_CLOSE_CODES.forbidden]: "forbidden",
  [COLLAB_CLOSE_CODES.notFound]: "not_found",
};

/** 在線的人（awareness 的 `user` 欄位）。 */
export interface CollabUser {
  name: string;
  color: string;
}

/** `/api/collab` 的 WebSocket 網址（y-websocket 會在後面加上 `/<文件名稱>`）。 */
export function collabServerUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = API_ROUTES.collab.slice(0, API_ROUTES.collab.indexOf("/:docName"));
  return `${protocol}//${window.location.host}${base}`;
}

const COLORS = ["#d73a49", "#6f42c1", "#005cc5", "#22863a", "#e36209", "#b08800", "#032f62"];

/** 依名稱固定一個游標顏色。 */
export function userColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return COLORS[hash % COLORS.length] ?? "#005cc5";
}

export interface CollabDocument {
  docName: string;
  doc: Y.Doc;
  provider: WebsocketProvider;
}

/** 建立一份文件的連線；元件卸載或文件改變時關閉。 */
export function useCollabDocument(ref: CollabDocumentRef, user: CollabUser) {
  const docName = formatCollabDocName(ref);
  const [state, setState] = useState<CollabDocument | null>(null);
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [synced, setSynced] = useState(false);
  /** 這份文件至少同步過一次（斷線重連時 synced 會暫時變回 false，編輯器不需要重建）。 */
  const [everSynced, setEverSynced] = useState(false);
  const [failure, setFailure] = useState<CollabFailure | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(collabServerUrl(), docName, doc, {
      // 同一個瀏覽器的其他分頁也經由 Server 同步，權限一律以 Server 為準
      disableBc: true,
    });
    provider.awareness.setLocalStateField("user", user);
    provider.on("status", ({ status }) => setStatus(status));
    provider.on("sync", (value) => {
      setSynced(value);
      if (value) setEverSynced(true);
    });
    provider.on("closed", ({ code }) => setFailure(FAILURES[code] ?? null));
    setState({ docName, doc, provider });
    setStatus("connecting");
    setSynced(false);
    setEverSynced(false);
    setFailure(null);
    return () => {
      provider.destroy();
      doc.destroy();
      setState(null);
    };
  }, [docName, user]);

  return { document: state, status, synced, everSynced, failure };
}

/** 文件中在線的人（不含自己），awareness 改變時更新。 */
export function useCollabPeers(document: CollabDocument | null): CollabUser[] {
  const awareness = document?.provider.awareness ?? null;
  const snapshot = useSyncExternalStore(
    (onChange) => {
      awareness?.on("change", onChange);
      return () => awareness?.off("change", onChange);
    },
    () => (awareness ? peersKey(awareness.getStates(), awareness.clientID) : ""),
  );
  return snapshot === "" ? [] : (JSON.parse(snapshot) as CollabUser[]);
}

/** 以字串作為 useSyncExternalStore 的快照，內容不變時不重新渲染。 */
function peersKey(states: Map<number, Record<string, unknown>>, self: number): string {
  const users: CollabUser[] = [];
  for (const [client, state] of states) {
    const user = state.user as CollabUser | undefined;
    if (client !== self && user?.name) users.push(user);
  }
  return users.length === 0 ? "" : JSON.stringify(users);
}
