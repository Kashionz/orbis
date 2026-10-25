// Task 分享的資料 hook。TODO(backend, task-sharing)：只有 mock 提供，真實模式由 lib/features.ts 關閉。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, apiSend } from "../../api/client";
import { isFeatureEnabled } from "../../lib/features";
import {
  type AddTaskShareInput,
  type GeneralAccess,
  type InviteRole,
  SHARE_ROUTES,
  sharePath,
  TaskShare,
} from "./types";

export const shareQueryKey = (taskId: string) => ["task-share", taskId] as const;

export function useTaskShare(taskId: string) {
  return useQuery({
    queryKey: shareQueryKey(taskId),
    queryFn: ({ signal }) =>
      apiRequest(sharePath(SHARE_ROUTES.share, { taskId }), TaskShare, { signal }),
    enabled: isFeatureEnabled("taskSharing"),
  });
}

/** 分享的各種修改；成功後以回傳的狀態更新快取。 */
export function useShareMutations(taskId: string) {
  const queryClient = useQueryClient();
  const onSuccess = (share: TaskShare) => queryClient.setQueryData(shareQueryKey(taskId), share);
  const refresh = () => queryClient.invalidateQueries({ queryKey: shareQueryKey(taskId) });

  const add = useMutation({
    mutationFn: (input: AddTaskShareInput) =>
      apiRequest(sharePath(SHARE_ROUTES.shareMembers, { taskId }), TaskShare, {
        method: "POST",
        body: input,
      }),
    onSuccess,
  });
  const setRole = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: InviteRole }) =>
      apiRequest(sharePath(SHARE_ROUTES.shareMember, { taskId, memberId }), TaskShare, {
        method: "PATCH",
        body: { role },
      }),
    onSuccess,
  });
  const remove = useMutation({
    mutationFn: (memberId: string) =>
      apiSend(sharePath(SHARE_ROUTES.shareMember, { taskId, memberId }), { method: "DELETE" }),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (email: string) =>
      apiSend(sharePath(SHARE_ROUTES.shareInvite, { taskId, email }), { method: "DELETE" }),
    onSuccess: refresh,
  });
  const setGeneral = useMutation({
    mutationFn: (general: GeneralAccess) =>
      apiRequest(sharePath(SHARE_ROUTES.shareGeneral, { taskId }), TaskShare, {
        method: "PUT",
        body: { general },
      }),
    onSuccess,
  });
  return { add, setRole, remove, revoke, setGeneral };
}
