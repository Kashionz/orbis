// 共同編輯文件中的 @mention（ARCHITECTURE §12.3）：TipTap 的 mention 節點，屬性 `id` 是
// `member:<id>`／`agent:<id>`（formatMentionTargetId），`nodeId` 在插入時產生，Server 以它去除重複、
// 只對新出現的 mention 發通知或建立 consult Run（契約 collab.ts 的 CollabMentionAttrs）。

import { formatMentionTargetId, type MentionCandidates } from "@orbis/api-contract";
import Mention from "@tiptap/extension-mention";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { getMessages } from "../../i18n";
import { type MentionOption, mentionOptions } from "../../lib/mention-input";

const MAX_OPTIONS = 8;

/** 帶 `nodeId` 屬性的 mention 節點。 */
export const CollabMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      nodeId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-node-id"),
        renderHTML: (attributes: { nodeId?: string | null }) =>
          attributes.nodeId ? { "data-node-id": attributes.nodeId } : {},
      },
    };
  },
});

/** 自動完成的設定；`candidates()` 回傳目前的候選對象（查詢完成前是 null）。 */
export function collabMentionExtension(candidates: () => MentionCandidates | null) {
  return CollabMention.configure({
    HTMLAttributes: { class: "mention" },
    suggestion: {
      char: "@",
      items: ({ query }) => {
        const list = candidates();
        return list ? mentionOptions(list, query).slice(0, MAX_OPTIONS) : [];
      },
      command: ({ editor, range, props }) => {
        const option = props as unknown as MentionOption;
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: "mention",
              attrs: {
                id: formatMentionTargetId(option.target),
                label: option.label,
                nodeId: crypto.randomUUID(),
              },
            },
            { type: "text", text: " " },
          ])
          .run();
      },
      render: () => {
        let popup: SuggestionPopup | null = null;
        return {
          onStart: (props) => {
            popup = new SuggestionPopup();
            popup.update(props);
          },
          onUpdate: (props) => popup?.update(props),
          onKeyDown: (props) => popup?.keyDown(props) ?? false,
          onExit: () => {
            popup?.destroy();
            popup = null;
          },
        };
      },
    },
  });
}

/** 候選清單（listbox），放在游標下方。 */
class SuggestionPopup {
  private readonly element = document.createElement("div");
  private props: SuggestionProps<MentionOption> | null = null;
  private active = 0;

  constructor() {
    this.element.className = "mention-options collab-mention-options";
    this.element.setAttribute("role", "listbox");
    this.element.setAttribute("aria-label", getMessages().workspace.collab.mentionOptions);
    document.body.append(this.element);
  }

  update(props: SuggestionProps<MentionOption>): void {
    this.props = props;
    this.active = Math.min(this.active, Math.max(props.items.length - 1, 0));
    this.render();
  }

  keyDown({ event }: SuggestionKeyDownProps): boolean {
    const items = this.props?.items ?? [];
    if (items.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.active = (this.active + step + items.length) % items.length;
      this.render();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      this.select(this.active);
      return true;
    }
    if (event.key === "Escape") {
      this.destroy();
      return true;
    }
    return false;
  }

  destroy(): void {
    this.element.remove();
  }

  private select(index: number): void {
    const item = this.props?.items[index];
    if (item) this.props?.command(item);
  }

  private render(): void {
    const props = this.props;
    if (!props) return;
    this.element.replaceChildren(
      ...props.items.map((item, index) => {
        const option = document.createElement("div");
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === this.active));
        const label = document.createElement("strong");
        label.textContent = `@${item.label}`;
        option.append(label);
        if (item.detail) {
          const detail = document.createElement("span");
          detail.className = "hint";
          detail.textContent = ` ${item.detail}`;
          option.append(detail);
        }
        option.addEventListener("mousedown", (event) => {
          event.preventDefault();
          this.select(index);
        });
        return option;
      }),
    );
    this.element.hidden = props.items.length === 0;
    const rect = props.clientRect?.();
    if (rect) {
      this.element.style.position = "fixed";
      this.element.style.left = `${rect.left}px`;
      this.element.style.top = `${rect.bottom + 4}px`;
    }
  }
}
