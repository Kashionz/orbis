import {
  COLLAB_FRAGMENT,
  type CollabDocumentRef,
  type Mention,
  type MentionCandidates,
} from "@orbis/api-contract";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef } from "react";
import { mentionCandidatesQuery } from "../../api/resources";
import { meQueryOptions } from "../auth/api";
import { collabMentionExtension } from "./collab-mention";
import {
  COLLAB_FAILURE_MESSAGES,
  type CollabDocument,
  useCollabDocument,
  useCollabPeers,
  userColor,
} from "./use-collab-document";

interface CollabEditorProps {
  docRef: CollabDocumentRef;
  /** 給輔助技術的名稱，例如「描述」。 */
  label: string;
  /** 能不能編輯；不能時唯讀（Server 也會丟棄唯讀連線的修改）。 */
  canEdit: boolean;
  /** @mention 的候選對象所在的 Project。 */
  projectId: string;
  /** 這份文件中 mention 的紀錄（taskMentions），用來顯示 @agent 建立的 consult Run。 */
  mentions?: readonly Mention[];
  placeholder?: string;
}

/**
 * 即時共同編輯（ARCHITECTURE §12.1）：TipTap 加 Yjs，顯示其他人的游標與在線名單。
 * 文件內容由 Server 保存並轉成 markdown 回寫。
 */
export function CollabEditor(props: CollabEditorProps) {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const user = useMemo(
    () => ({ name: me.githubLogin, color: userColor(me.githubLogin) }),
    [me.githubLogin],
  );
  const { document, status, synced, everSynced, failure } = useCollabDocument(props.docRef, user);
  const peers = useCollabPeers(document);

  return (
    <div className="collab" data-status={status} data-synced={String(synced)}>
      <div className="collab-bar">
        <span className="collab-status" data-testid="collab-status">
          {failure
            ? "已中斷"
            : status === "connected"
              ? synced
                ? "已同步"
                : "同步中…"
              : status === "connecting"
                ? "連線中…"
                : "連線中斷，重新連線中…"}
        </span>
        {!props.canEdit && <span className="tag">唯讀</span>}
        <span className="spacer" />
        {peers.length > 0 && (
          <ul className="collab-peers" aria-label="正在編輯的人">
            {peers.map((peer) => (
              <li key={peer.name} style={{ borderColor: peer.color }}>
                {peer.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {failure ? (
        <p className="error-text" role="alert">
          {COLLAB_FAILURE_MESSAGES[failure]}
        </p>
      ) : (
        // 第一次同步完成後才建立編輯器：之前綁定空文件時，ProseMirror 補上的空段落會寫進共同文件，
        // 和 Server 的內容合併後順序錯亂，也會重設其他人的游標
        document &&
        (everSynced ? (
          <BoundEditor key={document.docName} document={document} user={user} {...props} />
        ) : (
          <p className="hint collab-loading">正在載入文件…</p>
        ))
      )}
    </div>
  );
}

function BoundEditor({
  document,
  user,
  label,
  canEdit,
  projectId,
  mentions = [],
  placeholder,
}: CollabEditorProps & { document: CollabDocument; user: { name: string; color: string } }) {
  const { data: candidates } = useQuery(mentionCandidatesQuery(projectId));
  // 自動完成在 TipTap 的 extension 中讀取最新的候選對象
  const candidatesRef = useRef<MentionCandidates | null>(null);
  candidatesRef.current = candidates ?? null;

  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        // 共同編輯有自己的 undo（Collaboration），不用 StarterKit 的
        // trailingNode 會在文件結尾自動補段落：每個 client 各補一次會產生重複的空段落
        StarterKit.configure({ undoRedo: false, trailingNode: false }),
        Collaboration.configure({ document: document.doc, field: COLLAB_FRAGMENT }),
        CollaborationCaret.configure({ provider: document.provider, user }),
        collabMentionExtension(() => candidatesRef.current),
      ],
      editorProps: {
        attributes: {
          "aria-label": label,
          "aria-multiline": "true",
          role: "textbox",
          class: "collab-content markdown",
          ...(placeholder ? { "data-placeholder": placeholder } : {}),
        },
      },
    },
    [document, user],
  );

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  // 文件中的 mention 節點（nodeId → 顯示名稱），對到 taskMentions 的 consult Run
  const mentionNodes = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const nodes: { nodeId: string; label: string }[] = [];
      current?.state.doc.descendants((node) => {
        if (node.type.name === "mention" && node.attrs.nodeId) {
          nodes.push({ nodeId: String(node.attrs.nodeId), label: String(node.attrs.label ?? "") });
        }
      });
      return JSON.stringify(nodes);
    },
  });
  const consults = (JSON.parse(mentionNodes ?? "[]") as { nodeId: string; label: string }[])
    .map((node) => ({
      ...node,
      runId:
        mentions.find(
          (m) =>
            m.sourceKind === "collab_document" &&
            m.sourceId === document.docName &&
            m.nodeId === node.nodeId,
        )?.consultRunId ?? null,
    }))
    .filter((node) => node.runId !== null);

  return (
    <>
      <EditorContent editor={editor} />
      {consults.length > 0 && (
        <p className="consult-runs">
          {consults.map((node) => (
            <Link key={node.nodeId} to="/runs/$runId" params={{ runId: node.runId ?? "" }}>
              @{node.label} 的 consult Run
            </Link>
          ))}
        </p>
      )}
    </>
  );
}
