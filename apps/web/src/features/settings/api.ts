// 設定對話框中後端還沒有的設定（暫定型別與路徑，不在 @orbis/api-contract 中，只有 mock 提供）。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, apiSend } from "../../api/client";
import { isFeatureEnabled } from "../../lib/features";

export const SETTINGS_ROUTES = {
  /** TODO(backend, runner-long-paths)：Runner 的遠端設定（目前只有 Windows 長路徑）。 */
  runnerSettings: "/api/runners/:runnerId/settings",
  /** TODO(backend, agent-relogin)：請 Runner 重新執行代理的登入流程。 */
  agentRelogin: "/api/agents/:agentId/relogin",
  /** TODO(backend, desktop-notify-toggle)：桌面通知總開關。 */
  desktopNotifications: "/api/notification-preferences/desktop",
} as const;

function path(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
}

export const RunnerSettings = z.object({ windowsLongPaths: z.boolean() });
export type RunnerSettings = z.infer<typeof RunnerSettings>;

export const DesktopNotificationSetting = z.object({ enabled: z.boolean() });
export type DesktopNotificationSetting = z.infer<typeof DesktopNotificationSetting>;

export function useRunnerSettings(runnerId: string | undefined) {
  const queryClient = useQueryClient();
  const key = ["runner-settings", runnerId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      apiRequest(
        path(SETTINGS_ROUTES.runnerSettings, { runnerId: runnerId ?? "" }),
        RunnerSettings,
        {
          signal,
        },
      ),
    enabled: isFeatureEnabled("runnerLongPaths") && runnerId !== undefined,
  });
  const update = useMutation({
    mutationFn: (settings: RunnerSettings) =>
      apiRequest(
        path(SETTINGS_ROUTES.runnerSettings, { runnerId: runnerId ?? "" }),
        RunnerSettings,
        {
          method: "PUT",
          body: settings,
        },
      ),
    onSuccess: (settings) => queryClient.setQueryData(key, settings),
  });
  return { query, update };
}

export function useAgentRelogin() {
  return useMutation({
    mutationFn: (agentId: string) =>
      apiSend(path(SETTINGS_ROUTES.agentRelogin, { agentId }), { method: "POST" }),
  });
}

export function useDesktopNotificationSetting() {
  const queryClient = useQueryClient();
  const key = ["desktop-notifications"] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      apiRequest(SETTINGS_ROUTES.desktopNotifications, DesktopNotificationSetting, { signal }),
    enabled: isFeatureEnabled("desktopNotifyToggle"),
  });
  const update = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest(SETTINGS_ROUTES.desktopNotifications, DesktopNotificationSetting, {
        method: "PUT",
        body: { enabled },
      }),
    onSuccess: (setting) => queryClient.setQueryData(key, setting),
  });
  return { query, update };
}
