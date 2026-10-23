import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, type Ref, useId, useRef, useState } from "react";
import { mentionCandidatesQuery } from "../../api/resources";
import {
  activeMentionQuery,
  insertMention,
  type MentionOption,
  type MentionQuery,
  mentionOptions,
} from "../../lib/mention-input";

interface MentionTextareaProps {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  /** 輸入框的名稱（aria-label）。 */
  label: string;
  rows?: number;
  placeholder?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

/** 最多列出幾個候選對象。 */
const MAX_OPTIONS = 8;

/**
 * 支援 @mention 的多行輸入框（ARCHITECTURE §12.3）：輸入 `@` 時自動完成成員與 Agent，
 * 以方向鍵選擇、Enter 或 Tab 插入、Esc 關閉。插入的是契約的 mention token。
 */
export function MentionTextarea({
  projectId,
  value,
  onChange,
  label,
  rows = 3,
  placeholder,
  textareaRef,
}: MentionTextareaProps) {
  const listId = useId();
  const local = useRef<HTMLTextAreaElement | null>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const { data: candidates } = useQuery(mentionCandidatesQuery(projectId));
  const options =
    query && candidates ? mentionOptions(candidates, query.query).slice(0, MAX_OPTIONS) : [];
  const open = options.length > 0;

  function updateQuery(text: string, caret: number) {
    setQuery(activeMentionQuery(text, caret));
    setActive(0);
  }

  function choose(option: MentionOption) {
    const element = local.current;
    if (!query || !element) return;
    const result = insertMention(value, query, element.selectionStart, option);
    onChange(result.text);
    setQuery(null);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(result.caret, result.caret);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      const option = options[active];
      if (!option) return;
      event.preventDefault();
      choose(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setQuery(null);
    }
  }

  return (
    <div className="mention-input">
      <textarea
        ref={(element) => {
          local.current = element;
          if (typeof textareaRef === "function") textareaRef(element);
          else if (textareaRef) textareaRef.current = element;
        }}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          updateQuery(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setQuery(null)}
      />
      {open && (
        <ul id={listId} role="listbox" className="mention-options" aria-label="提及的對象">
          {options.map((option, index) => (
            // 用 mousedown，在 textarea 失去焦點（關閉清單）之前插入
            // biome-ignore lint/a11y/useKeyWithClickEvents: 鍵盤操作由 textarea 的 onKeyDown 處理
            <li
              key={option.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
            >
              <strong>@{option.label}</strong>
              {option.detail && <span className="hint"> {option.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
