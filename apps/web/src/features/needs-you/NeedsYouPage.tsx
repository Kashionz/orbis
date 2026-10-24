import type { NeedsYouItem } from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  answerChildQuestion,
  needsYouQuery,
  queryKeys,
  respondToPermission,
} from "../../api/resources";
import { ErrorText } from "../../components/ErrorText";
import { getMessages } from "../../i18n";
import { formatTime } from "../../lib/format";

/**
 * Needs You 清單（交付 5）：等待自己處理的權限請求、Gate、停下來的 Run。
 * Server 只列出本人有權處理的項目，所以權限請求一律顯示回覆按鈕。
 */
export function NeedsYouPage() {
  const queryClient = useQueryClient();
  const { data: items = [], error, isPending } = useQuery(needsYouQuery);

  const respond = useMutation({
    mutationFn: ({
      item,
      optionId,
    }: {
      item: NeedsYouItem & { kind: "permission_request" };
      optionId: string;
    }) => respondToPermission(item.runId, item.permissionRequestId, { optionId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
  });

  return (
    <main className="needs-you-page">
      <h1>Needs You</h1>
      <ErrorText error={error ?? respond.error} />
      {!isPending && items.length === 0 && <p className="empty">目前沒有等待你處理的項目。</p>}
      <ul className="needs-you-list">
        {items.map((item) => (
          <li
            key={item.id}
            className="needs-you-item"
            data-kind={item.kind}
            data-purpose={item.kind === "permission_request" ? item.purpose : undefined}
          >
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
            {item.kind === "child_question" && <ChildQuestionForm item={item} />}
          </li>
        ))}
      </ul>
    </main>
  );
}

function kindLabel(item: NeedsYouItem): string {
  const t = getMessages();
  switch (item.kind) {
    case "permission_request":
      return t.labels.permissionPurpose[item.purpose];
    case "gate":
      return item.gateKind === "plan" ? "Plan Gate" : "Review Gate";
    case "stopped_run":
      return "Run 已停下";
    case "child_question":
      return "Child Run 的問題";
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
    case "child_question":
      return item.question;
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
  // Plan Gate 的面板、Verification 的決定都在 Run 頁；
  // 「Run 已停下」（Verification 超過重試上限）直接開 Verification 分頁，決定的按鈕就在那裡
  const focus =
    item.kind === "permission_request" ? `permission-${item.permissionRequestId}` : undefined;
  const tab = item.kind === "stopped_run" ? "verification" : undefined;
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: item.runId }}
      search={{ ...(focus && { focus }), ...(tab && { tab }) }}
      className="button"
    >
      前往 Run
    </Link>
  );
}

/** Child Run 以 `ask_parent` 提出、父 Run 的回合已經結束而改由人回答的問題（§9）。 */
function ChildQuestionForm({ item }: { item: NeedsYouItem & { kind: "child_question" } }) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const send = useMutation({
    mutationFn: () => answerChildQuestion(item.questionId, { answer: answer.trim() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
  });
  return (
    <form
      className="child-question-form"
      aria-label={`回答 ${item.taskKey} 的 Child Run`}
      onSubmit={(event) => {
        event.preventDefault();
        if (answer.trim() !== "") send.mutate();
      }}
    >
      <Link to="/runs/$runId" params={{ runId: item.childRunId }}>
        提問的 Child Run
      </Link>
      <textarea
        aria-label="回答"
        rows={2}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
      />
      <ErrorText error={send.error} />
      <button type="submit" className="primary" disabled={send.isPending || answer.trim() === ""}>
        回答
      </button>
    </form>
  );
}
