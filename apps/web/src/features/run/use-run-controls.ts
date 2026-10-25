// 回覆權限請求（事件串流與待我處理共用的權限判斷）。

import type { Run } from "@orbis/api-contract";
import type { PermissionPurpose } from "@orbis/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, respondToPermission } from "../../api/resources";
import { canRespondToPermission } from "../../lib/permissions";
import type { Permissions } from "../auth/use-permissions";
import { workspaceKeys } from "./workspace-api";

export interface RunControls {
  /** 可以回覆這種用途的權限請求嗎（依 Role 與 Runner 擁有者）。 */
  canRespond: (purpose: PermissionPurpose) => boolean;
  /** 正在送出回覆的權限請求。 */
  respondingRequestId: string | null;
  respond: (requestId: string, optionId: string) => void;
}

export function useRunControls(
  run: Pick<Run, "id" | "runnerKind" | "startedByMemberId">,
  permissions: Permissions,
): { controls: RunControls; error: unknown } {
  const queryClient = useQueryClient();
  const respond = useMutation({
    mutationFn: ({ requestId, optionId }: { requestId: string; optionId: string }) =>
      respondToPermission(run.id, requestId, { optionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.needsYou });
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.eventActors(run.id) });
    },
  });
  const controls: RunControls = {
    canRespond: (purpose) => canRespondToPermission(run, purpose, permissions.ctx),
    respondingRequestId: respond.isPending ? (respond.variables?.requestId ?? null) : null,
    respond: (requestId, optionId) => respond.mutate({ requestId, optionId }),
  };
  return { controls, error: respond.error };
}
