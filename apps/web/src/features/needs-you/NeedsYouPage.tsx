// 待我處理（README「Needs You」）：依類型分組（權限請求、計畫關卡、審查關卡，以及停下來的執行、
// 子執行的問題），每一列可以直接處理或前往工作區中的位置。Server 只列出本人有權處理的項目。

import type { NeedsYouItem } from "@orbis/api-contract";
import type { PermissionOptionKind } from "@orbis/protocol";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronRight,
  FileDiff,
  ListChecks,
  MessageCircleQuestion,
  OctagonAlert,
  ShieldAlert,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  answerChildQuestion,
  needsYouQuery,
  queryKeys,
  respondToPermission,
  runQuery,
  taskQuery,
} from "../../api/resources";
import { AgentLogo } from "../../components/AgentLogo";
import { ErrorText } from "../../components/ErrorText";
import { useT } from "../../i18n";
import { relativeTime } from "../run/stream/time-format";
import { useNow } from "../run/workspace/use-now";
import { retryLocalMerge } from "../run/workspace-api";
import { MainColumn } from "../shell/WorkspaceLayout";
import {
  groupNeedsYou,
  groupOf,
  type NeedsYouGroupKind,
  stoppedRunSummary,
  targetOf,
} from "./needs-you-model";
import "../run/scope.css";
import "../run/stream/stream.css";
import "./needs-you.css";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

const GROUP_ICONS: Record<NeedsYouGroupKind, ReactNode> = {
  permission: <ShieldAlert {...ICON} />,
  plan_gate: <ListChecks {...ICON} />,
  review_gate: <FileDiff {...ICON} />,
  stopped_run: <OctagonAlert {...ICON} />,
  child_question: <MessageCircleQuestion {...ICON} />,
};

function optionVariant(kind: PermissionOptionKind): "primary" | "secondary" | "danger" {
  if (kind === "allow_once") return "primary";
  if (kind === "allow_always") return "secondary";
  return "danger";
}

export function NeedsYouPage() {
  const t = useT();
  const n = t.needsYou;
  const queryClient = useQueryClient();
  const { data: items = [], error, isPending } = useQuery(needsYouQuery);
  const groups = groupNeedsYou(items);
  const now = useNow(30_000);

  // 每一列的 Task 標題與 Run 的代理（同一個 Task、Run 只取一次）
  const taskIds = useMemo(() => [...new Set(items.map((i) => i.taskId))], [items]);
  const runIds = useMemo(() => [...new Set(items.map((i) => i.runId))], [items]);
  const tasks = useQueries({ queries: taskIds.map((id) => taskQuery(id)) });
  const runs = useQueries({ queries: runIds.map((id) => runQuery(id)) });
  const titleOf = (taskId: string) => tasks[taskIds.indexOf(taskId)]?.data?.title ?? "";
  const agentOf = (runId: string) => runs[runIds.indexOf(runId)]?.data?.agent ?? null;

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
    <MainColumn className="ny">
      <div className="ny-column">
        <div className="ny-head">
          <h1 className="ny-title">{n.title}</h1>
          <span className="ny-count">{items.length}</span>
        </div>
        <ErrorText error={error ?? respond.error} />
        {!isPending && items.length === 0 && (
          <div className="ny-empty">
            <span className="ny-empty-icon">
              <Check {...ICON} />
            </span>
            <span>{n.empty}</span>
          </div>
        )}
        {groups.map((group) => (
          <section key={group.kind} className="ny-group" aria-labelledby={`ny-${group.kind}`}>
            <div className="ny-group-head">
              <span className="ny-group-icon">{GROUP_ICONS[group.kind]}</span>
              <h2 id={`ny-${group.kind}`} className="ny-group-title">
                {n.group[group.kind]}
              </h2>
              <span className="ny-count">{group.items.length}</span>
            </div>
            <ul className="ny-list">
              {group.items.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  title={titleOf(item.taskId)}
                  agent={agentOf(item.runId)}
                  now={now}
                  responding={respond.isPending && respond.variables?.item.id === item.id}
                  onRespond={(optionId) => {
                    if (item.kind === "permission_request") respond.mutate({ item, optionId });
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </MainColumn>
  );
}

function Row({
  item,
  title,
  agent,
  now,
  responding,
  onRespond,
}: {
  item: NeedsYouItem;
  title: string;
  agent: string | null;
  now: number;
  responding: boolean;
  onRespond: (optionId: string) => void;
}) {
  const t = useT();
  const n = t.needsYou;
  const navigate = useNavigate();
  const kind = groupOf(item);
  const target = targetOf(item);
  const go = () =>
    void navigate({
      to: "/tasks/$taskKey",
      params: { taskKey: target.taskKey },
      search: {
        run: target.run,
        ...(target.tab && { tab: target.tab }),
        ...(target.focus && { focus: target.focus }),
      },
    });
  const summary =
    item.kind === "permission_request"
      ? item.title
      : item.kind === "gate"
        ? n.summary[item.gateKind === "plan" ? "plan_gate" : "review_gate"]
        : item.kind === "stopped_run"
          ? stoppedRunSummary(item, n)
          : item.question;

  return (
    <li
      className="ny-row"
      data-kind={item.kind}
      data-purpose={item.kind === "permission_request" ? item.purpose : undefined}
    >
      <div className="ny-main">
        <button type="button" className="ny-line" onClick={go}>
          <span className="ny-key">{item.taskKey}</span>
          <span className="ny-task-title">{title}</span>
        </button>
        <div className="ny-detail">
          {agent && <AgentLogo agent={agent} size={14} />}
          {item.kind === "permission_request" && (
            <span className="ny-purpose">{t.labels.permissionPurpose[item.purpose]}</span>
          )}
          <span className="ny-summary">{summary}</span>
        </div>
        {item.kind === "permission_request" && (
          <div className="ny-options">
            {item.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                className="st-option"
                data-variant={optionVariant(option.kind)}
                disabled={responding}
                onClick={() => onRespond(option.optionId)}
              >
                {t.workspace.permissionOption[option.kind] ?? option.name}
              </button>
            ))}
          </div>
        )}
        {item.kind === "child_question" && <ChildQuestionForm item={item} />}
        {item.kind === "stopped_run" && item.reasonCode === "local_merge_blocked" && (
          <LocalMergeRetry runId={item.runId} />
        )}
      </div>
      <div className="ny-side">
        <span className="ny-ago">{relativeTime(item.createdAt, now, t.common)}</span>
        <button type="button" className="ny-go" onClick={go}>
          {n.go[kind]}
          <ChevronRight {...ICON} />
        </button>
      </div>
    </li>
  );
}

/** 本機合併被擋下（ADR-0013）：處理好本機 checkout 後重試合併。 */
function LocalMergeRetry({ runId }: { runId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryLocalMerge(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
  });
  return (
    <div className="ny-options">
      <button
        type="button"
        className="o-btn"
        data-variant="primary"
        disabled={retry.isPending}
        onClick={() => retry.mutate()}
      >
        {t.needsYou.retryLocalMerge}
      </button>
      <ErrorText error={retry.error} />
    </div>
  );
}

/** 子執行以 `ask_parent` 提出、父執行的回合已經結束而改由人回答的問題（§9）。 */
function ChildQuestionForm({ item }: { item: NeedsYouItem & { kind: "child_question" } }) {
  const t = useT();
  const n = t.needsYou;
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const send = useMutation({
    mutationFn: () => answerChildQuestion(item.questionId, { answer: answer.trim() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
  });
  return (
    <form
      className="ny-answer"
      aria-label={n.answerLabel(item.taskKey)}
      onSubmit={(event) => {
        event.preventDefault();
        if (answer.trim() !== "") send.mutate();
      }}
    >
      <textarea
        className="ny-textarea"
        aria-label={n.answer}
        placeholder={n.answerPlaceholder}
        rows={2}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
      />
      <ErrorText error={send.error} />
      <div>
        <button
          type="submit"
          className="o-btn"
          data-variant="primary"
          disabled={send.isPending || answer.trim() === ""}
        >
          {n.answer}
        </button>
      </div>
    </form>
  );
}
