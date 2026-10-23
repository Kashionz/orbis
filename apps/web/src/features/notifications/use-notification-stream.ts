// 常駐監聽 `/api/ws` 的 `notification` 推送（ARCHITECTURE §12.3）：收到時更新未讀數與通知列表。

import type { NotificationUnreadCount } from "@orbis/api-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryKeys } from "../../api/resources";
import { type EventSocket, sharedEventSocket } from "../run/event-socket";

export function useNotificationStream(socket: EventSocket = sharedEventSocket()): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      socket.listenNotifications((notification) => {
        if (notification.readAt === null) {
          queryClient.setQueryData<NotificationUnreadCount>(
            queryKeys.notificationsUnreadCount,
            (current) => (current ? { count: current.count + 1 } : current),
          );
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
        void queryClient.invalidateQueries({ queryKey: queryKeys.notificationsUnreadCount });
      }),
    [socket, queryClient],
  );
}
