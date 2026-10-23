// 時間軸項目的操作：展開與收合、回覆權限請求（Run 頁與 Task 頁的 Run 樹共用）。

import type { Run } from "@orbis/api-contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { queryKeys, respondToPermission } from "../../api/resources";
import { canRespondToPermission } from "../../lib/permissions";
import type { Permissions } from "../auth/use-permissions";
import type { ItemControls } from "./TimelineItemView";

export function useRunControls(
  run: Pick<Run, "id" | "runnerKind" | "startedByMemberId">,
  permissions: Permissions,
): { controls: ItemControls; error: unknown } {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const respond = useMutation({
    mutationFn: ({ requestId, optionId }: { requestId: string; optionId: string }) =>
      respondToPermission(run.id, requestId, { optionId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
  });
  const toggle = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const controls: ItemControls = {
    isExpanded: (key) => expanded.has(key),
    toggle,
    canRespond: (purpose) => canRespondToPermission(run, purpose, permissions.ctx),
    respondingRequestId: respond.isPending ? (respond.variables?.requestId ?? null) : null,
    respond: (requestId, optionId) => respond.mutate({ requestId, optionId }),
  };
  return { controls, error: respond.error };
}
