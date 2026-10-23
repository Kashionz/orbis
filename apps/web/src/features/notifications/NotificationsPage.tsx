import type { Notification } from "@orbis/api-contract";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { fetchNotifications, markNotificationsRead, queryKeys } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { formatTime } from "../../lib/format";
import { NOTIFICATION_KIND_LABELS } from "../../lib/labels";

/** 通知中心（ARCHITECTURE §12.3）：全部或只看未讀、逐筆或全部標為已讀、點擊前往相關頁面。 */
export function NotificationsPage() {
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
    <main className="notifications-page">
      <header className="page-header">
        <h1>通知</h1>
        <span className="spacer" />
        <Link to="/settings/notifications">通知設定</Link>
        <button
          type="button"
          disabled={markRead.isPending || items.every((n) => n.readAt !== null)}
          onClick={() => markRead.mutate("all")}
        >
          全部標為已讀
        </button>
      </header>
      <div className="tabs" role="tablist" aria-label="篩選通知">
        <button
          type="button"
          role="tab"
          aria-selected={!unreadOnly}
          onClick={() => setUnreadOnly(false)}
        >
          全部
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={unreadOnly}
          onClick={() => setUnreadOnly(true)}
        >
          未讀
        </button>
      </div>
      <ErrorText error={list.error ?? markRead.error} />
      {list.isSuccess && items.length === 0 && (
        <p className="empty">{unreadOnly ? "沒有未讀的通知。" : "還沒有通知。"}</p>
      )}
      <ul className="notification-list">
        {items.map((notification) => (
          <li
            key={notification.id}
            className="notification"
            data-kind={notification.kind}
            data-read={String(notification.readAt !== null)}
          >
            <button
              type="button"
              className="notification-open"
              onClick={() => void open(notification)}
            >
              <span className="tag">{NOTIFICATION_KIND_LABELS[notification.kind]}</span>
              {notification.taskKey && <span className="task-key">{notification.taskKey}</span>}
              <strong>{notification.title}</strong>
              {notification.body && <span className="hint">{notification.body}</span>}
              <span className="hint">{formatTime(notification.createdAt)}</span>
              {notification.readAt === null && <span className="visually-hidden">（未讀）</span>}
            </button>
            {notification.readAt === null && (
              <button
                type="button"
                className="link-button"
                disabled={markRead.isPending}
                onClick={() => markRead.mutate([notification.id])}
              >
                標為已讀
              </button>
            )}
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <button
          type="button"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          載入更早的通知
        </button>
      )}
    </main>
  );
}
