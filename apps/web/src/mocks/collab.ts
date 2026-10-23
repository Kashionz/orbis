// MSW 假後端的共同編輯伺服器：在頁面中以 y-websocket 協定（sync step 1／2、update、awareness）
// 回應 `/api/collab/<文件名稱>`，行為對照 Server（apps/server/src/collab）：
// - 文件不存在時以 4404 關閉；`collabClose` 設定可以模擬 4401／4403。
// - 唯讀（Viewer）連線送來的修改一律丟棄，不斷線。
// - 文件改變時交給 MockBackend 保存，並把內容轉成 markdown 回寫 Task 描述或條件的描述。
//
// 每個頁面各有一份假後端，所以同步只限同一頁面中的連線；兩個瀏覽器 context 的同步由完整系統 e2e 驗證。

import { COLLAB_FRAGMENT, type CollabMentionAttrs } from "@orbis/api-contract";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** MockBackend 提供給共同編輯伺服器的介面。 */
export interface CollabBackend {
  /** 文件是否存在、是否唯讀；不存在時為 null。 */
  collabAccess(docName: string): { readOnly: boolean; initialMarkdown: string } | null;
  /** 保存的 Yjs 狀態（base64）；還沒有時為 null。 */
  collabSnapshot(docName: string): string | null;
  saveCollabDocument(
    docName: string,
    snapshot: string,
    markdown: string,
    mentions: CollabMentionAttrs[],
  ): void;
  /** 模擬連線被 Server 關閉的 close code。 */
  readonly collabCloseCode: number | null;
  /** 模擬另一位在線的成員（Server 的 awareness 狀態）。 */
  readonly collabPeer: { name: string; color: string; editText: string | null } | null;
}

interface Connection {
  send: (data: Uint8Array) => void;
  readOnly: boolean;
}

interface Room {
  /** 已經模擬過另一位成員的修改。 */
  peerEdited: boolean;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Set<Connection>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** 簡單的 markdown → 段落（假後端只需要段落與標題）。 */
function seed(fragment: Y.XmlFragment, markdown: string): void {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  fragment.insert(
    0,
    blocks.map((block) => {
      const heading = /^(#{1,6})\s+(.*)$/.exec(block);
      const element = new Y.XmlElement(heading ? "heading" : "paragraph");
      if (heading) element.setAttribute("level", String(heading[1]?.length ?? 1) as never);
      element.insert(0, [new Y.XmlText(heading ? (heading[2] ?? "") : block)]);
      return element;
    }),
  );
}

/** 文件內容轉成 markdown（假後端的簡化版：段落、標題、清單項目、mention token）。 */
export function fragmentToMarkdown(fragment: Y.XmlFragment): {
  markdown: string;
  mentions: CollabMentionAttrs[];
} {
  const mentions: CollabMentionAttrs[] = [];
  const inline = (element: Y.XmlElement | Y.XmlFragment): string =>
    element
      .toArray()
      .map((child) => {
        if (child instanceof Y.XmlText) {
          return child
            .toDelta()
            .map((op: { insert?: unknown }) => (typeof op.insert === "string" ? op.insert : ""))
            .join("");
        }
        if (child instanceof Y.XmlElement && child.nodeName === "mention") {
          const attrs = child.getAttributes() as unknown as CollabMentionAttrs;
          mentions.push(attrs);
          return `@[${attrs.label}](${attrs.id})`;
        }
        if (child instanceof Y.XmlElement) return inline(child);
        return "";
      })
      .join("");
  const blocks = fragment.toArray().map((child) => {
    if (!(child instanceof Y.XmlElement)) return "";
    if (child.nodeName === "heading") {
      const level = Number(child.getAttribute("level") ?? 1);
      return `${"#".repeat(level)} ${inline(child)}`;
    }
    if (child.nodeName === "bulletList" || child.nodeName === "orderedList") {
      return child
        .toArray()
        .map((item, index) =>
          item instanceof Y.XmlElement
            ? `${child.nodeName === "bulletList" ? "-" : `${index + 1}.`} ${inline(item)}`
            : "",
        )
        .join("\n");
    }
    return inline(child);
  });
  return { markdown: blocks.filter(Boolean).join("\n\n"), mentions };
}

export class MockCollabServer {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly backend: CollabBackend) {}

  /** 新的連線。回傳處理訊息與關閉的函式；連線被拒時回傳 close code。 */
  connect(
    docName: string,
    send: (data: Uint8Array) => void,
  ): number | { onMessage: (data: Uint8Array) => void; onClose: () => void } {
    if (this.backend.collabCloseCode !== null) return this.backend.collabCloseCode;
    const access = this.backend.collabAccess(docName);
    if (!access) return 4404;
    const room = this.room(docName, access.initialMarkdown);
    const connection: Connection = { send, readOnly: access.readOnly };
    room.connections.add(connection);

    // 先送 sync step 1 與目前的 awareness
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(encoding.toUint8Array(encoder));
    const states = [...room.awareness.getStates().keys()];
    if (states.length > 0) {
      send(this.awarenessMessage(room.awareness, states));
    }

    const peer = this.backend.collabPeer;
    // 每份文件只模擬一次（開發模式的 StrictMode 會連線兩次）
    if (peer?.editText && !room.peerEdited) {
      room.peerEdited = true;
      // 模擬另一位成員在稍後加入一段文字
      const editText = peer.editText;
      setTimeout(() => {
        if (!this.rooms.has(docName)) return;
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText(editText)]);
        const fragment = room.doc.getXmlFragment(COLLAB_FRAGMENT);
        room.doc.transact(() => fragment.insert(fragment.length, [paragraph]), "peer");
      }, 300);
    }

    return {
      onMessage: (data) => this.handle(room, connection, data),
      onClose: () => {
        room.connections.delete(connection);
      },
    };
  }

  private room(docName: string, initialMarkdown: string): Room {
    const existing = this.rooms.get(docName);
    if (existing) return existing;
    const doc = new Y.Doc();
    const snapshot = this.backend.collabSnapshot(docName);
    if (snapshot) {
      Y.applyUpdate(doc, fromBase64(snapshot));
    } else {
      doc.transact(() => seed(doc.getXmlFragment(COLLAB_FRAGMENT), initialMarkdown), "seed");
    }
    const awareness = new awarenessProtocol.Awareness(doc);
    const peer = this.backend.collabPeer;
    awareness.setLocalState(peer ? { user: { name: peer.name, color: peer.color } } : null);
    const room: Room = { doc, awareness, connections: new Set(), peerEdited: false };

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const connection of room.connections) {
        if (connection !== origin) connection.send(message);
      }
      const { markdown, mentions } = fragmentToMarkdown(doc.getXmlFragment(COLLAB_FRAGMENT));
      this.backend.saveCollabDocument(
        docName,
        toBase64(Y.encodeStateAsUpdate(doc)),
        markdown,
        mentions,
      );
    });
    awareness.on(
      "update",
      ({ added, updated, removed }: Record<"added" | "updated" | "removed", number[]>) => {
        const message = this.awarenessMessage(awareness, [...added, ...updated, ...removed]);
        for (const connection of room.connections) connection.send(message);
      },
    );
    this.rooms.set(docName, room);
    return room;
  }

  private awarenessMessage(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
    );
    return encoding.toUint8Array(encoder);
  }

  private handle(room: Room, connection: Connection, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        connection,
      );
      return;
    }
    if (type !== MESSAGE_SYNC) return;
    const subtype = decoding.readVarUint(decoder);
    if (subtype === syncProtocol.messageYjsSyncStep1) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep2(encoder, room.doc, decoding.readVarUint8Array(decoder));
      connection.send(encoding.toUint8Array(encoder));
      return;
    }
    // sync step 2 與 update：唯讀連線的修改丟棄，不斷線
    if (connection.readOnly) return;
    Y.applyUpdate(room.doc, decoding.readVarUint8Array(decoder), connection);
  }
}
