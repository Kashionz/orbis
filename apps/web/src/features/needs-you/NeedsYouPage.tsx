import type { NeedsYouItem } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { needsYouQuery, queryKeys, respondToPermission } from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { formatTime } from "../../lib/format";
import { usePermissions } from "../auth/use-permissions";

/** Needs You 清單（交付 5）：等待自己處理的權限請求、Gate、停下來的 Run。 */
export function NeedsYouPage() {
  const queryClient = useQueryClient();
  const { data: items = [], error, isPending } = useQuery(needsYouQuery);
  const permissions = usePermissions();

  const respond = useMutation({
    mutationFn: ({
      item,
      optionId,
    }: {
      item: NeedsYouItem & { kind: "permission_request" };
      optionId: string;
    }) =>
      respondToPermission(item.runId, { permissionRequestId: item.permissionRequestId, optionId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
  });

  return (
    <main className="needs-you-page">
      <h1>Needs You</h1>
      <ErrorText error={error ?? respond.error} />
      {!isPending && items.length === 0 && <p className="empty">目前沒有等待你處理的項目。</p>}
      <ul className="needs-you-list">
        {items.map((item) => (
          <li key={item.id} className="needs-you-item" data-kind={item.kind}>
            <div className="needs-you-main">
              <span className="tag">{kindLabel(item)}</span>
              <Link to="/tasks/$taskKey" params={{ taskKey: item.taskKey }} className="task-key">
                {item.taskKey}
              </Link>
              <span>{summary(item)}</span>
              <span className="hint">{formatTime(item.createdAt)}</span>
            </div>
            <div className="needs-you-actions">
              {item.kind === "permission_request" &&
                permissions.can("run.control") &&
                item.options.map((option) => (
                  <button
                    key={option.optionId}
                    type="button"
                    className={option.kind.startsWith("allow") ? "primary" : "danger"}
                    disabled={respond.isPending}
                    onClick={() => respond.mutate({ item, optionId: option.optionId })}
                  >
                    {option.name}
                  </button>
                ))}
              <JumpLink item={item} />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

function kindLabel(item: NeedsYouItem): string {
  switch (item.kind) {
    case "permission_request":
      return "權限請求";
    case "gate":
      return item.gateKind === "plan" ? "Plan Gate" : "Review Gate";
    case "stopped_run":
      return "Run 已停下";
  }
}

function summary(item: NeedsYouItem): string {
  switch (item.kind) {
    case "permission_request":
      return item.title;
    case "gate":
      return item.gateKind === "plan" ? "等待核准 plan" : "等待 review diff";
    case "stopped_run":
      return item.reason;
  }
}

/** 一鍵跳到要處理的位置。 */
function JumpLink({ item }: { item: NeedsYouItem }) {
  if (item.kind === "gate" && item.gateKind === "review") {
    return (
      <Link to="/runs/$runId/review" params={{ runId: item.runId }} className="button">
        前往 diff review
      </Link>
    );
  }
  // Plan Gate 的 UI 在 C2；先跳到 Run 頁
  const focus =
    item.kind === "permission_request" ? `permission-${item.permissionRequestId}` : undefined;
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: item.runId }}
      search={focus ? { focus } : {}}
      className="button"
    >
      前往 Run
    </Link>
  );
}
