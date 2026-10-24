// 側欄（README §1）：產品與團隊名稱、搜尋（Ctrl+K）、看板／待我處理／通知、依狀態分區的 Task、
// 底部的個人按鈕與選單。寬度 200–360px，可拖曳、雙擊重設、←→ 每次 16px，存 localStorage。

import { NAMES } from "@orbis/api-contract/names";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Bell, ChevronRight, Inbox, KanbanSquare, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  needsYouQuery,
  notificationsUnreadCountQuery,
  runQuery,
  tasksQuery,
} from "../../api/resources";
import { FluidList, fluidItem } from "../../components/FluidList";
import { useModifierShortcut } from "../../components/hooks";
import { Kbd, shortcutLabel } from "../../components/Kbd";
import { Splitter } from "../../components/Splitter";
import { StatusDot } from "../../components/StatusDot";
import { useT } from "../../i18n";
import { parseNumberIn, persistentState, usePersistentState } from "../../lib/storage";
import { meQueryOptions } from "../auth/api";
import { useNotificationStream } from "../notifications/use-notification-stream";
import { ProfileButton } from "./ProfileMenu";
import { useShell } from "./shell-context";
import { DEFAULT_COLLAPSED, type SidebarSection, sidebarGroups } from "./sidebar-sections";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 360;
export const SIDEBAR_DEFAULT = 252;

export const sidebarWidthState = persistentState<number>(
  "side-w",
  SIDEBAR_DEFAULT,
  parseNumberIn(SIDEBAR_MIN, SIDEBAR_MAX),
);

export function Sidebar() {
  const t = useT();
  const [width, setWidth] = usePersistentState(sidebarWidthState);
  const { data: me } = useSuspenseQuery(meQueryOptions);

  return (
    <aside className="sidebar" style={{ width }}>
      <Splitter
        edge="right"
        label={t.shell.resizeSidebar}
        value={width}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        defaultValue={SIDEBAR_DEFAULT}
        step={16}
        rightIncreases
        onChange={(value) => setWidth(Math.round(value))}
        valueFromPointer={(clientX, startValue, startX) => startValue + clientX - startX}
      />
      <div className="sidebar-brand">
        <span className="sidebar-product">{NAMES.productName}</span>
        {me.member && <span className="sidebar-team">{me.member.teamName}</span>}
      </div>
      <SidebarBody />
      <div className="sidebar-footer">
        <ProfileButton />
      </div>
    </aside>
  );
}

function SidebarBody() {
  const t = useT();
  const navigate = useNavigate();
  const { project } = useShell();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<SidebarSection>>(
    () => new Set(DEFAULT_COLLAPSED),
  );
  const { data: tasks = [] } = useQuery({
    ...tasksQuery(project?.id ?? ""),
    enabled: project !== undefined,
  });
  const { data: needsYou = [] } = useQuery(needsYouQuery);
  const activeKey = useActiveTaskKey(tasks);
  const groups = useMemo(() => sidebarGroups(tasks, needsYou, query), [tasks, needsYou, query]);

  useModifierShortcut("k", () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  });

  function openOnlyMatch() {
    const matches = groups.flatMap((group) => group.rows);
    const [only] = matches;
    if (matches.length === 1 && only) {
      void navigate({ to: "/tasks/$taskKey", params: { taskKey: only.task.key } });
    }
  }

  return (
    <>
      <div className="sidebar-search">
        <Search size={14} className="sidebar-search-icon" aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder={t.shell.searchPlaceholder}
          aria-label={t.shell.searchLabel}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") openOnlyMatch();
            if (event.key === "Escape") {
              event.preventDefault();
              setQuery("");
              event.currentTarget.blur();
            }
          }}
        />
        <span className="sidebar-search-kbd">
          <Kbd>{shortcutLabel("K")}</Kbd>
        </span>
      </div>

      <FluidList as="nav" className="sidebar-nav" aria-label={t.shell.mainNav}>
        <Link
          to="/board"
          search={{}}
          className="sidebar-nav-item"
          activeProps={{ "aria-current": "page" }}
          {...fluidItem}
        >
          <KanbanSquare size={14} className="sidebar-nav-icon" aria-hidden="true" />
          <span className="sidebar-nav-label">{t.shell.board}</span>
          <span className="sidebar-count">{tasks.length}</span>
        </Link>
        <Link
          to="/needs-you"
          className="sidebar-nav-item"
          activeProps={{ "aria-current": "page" }}
          {...fluidItem}
        >
          <Bell size={14} className="sidebar-nav-icon" aria-hidden="true" />
          <span className="sidebar-nav-label">{t.shell.needsYou}</span>
          <span
            className="sidebar-count"
            data-tone={needsYou.length > 0 ? "warn" : undefined}
            data-testid="needs-you-count"
          >
            {needsYou.length}
            <span className="visually-hidden">{t.shell.needsYouCount(needsYou.length)}</span>
          </span>
        </Link>
        <NotificationsLink />
      </FluidList>

      <div className="sidebar-sections">
        {groups.length === 0 && query && <p className="sidebar-empty">{t.shell.noMatchingTasks}</p>}
        {groups.map((group) => {
          const open = query.trim() !== "" || !collapsed.has(group.section);
          const headingId = `sidebar-section-${group.section}`;
          return (
            <section key={group.section} className="sidebar-section" aria-labelledby={headingId}>
              <button
                type="button"
                id={headingId}
                className="sidebar-section-toggle"
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.section)) next.delete(group.section);
                    else next.add(group.section);
                    return next;
                  })
                }
              >
                <span>{t.shell.sections[group.section]}</span>
                <span className="sidebar-count">{group.rows.length}</span>
                <ChevronRight
                  size={14}
                  className="sidebar-chevron"
                  data-open={open}
                  aria-hidden="true"
                />
              </button>
              {open && (
                <FluidList className="sidebar-rows">
                  {group.rows.map((row) => {
                    const active = row.task.key === activeKey;
                    return (
                      <Link
                        key={row.task.id}
                        to="/tasks/$taskKey"
                        params={{ taskKey: row.task.key }}
                        className="sidebar-row"
                        data-active={active}
                        data-done={row.task.status === "done"}
                        aria-current={active ? "page" : undefined}
                        {...fluidItem}
                      >
                        <span className="sidebar-row-dot">
                          <StatusDot color={row.dotColor} live={row.live} />
                        </span>
                        <span className="o-wstable sidebar-row-title">
                          <span className="o-wstable-text" data-active={active}>
                            {row.task.title}
                          </span>
                          <span className="o-wstable-ghost" aria-hidden="true">
                            {row.task.title}
                          </span>
                        </span>
                        <span className="sidebar-row-key">{row.task.key}</span>
                      </Link>
                    );
                  })}
                </FluidList>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

/** 通知中心的入口與未讀數；`notification` 推送常駐監聽，收到時即時更新。 */
function NotificationsLink() {
  const t = useT();
  useNotificationStream();
  const { data } = useQuery(notificationsUnreadCountQuery);
  const count = data?.count ?? 0;
  return (
    <Link
      to="/notifications"
      className="sidebar-nav-item"
      activeProps={{ "aria-current": "page" }}
      {...fluidItem}
    >
      <Inbox size={14} className="sidebar-nav-icon" aria-hidden="true" />
      <span className="sidebar-nav-label">{t.shell.notifications}</span>
      {count > 0 && (
        <span className="sidebar-count" data-tone="accent" data-testid="notification-count">
          {count}
          <span className="visually-hidden">{t.shell.unreadCount(count)}</span>
        </span>
      )}
    </Link>
  );
}

/** 目前開啟的 Task（工作區 `/tasks/$taskKey`，或 `/runs/$runId` 所屬的 Task）。 */
function useActiveTaskKey(tasks: readonly { id: string; key: string }[]): string | undefined {
  const params = useParams({ strict: false }) as { taskKey?: string; runId?: string };
  const { data: run } = useQuery({
    ...runQuery(params.runId ?? ""),
    enabled: params.runId !== undefined && params.taskKey === undefined,
  });
  if (params.taskKey) return params.taskKey;
  if (run) return tasks.find((task) => task.id === run.taskId)?.key;
  return undefined;
}
