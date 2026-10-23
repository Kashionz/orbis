// 共同編輯文件的管理（ARCHITECTURE §12.1）：載入中的文件、快照的寫回，以及文件與資料庫內容的同步。
//
// - 第一次開啟：以資料庫中的內容（Task 描述、Acceptance Criterion 的描述）建立文件。
// - 存檔後：把文件轉成 markdown 回寫資料庫；Task 描述改變時發出 task.updated（照常同步到 GitHub）。
// - 描述被 REST 或 GitHub 改掉時：以新的內容取代文件（最後寫入者為準，同 §11）。內容相同時不動，
//   所以回寫與同步不會互相觸發。
// - Repo Spec 草稿沒有對應的資料庫欄位，只存在文件中；「提交到 repo」時由 D 軌取出 markdown。

import { COLLAB_FRAGMENT } from "@orbis/api-contract";
import { and, eq, ne } from "drizzle-orm";
import * as Y from "yjs";
import type { Database } from "../db/client";
import { acceptanceCriteria, repoSpecs, repos, tasks } from "../db/schema";
import { inTransaction } from "../db/tx";
import type { DomainEvents } from "../domain/events";
import type { Logger } from "../logger";
import type { MentionService } from "../mentions/service";
import { type CollabDocRef, collabDocRef } from "./doc-name";
import { fragmentToMarkdown, replaceFragmentWithMarkdown } from "./markdown";
import { CollabRoom } from "./room";
import type { CollabStore } from "./store";

/** 文件修改後多久寫回 CollabStore。 */
export const COLLAB_PERSIST_DEBOUNCE_MS = 1_000;

export interface CollabHubOptions {
  db: Database;
  mentions: MentionService;
  store: CollabStore;
  events: DomainEvents;
  logger: Logger;
  persistDebounceMs?: number;
}

export class CollabHub {
  private readonly rooms = new Map<string, Promise<CollabRoom>>();
  private readonly log: Logger;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: CollabHubOptions) {
    this.log = options.logger.child({ component: "collab" });
    this.unsubscribe = options.events.subscribe(async (event) => {
      if (event.type !== "task.updated" || event.source === "collab") return;
      if (!event.fields.includes("description")) return;
      const [task] = await options.db
        .select({ description: tasks.description })
        .from(tasks)
        .where(eq(tasks.id, event.taskId));
      if (task)
        await this.applyMarkdown(collabDocRef("task-description", event.taskId), task.description);
    });
  }

  /** 取得（必要時載入）文件。 */
  open(ref: CollabDocRef): Promise<CollabRoom> {
    let room = this.rooms.get(ref.name);
    if (!room) {
      const created = new CollabRoom(
        ref,
        this.options.store,
        this.log,
        this.options.persistDebounceMs ?? COLLAB_PERSIST_DEBOUNCE_MS,
        (r, doc, authors) => this.writeBack(r, doc, authors),
      );
      room = created.load(() => this.seed(ref)).then(() => created);
      room.catch(() => this.rooms.delete(ref.name));
      this.rooms.set(ref.name, room);
    }
    return room;
  }

  /** 沒有 client 時寫回並卸載（寫回期間又有人連上就保留）。 */
  async release(room: CollabRoom): Promise<void> {
    if (room.peerCount > 0) return;
    await room.flush();
    if (room.peerCount > 0 || (await this.rooms.get(room.ref.name)) !== room) return;
    this.rooms.delete(room.ref.name);
    room.destroy();
  }

  get openDocumentCount(): number {
    return this.rooms.size;
  }

  /**
   * 文件所屬的內容被 REST 或 GitHub 改掉：文件載入中就直接取代（連上的 client 立刻看到），
   * 沒有載入但已有快照時，在快照上取代後寫回（保留文件的歷史，離線的 client 回來時不會重複）。
   */
  async applyMarkdown(ref: CollabDocRef, markdown: string): Promise<void> {
    const opened = this.rooms.get(ref.name);
    if (opened) {
      const room = await opened;
      if (room.replaceMarkdown(markdown)) await room.flush();
      return;
    }
    const state = await this.options.store.load(ref);
    if (!state) return;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
      const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
      if (fragmentToMarkdown(fragment) === markdown.trim()) return;
      replaceFragmentWithMarkdown(fragment, markdown);
      await this.options.store.save(ref, Y.encodeStateAsUpdate(doc));
    } finally {
      doc.destroy();
    }
  }

  /** 文件目前的 markdown（例如 Repo Spec 草稿提交到 repo 時）；沒有內容時為空字串。 */
  async markdown(ref: CollabDocRef): Promise<string> {
    const opened = this.rooms.get(ref.name);
    if (opened) return (await opened).markdown();
    const state = await this.options.store.load(ref);
    if (!state) return "";
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
      return fragmentToMarkdown(doc.getXmlFragment(COLLAB_FRAGMENT));
    } finally {
      doc.destroy();
    }
  }

  /** 把所有載入中的文件寫回 CollabStore。 */
  async flush(): Promise<void> {
    const opened = await Promise.allSettled([...this.rooms.values()]);
    await Promise.all(
      opened.flatMap((result) => (result.status === "fulfilled" ? [result.value.flush()] : [])),
    );
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await this.flush();
    for (const room of await Promise.allSettled([...this.rooms.values()])) {
      if (room.status === "fulfilled") room.value.destroy();
    }
    this.rooms.clear();
  }

  /** 第一次開啟時的內容。 */
  private async seed(ref: CollabDocRef): Promise<string | null> {
    const { db } = this.options;
    switch (ref.kind) {
      case "task-description": {
        const [task] = await db
          .select({ description: tasks.description })
          .from(tasks)
          .where(eq(tasks.id, ref.id));
        return task?.description ?? null;
      }
      case "acceptance-criterion": {
        const [criterion] = await db
          .select({ description: acceptanceCriteria.description })
          .from(acceptanceCriteria)
          .where(eq(acceptanceCriteria.id, ref.id));
        return criterion?.description ?? null;
      }
      case "repo-spec-draft":
        return null;
    }
  }

  /** 存檔後把內容回寫資料庫。 */
  private async writeBack(
    ref: CollabDocRef,
    doc: Y.Doc,
    authors: ReadonlyMap<string, string>,
  ): Promise<void> {
    await this.processMentions(ref, doc, authors);
    const markdown = fragmentToMarkdown(doc.getXmlFragment(COLLAB_FRAGMENT));
    const { db, events } = this.options;
    switch (ref.kind) {
      case "task-description": {
        const [updated] = await db
          .update(tasks)
          .set({ description: markdown })
          .where(and(eq(tasks.id, ref.id), ne(tasks.description, markdown)))
          .returning({ id: tasks.id, projectId: tasks.projectId });
        if (updated) {
          await events.emit({
            type: "task.updated",
            taskId: updated.id,
            projectId: updated.projectId,
            fields: ["description"],
            source: "collab",
            actorMemberId: null,
          });
        }
        return;
      }
      case "acceptance-criterion":
        // Acceptance Criterion 的描述不可以是空的；清空時保留原本的描述。
        if (markdown === "") return;
        await db
          .update(acceptanceCriteria)
          .set({ description: markdown })
          .where(
            and(eq(acceptanceCriteria.id, ref.id), ne(acceptanceCriteria.description, markdown)),
          );
        return;
      case "repo-spec-draft":
        return;
    }
  }

  /** 文件中新出現的 mention 節點（以 nodeId 去重）：@member 通知，@agent 建立 consult Run。 */
  private async processMentions(
    ref: CollabDocRef,
    doc: Y.Doc,
    authors: ReadonlyMap<string, string>,
  ): Promise<void> {
    const nodes = mentionNodes(doc.getXmlFragment(COLLAB_FRAGMENT));
    if (nodes.length === 0) return;
    const { db } = this.options;
    const owner = await documentOwner(db, ref);
    if (!owner) return;
    await inTransaction(db, (uow) =>
      this.options.mentions.processNodes(
        uow,
        { kind: "collab_document", id: ref.name },
        {
          projectId: owner.projectId,
          task: owner.task,
          text: fragmentToMarkdown(doc.getXmlFragment(COLLAB_FRAGMENT)),
        },
        nodes.map((node) => ({ ...node, authorMemberId: authors.get(node.nodeId) ?? null })),
      ),
    );
  }
}

/** 文件中所有的 mention 節點。 */
function mentionNodes(fragment: Y.XmlFragment): { id: string; label: string; nodeId: string }[] {
  const found: { id: string; label: string; nodeId: string }[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "mention") {
        const id = child.getAttribute("id");
        const nodeId = child.getAttribute("nodeId");
        if (typeof id === "string" && typeof nodeId === "string") {
          found.push({ id, nodeId, label: String(child.getAttribute("label") ?? id) });
        }
      } else walk(child);
    }
  };
  walk(fragment);
  return found;
}

/** 文件所屬的 Project 與 Task（Repo Spec 草稿沒有 Task）。 */
async function documentOwner(
  db: Database,
  ref: CollabDocRef,
): Promise<{ projectId: string; task: typeof tasks.$inferSelect | null } | null> {
  if (ref.kind === "repo-spec-draft") {
    const [spec] = await db
      .select({ projectId: repos.projectId })
      .from(repoSpecs)
      .innerJoin(repos, eq(repos.id, repoSpecs.repoId))
      .where(eq(repoSpecs.id, ref.id));
    return spec ? { projectId: spec.projectId, task: null } : null;
  }
  const taskId =
    ref.kind === "task-description"
      ? ref.id
      : (
          await db
            .select({ taskId: acceptanceCriteria.taskId })
            .from(acceptanceCriteria)
            .where(eq(acceptanceCriteria.id, ref.id))
        )[0]?.taskId;
  if (!taskId) return null;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return task ? { projectId: task.projectId, task } : null;
}
