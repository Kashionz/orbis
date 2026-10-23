// 一份共同編輯文件在 Server 上的狀態：Y.Doc、awareness（游標與在線狀態）與連上的 client。
// 收到的 update 轉送給其他 client，並在 debounce 後把快照寫進 CollabStore。

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Logger } from "../logger";
import type { CollabDocRef } from "./doc-name";
import { COLLAB_FRAGMENT, fragmentToMarkdown, replaceFragmentWithMarkdown } from "./markdown";
import type { CollabStore } from "./store";

/** y-websocket 協定的訊息種類（第一個 varUint）。 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;
/** 一條連線最多能宣告幾個 awareness client id（同一個分頁重新載入 Y.Doc 時會換新的 id）。 */
export const MAX_AWARENESS_IDS_PER_PEER = 4;

/** Server 以 REST／GitHub 的內容取代文件時的 transaction origin。 */
const EXTERNAL_ORIGIN = Symbol("external");

/** 房間中的一個 client。 */
export interface CollabPeer {
  /** 連線者（已認證）。Server 會把它寫進這條連線的 awareness 狀態，其他 client 可以信任這個欄位。 */
  readonly memberId: string;
  /** 是否可以修改文件；唯讀的 client 送來的 update 一律丟棄。 */
  readonly writable: boolean;
  send(message: Uint8Array): void;
}

/** 文件快照寫進 CollabStore 之後呼叫（例如把內容回寫成 markdown）。 */
export type CollabPersistHook = (ref: CollabDocRef, doc: Y.Doc) => Promise<void>;

export class CollabRoom {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** 每個 client 透過 awareness 宣告的 client id，斷線時一併移除。 */
  private readonly peers = new Map<CollabPeer, Set<number>>();
  private persistTimer: NodeJS.Timeout | null = null;
  private persisting: Promise<void> = Promise.resolve();
  private dirty = false;
  /** 已通過權限檢查、正在完成 WebSocket upgrade 的 client 數（避免這段期間被卸載）。 */
  private reserved = 0;

  constructor(
    readonly ref: CollabDocRef,
    private readonly store: CollabStore,
    private readonly log: Logger,
    private readonly persistDebounceMs: number,
    private readonly onPersisted?: CollabPersistHook,
  ) {
    // Server 自己不出現在在線名單中。
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const peer of this.peers.keys()) if (peer !== origin) peer.send(message);
      if (origin !== this.store) this.schedulePersist();
    });
    this.awareness.on(
      "update",
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...changes.added, ...changes.updated, ...changes.removed];
        const owned = this.peers.get(origin as CollabPeer);
        if (owned) {
          for (const id of changes.added) owned.add(id);
          for (const id of changes.removed) owned.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        const message = encoding.toUint8Array(encoder);
        for (const peer of this.peers.keys()) peer.send(message);
      },
    );
  }

  /**
   * 從 CollabStore 載入快照。還沒有快照時以 `seed()` 的 markdown 建立內容，並立刻保存：
   * 否則 Server 在寫回前重新啟動、又重建一次時，client 手上的舊文件會和新建的內容重複。
   */
  async load(seed: () => Promise<string | null>): Promise<void> {
    const state = await this.store.load(this.ref);
    if (state) {
      Y.applyUpdate(this.doc, state, this.store);
      return;
    }
    const markdown = await seed();
    if (!markdown) return;
    replaceFragmentWithMarkdown(this.fragment, markdown, this.store);
    await this.store.save(this.ref, Y.encodeStateAsUpdate(this.doc));
  }

  /** TipTap 編輯的內容。 */
  get fragment(): Y.XmlFragment {
    return this.doc.getXmlFragment(COLLAB_FRAGMENT);
  }

  /** 目前內容的 markdown。 */
  markdown(): string {
    return fragmentToMarkdown(this.fragment);
  }

  /**
   * 以 markdown 取代內容（描述被 REST 或 GitHub 改掉時，最後寫入者為準）。
   * 內容相同時不做任何事，回傳是否有修改。
   */
  replaceMarkdown(markdown: string): boolean {
    if (this.markdown() === markdown.trim()) return false;
    replaceFragmentWithMarkdown(this.fragment, markdown, EXTERNAL_ORIGIN);
    return true;
  }

  /** 連上的 client 數，包含正在完成 upgrade 的。 */
  get peerCount(): number {
    return this.peers.size + this.reserved;
  }

  /** 預留一個位置給正在完成 upgrade 的 client；之後以 join() 或 unreserve() 結束。 */
  reserve(): void {
    this.reserved += 1;
  }

  unreserve(): void {
    this.reserved = Math.max(0, this.reserved - 1);
  }

  /** 加入 client（用掉 reserve() 的位置）：送出 Server 的 state vector（sync step 1）與目前的在線狀態。 */
  join(peer: CollabPeer): void {
    this.unreserve();
    this.peers.set(peer, new Set());
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, this.doc);
    peer.send(encoding.toUint8Array(sync));
    this.sendAwareness(peer);
  }

  /** 移除 client 與它的在線狀態。 */
  leave(peer: CollabPeer): void {
    const owned = this.peers.get(peer);
    this.peers.delete(peer);
    if (owned && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...owned], null);
    }
  }

  /** 處理 client 送來的一則訊息。格式錯誤時丟出例外，由呼叫端關閉連線。 */
  receive(peer: CollabPeer, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_SYNC: {
        const syncType = decoding.readVarUint(decoder);
        if (syncType === syncProtocol.messageYjsSyncStep1) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncStep1(decoder, encoder, this.doc);
          peer.send(encoding.toUint8Array(encoder));
        } else if (
          syncType === syncProtocol.messageYjsSyncStep2 ||
          syncType === syncProtocol.messageYjsUpdate
        ) {
          const update = decoding.readVarUint8Array(decoder);
          // 唯讀的 client（Viewer）不能修改文件。
          if (peer.writable) Y.applyUpdate(this.doc, update, peer);
        } else {
          throw new Error(`不認得的 sync 訊息：${syncType}`);
        }
        return;
      }
      case MESSAGE_AWARENESS: {
        const update = this.sanitizeAwareness(peer, decoding.readVarUint8Array(decoder));
        if (update) awarenessProtocol.applyAwarenessUpdate(this.awareness, update, peer);
        return;
      }
      case MESSAGE_QUERY_AWARENESS:
        this.sendAwareness(peer);
        return;
      default:
        throw new Error(`不認得的訊息種類：${type}`);
    }
  }

  /**
   * 過濾 client 送來的 awareness update，避免冒用別人的在線狀態：
   * - 已被其他連線使用的 client id 一律忽略；
   * - 每條連線最多 MAX_AWARENESS_IDS_PER_PEER 個 client id；
   * - 狀態中的 `memberId` 一律改成這條連線的 Member。
   * 編碼格式同 y-protocols 的 encodeAwarenessUpdate：數量，接著每筆 clientID、clock、JSON 狀態。
   */
  private sanitizeAwareness(peer: CollabPeer, update: Uint8Array): Uint8Array | null {
    const owned = this.peers.get(peer);
    if (!owned) return null;
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    const accepted: { clientId: number; clock: number; state: string }[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const raw = decoding.readVarString(decoder);
      const ownedByOther = [...this.peers].some(
        ([other, ids]) => other !== peer && ids.has(clientId),
      );
      if (ownedByOther) continue;
      if (!owned.has(clientId) && owned.size >= MAX_AWARENESS_IDS_PER_PEER) continue;
      const state: unknown = JSON.parse(raw);
      const stamped =
        state !== null && typeof state === "object" && !Array.isArray(state)
          ? JSON.stringify({ ...state, memberId: peer.memberId })
          : "null";
      accepted.push({ clientId, clock, state: stamped });
      owned.add(clientId);
    }
    if (accepted.length === 0) return null;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, accepted.length);
    for (const entry of accepted) {
      encoding.writeVarUint(encoder, entry.clientId);
      encoding.writeVarUint(encoder, entry.clock);
      encoding.writeVarString(encoder, entry.state);
    }
    return encoding.toUint8Array(encoder);
  }

  private sendAwareness(peer: CollabPeer): void {
    const states = [...this.awareness.getStates().keys()];
    if (states.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, states),
    );
    peer.send(encoding.toUint8Array(encoder));
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, this.persistDebounceMs);
    this.persistTimer.unref();
  }

  /** 立刻把尚未保存的變更寫進 CollabStore（依序執行，不會同時寫兩次）。 */
  flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persisting = this.persisting.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await this.store.save(this.ref, Y.encodeStateAsUpdate(this.doc));
        await this.onPersisted?.(this.ref, this.doc);
      } catch (error) {
        // 留到下一次再寫；文件還在記憶體中。
        this.dirty = true;
        this.log.error({ err: error, doc: this.ref.name }, "保存共同編輯文件失敗");
      }
    });
    return this.persisting;
  }

  destroy(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }
}
