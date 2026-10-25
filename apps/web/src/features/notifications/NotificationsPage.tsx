import type { Notification } from "@orbis/api-contract";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { CheckCheck, Settings } from "lucide-react";
import { useState } from "react";
import { fetchNotifications, markNotificationsRead, queryKeys } from "../../api/resources";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/ErrorText";
import { Segmented } from "../../components/Segmented";
import { StatusDot } from "../../components/StatusDot";
import { useT } from "../../i18n";
import { formatRelativeTime, formatTime } from "../../lib/format";
import { useShell } from "../shell/shell-context";
import { MainColumn } from "../shell/WorkspaceLayout";
import "./notifications.css";

/** 通知中心（ARCHITECTURE §12.3）：全部或只看未讀、逐筆或全部標為已讀、點擊前往相關頁面。 */
export function NotificationsPage() {
  const t = useT();
  const shell = useShell();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useInfiniteQuery({
    queryKey: [...queryKeys.notifications, { unreadOnly }],
    queryFn: ({ pageParam, signal }) => fetchNotifications(unreadOnly, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextBefore,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const markRead = useMutation({
    mutationFn: (ids: string[] | "all") =>
      markNotificationsRead(ids === "all" ? { all: true } : { ids }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notificationsUnreadCount }),
      ]),
  });

  async function open(notification: Notification) {
    if (notification.readAt === null) await markRead.mutateAsync([notification.id]);
    if (notification.url) router.history.push(notification.url);
  }

  return (
    <MainColumn className="notifications-page">
      <header className="page-bar">
        <h1 className="page-title">{t.notifications.title}</h1>
        <span className="spacer" />
        <Segmented
          label={t.notifications.filter}
          value={unreadOnly ? "unread" : "all"}
          onChange={(value) => setUnreadOnly(value === "unread")}
          options={[
            { value: "all", label: t.notifications.all },
            { value: "unread", label: t.notifications.unread },
          ]}
        />
        <Button
          variant="ghost"
          icon={<CheckCheck size={14} />}
          disabled={markRead.isPending || items.every((n) => n.readAt !== null)}
          onClick={() => markRead.mutate("all")}
        >
          {t.notifications.markAllRead}
        </Button>
        <Button
          variant="ghost"
          icon={<Settings size={14} />}
          onClick={() => shell.openSettings("notifications")}
        >
          {t.notifications.settings}
        </Button>
      </header>
      <div className="page-scroll">
        <div className="notifications-body">
          <ErrorText error={list.error ?? markRead.error} />
          {list.isSuccess && items.length === 0 && (
            <p className="page-empty">
              {unreadOnly ? t.notifications.emptyUnread : t.notifications.empty}
            </p>
          )}
          <ul className="notification-list">
            {items.map((notification) => {
              const unread = notification.readAt === null;
              return (
                <li
                  key={notification.id}
                  className="notification"
                  data-kind={notification.kind}
                  data-read={String(!unread)}
                >
                  <button
                    type="button"
                    className="notification-open"
                    onClick={() => void open(notification)}
                  >
                    <span className="notification-dot">
                      {unread && <StatusDot color="var(--o7fb0fa)" />}
                    </span>
                    <span className="notification-main">
                      <span className="notification-line">
                        <span className="notification-kind">
                          {t.labels.notificationKind[notification.kind]}
                        </span>
                        {notification.taskKey && (
                          <span className="notification-key">{notification.taskKey}</span>
                        )}
                        <strong className="notification-title">{notification.title}</strong>
                      </span>
                      {notification.body && (
                        <span className="notification-body">{notification.body}</span>
                      )}
                    </span>
                    <span
                      className="notification-time"
                      data-tip={formatTime(notification.createdAt)}
                    >
                      {formatRelativeTime(notification.createdAt)}
                    </span>
                    {unread && (
                      <span className="visually-hidden">{t.notifications.unreadMarker}</span>
                    )}
                  </button>
                  {unread && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate([notification.id])}
                    >
                      {t.notifications.markRead}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {list.hasNextPage && (
            <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t.notifications.loadEarlier}
            </Button>
          )}
        </div>
      </div>
    </MainColumn>
  );
}
