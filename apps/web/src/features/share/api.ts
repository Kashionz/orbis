// Task 分享的資料 hook（ADR-0012）：成員、角色、轉移擁有者、一般存取、以 email 邀請。
// 修改分享的 API 都回傳更新後的 TaskShare，直接更新快取。

import {
  API_ROUTES,
  apiPath,
  type GeneralAccess,
  type TaskInviteCreated as InviteCreated,
  TaskInviteCreated,
  type TaskInviteRole,
  TaskShare,
  type TaskShareRole,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../api/client";
import { queryKeys } from "../../api/resources";

export const shareQueryKey = (taskId: string) => ["task-share", taskId] as const;

export function useTaskShare(taskId: string) {
  return useQuery({
    queryKey: shareQueryKey(taskId),
    queryFn: ({ signal }) =>
      apiRequest(apiPath(API_ROUTES.taskShare, { taskId }), TaskShare, { signal }),
  });
}

/** 一次加入的結果：加入的 Member，與以 email 邀請的結果（含只出現一次的邀請連結）。 */
export interface ShareAddResult {
  memberIds: string[];
  invites: InviteCreated[];
  role: TaskInviteRole;
}

/** 分享的各種修改；成功後以回傳的狀態更新快取。 */
export function useShareMutations(taskId: string) {
  const queryClient = useQueryClient();
  const onSuccess = (share: TaskShare) => {
    queryClient.setQueryData(shareQueryKey(taskId), share);
    // 一般存取、擁有者改變時 Task 的 viewerAccess 與 generalAccess 也跟著變
    void queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };

  const add = useMutation({
    mutationFn: async ({
      memberIds,
      emails,
      role,
    }: {
      memberIds: string[];
      emails: string[];
      role: TaskInviteRole;
    }): Promise<ShareAddResult> => {
      if (memberIds.length > 0) {
        await apiRequest(apiPath(API_ROUTES.taskShareMembers, { taskId }), TaskShare, {
          method: "POST",
          body: { memberIds, role },
        });
      }
      const invites: InviteCreated[] = [];
      for (const email of emails) {
        invites.push(
          await apiRequest(apiPath(API_ROUTES.taskShareInvites, { taskId }), TaskInviteCreated, {
            method: "POST",
            body: { email, role },
          }),
        );
      }
      return { memberIds, invites, role };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: shareQueryKey(taskId) }),
  });
  const setRole = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: TaskShareRole }) =>
      apiRequest(apiPath(API_ROUTES.taskShareMember, { taskId, memberId }), TaskShare, {
        method: "PATCH",
        body: { role },
      }),
    onSuccess,
  });
  const remove = useMutation({
    mutationFn: (memberId: string) =>
      apiRequest(apiPath(API_ROUTES.taskShareMember, { taskId, memberId }), TaskShare, {
        method: "DELETE",
      }),
    onSuccess,
  });
  const revoke = useMutation({
    mutationFn: (inviteId: string) =>
      apiRequest(apiPath(API_ROUTES.taskShareInvite, { taskId, inviteId }), TaskShare, {
        method: "DELETE",
      }),
    onSuccess,
  });
  const setGeneral = useMutation({
    mutationFn: (generalAccess: GeneralAccess) =>
      apiRequest(apiPath(API_ROUTES.taskShareGeneral, { taskId }), TaskShare, {
        method: "PUT",
        body: { generalAccess },
      }),
    onSuccess,
  });
  return { add, setRole, remove, revoke, setGeneral };
}
