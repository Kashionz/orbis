// 設定對話框中經由 Desktop bridge 的設定：代理的重新登入、桌面通知總開關。兩者都只在 Desktop 中有
// （在一般瀏覽器中不顯示或改顯示指令）。

import { getDesktopBridge } from "@orbis/desktop/bridge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentCatalogQuery } from "../agents/catalog";

/** Desktop 在這台電腦上執行 Runner 的登入子指令（`loginHint.kind` 是 `runner` 的代理）。 */
export function useAgentLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      const bridge = getDesktopBridge();
      if (!bridge?.loginAgent) throw new Error("這個版本的 Desktop 不支援重新登入");
      const result = await bridge.loginAgent(agentId);
      if (!result.ok) throw new Error(result.message);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentCatalogQuery.queryKey }),
  });
}

/** 這台電腦的 Desktop 能不能在這裡重新登入代理。 */
export function canLoginInDesktop(): boolean {
  return getDesktopBridge()?.loginAgent !== undefined;
}

/** 桌面通知總開關（存在這台電腦的 Desktop 設定檔）；不在 Desktop 中時 `available` 為 false。 */
export function useDesktopNotificationSetting() {
  const queryClient = useQueryClient();
  const bridge = getDesktopBridge();
  const available =
    bridge?.getNotificationsEnabled !== undefined && bridge.setNotificationsEnabled !== undefined;
  const key = ["desktop-notifications"] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => (await bridge?.getNotificationsEnabled?.()) ?? true,
    enabled: available,
  });
  const update = useMutation({
    mutationFn: async (enabled: boolean) => {
      await bridge?.setNotificationsEnabled?.(enabled);
      return enabled;
    },
    onSuccess: (enabled) => queryClient.setQueryData(key, enabled),
  });
  return { available, query, update };
}
