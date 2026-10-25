// 事件串流中除了工具群組以外的各種項目。

import type { GateKind, PermissionOption, RunStatus } from "@orbis/protocol";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Brain,
  Copy,
  FileDiff,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Globe,
  ListChecks,
  Pencil,
  Shield,
  ShieldAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import { blobTextQuery } from "../../../api/resources";
import { AgentLogo } from "../../../components/AgentLogo";
import { Avatar } from "../../../components/Avatar";
import { StatusDot } from "../../../components/StatusDot";
import { type Messages, useT } from "../../../i18n";
import { formatTime } from "../../../lib/format";
import { modelDisplayName } from "../../agents/catalog";
import { clockTime } from "../panel/terminal-blocks";
import { runTone, TONE_COLOR } from "../run-tone";
import { blocksText, MessageBody } from "./MessageBody";
import { useStreamEnv } from "./stream-context";
import { agentAt } from "./stream-env";
import type { StreamHead, StreamItem, StreamTail } from "./stream-model";
import { duration, relativeTime } from "./time-format";

type Of<K extends StreamItem["kind"]> = Extract<StreamItem, { kind: K }>;

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;

/** Run 狀態的文字；等待 Gate 時說明是哪一個。 */
export function runStatusLabel(t: Messages, status: RunStatus, gate: GateKind | null): string {
  if (status === "awaiting_gate" && gate) {
    return gate === "plan"
      ? t.workspace.header.awaitingPlanGate
      : t.workspace.header.awaitingReviewGate;
  }
  return t.labels.runStatus[status];
}

// ---------- 頭像列 ----------

export function HeadRow({
  head,
  ts,
  seq,
  first,
}: {
  head: StreamHead;
  ts: string;
  seq: number | null;
  first: boolean;
}) {
  const t = useT();
  const env = useStreamEnv();
  if (head.actor === "agent") {
    const { agent, model } = agentAt(ts, env.run, env.settings);
    return (
      <div className="st-head" data-first={first}>
        <span className="st-head-logo">
          <AgentLogo agent={agent} size={14} />
        </span>
        <span className="st-head-name">{agent}</span>
        {model && <span className="st-head-sub">{modelDisplayName(model)}</span>}
      </div>
    );
  }
  const memberId =
    (seq !== null ? env.actors?.prompts[String(seq)] : undefined) ??
    (head.source === "user" ? env.run.startedByMemberId : null);
  const member = memberId ? env.members.get(memberId) : undefined;
  return (
    <div className="st-head" data-user="true" data-first={first}>
      {member ? (
        <>
          <Avatar person={{ name: member.githubLogin, avatarUrl: member.avatarUrl }} size={24} />
          <span className="st-head-name">{member.githubLogin}</span>
        </>
      ) : (
        <>
          <span className="st-head-logo">
            <Bot {...ICON} />
          </span>
          <span className="st-head-name">{t.labels.promptSource[head.source]}</span>
        </>
      )}
    </div>
  );
}

// ---------- 人送出的 prompt ----------

export function PromptRow({ item }: { item: Of<"prompt"> }) {
  const t = useT();
  const env = useStreamEnv();
  const text = blocksText(item.item.blocks);
  return (
    <div className="st-prompt" data-source={item.item.source}>
      <div className="st-bubble">{text}</div>
      <div className="st-hover-row">
        <span className="st-hover-time">{relativeTime(item.item.ts, env.now, t.common)}</span>
        <button
          type="button"
          className="st-icon-btn"
          aria-label={t.workspace.stream.copy}
          data-tip={t.workspace.stream.copy}
          onClick={() => env.copy(text)}
        >
          <Copy {...ICON} />
        </button>
        <button
          type="button"
          className="st-icon-btn"
          aria-label={t.workspace.stream.edit}
          data-tip={t.workspace.stream.edit}
          onClick={() => env.editPrompt(text)}
        >
          <Pencil {...ICON} />
        </button>
      </div>
    </div>
  );
}

// ---------- Agent 的訊息 ----------

export function MessageRow({ item }: { item: Of<"message"> }) {
  return (
    <div className="st-message">
      <MessageBody blocks={item.item.blocks} />
    </div>
  );
}

// ---------- 思考 ----------

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="st-chevron" data-open={open} aria-hidden="true">
      ›
    </span>
  );
}

export function ThoughtRow({ item }: { item: Of<"thought"> }) {
  const t = useT();
  const w = t.workspace.stream;
  const env = useStreamEnv();
  const open = env.isOpen(item.key, false);
  return (
    <div className="st-thought">
      <button
        type="button"
        className="st-thought-toggle"
        aria-expanded={open}
        onClick={() => env.toggle(item.key, false)}
      >
        <span className="st-muted-icon">
          <Brain {...ICON} />
        </span>
        {item.live ? (
          <span className="st-shimmer">{w.thinking}</span>
        ) : (
          <span className="st-muted">
            {item.seconds === null ? w.thought : w.thoughtFor(item.seconds)}
          </span>
        )}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="st-thought-body">
          {item.item.text
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 段落沒有 id
              <p key={index}>{line}</p>
            ))}
        </div>
      )}
    </div>
  );
}

// ---------- 計畫 ----------

const PLAN_GLYPH = { completed: "✓", in_progress: "◐", pending: "○" } as const;

export function PlanRow({ item }: { item: Of<"plan"> }) {
  const t = useT();
  const env = useStreamEnv();
  const open = env.isOpen(item.key, false);
  return (
    <div className="st-plan">
      <button
        type="button"
        className="st-row-toggle"
        aria-expanded={open}
        onClick={() => env.toggle(item.key, false)}
      >
        <span className="st-row-title">{t.workspace.stream.plan}</span>
        <span className="st-mono-muted">
          {item.done}/{item.total}
        </span>
        <Chevron open={open} />
        {!open && item.current && <span className="st-row-current">{item.current}</span>}
      </button>
      {open && (
        <div className="st-plan-entries">
          {item.item.entries.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: plan 項目沒有 id
            <div key={index} className="st-plan-entry" data-status={entry.status}>
              <span className="st-plan-glyph">{PLAN_GLYPH[entry.status]}</span>
              <span>{entry.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Agent 提出、等待 Plan Gate 的計畫全文。等待核准時預設展開。 */
export function PlanProposedRow({ item }: { item: Of<"plan_proposed"> }) {
  const t = useT();
  const env = useStreamEnv();
  const pending = env.pendingPlanSeq === item.item.seq;
  const open = env.isOpen(item.key, pending);
  const body = item.item.body;
  const blob = useQuery({
    ...blobTextQuery(body.type === "blob" ? body.blob_id : ""),
    enabled: open && body.type === "blob",
  });
  const text = body.type === "inline" ? body.text : (blob.data ?? null);
  return (
    <div className="st-plan" data-pending={pending}>
      <button
        type="button"
        className="st-row-toggle"
        aria-expanded={open}
        onClick={() => env.toggle(item.key, pending)}
      >
        <span className="st-muted-icon" data-tone={pending ? "warn" : undefined}>
          <ListChecks {...ICON} />
        </span>
        <span className="st-row-title">{t.workspace.stream.planProposed}</span>
        <span className="st-mono-muted">{t.labels.planSource[item.item.source]}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="st-thought-body st-plan-body" data-testid="plan-body">
          {text === null ? (
            <p>{t.workspace.stream.planLoading}</p>
          ) : (
            <div className="st-markdown">
              <Markdown>{text}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 驗收群組 ----------

export function VerificationRow({ item }: { item: Of<"verification_group"> }) {
  const t = useT();
  const env = useStreamEnv();
  const open = env.isOpen(item.key, item.defaultOpen);
  const total = item.results.length;
  return (
    <div className="st-verify">
      <button
        type="button"
        className="st-row-toggle"
        aria-expanded={open}
        onClick={() => env.toggle(item.key, item.defaultOpen)}
      >
        <span className="st-glyph" data-tone={item.failed > 0 ? "danger" : "success"}>
          {item.failed > 0 ? "✕" : "✓"}
        </span>
        <span className="st-row-title">{t.workspace.stream.verification(item.passed, total)}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="st-verify-list">
          {item.results.map((result) => {
            const criterion = env.criteria.get(result.criterionId);
            const passed = result.outcome === "passed";
            return (
              <div key={result.key} className="st-verify-row" data-outcome={result.outcome}>
                <span className="st-glyph" data-tone={passed ? "success" : "danger"}>
                  {passed ? "✓" : "✕"}
                </span>
                <span className="st-verify-desc" data-tip={result.summary || undefined}>
                  {criterion?.description ?? t.workspace.stream.deletedCriterion}
                </span>
                {criterion && (
                  <span className="st-mono-muted">{t.labels.acKind[criterion.kind]}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- 權限請求 ----------

function optionVariant(option: PermissionOption): "primary" | "secondary" | "danger" {
  if (option.kind === "allow_once") return "primary";
  if (option.kind === "allow_always") return "secondary";
  return "danger";
}

export function PermissionRow({ item }: { item: Of<"permission"> }) {
  const t = useT();
  const w = t.workspace.stream;
  const env = useStreamEnv();
  const permission = item.item;
  const pending = permission.resolved === null;
  const detailKey = `${item.key}-detail`;
  const detailOpen = item.detail !== null && env.isOpen(detailKey, false);
  const responding = env.respondingRequestId === permission.requestId;
  const selected = permission.options.find(
    (o) => o.option_id === permission.resolved?.selectedOptionId,
  );
  const responderId = env.actors?.permissions[permission.requestId];
  const responder = responderId ? env.members.get(responderId) : undefined;
  const optionLabel = (option: PermissionOption) =>
    t.workspace.permissionOption[option.kind] ?? option.name;

  return (
    <div
      className="st-perm"
      id={item.key}
      data-resolved={pending ? "false" : "true"}
      data-purpose={permission.purpose}
    >
      <div className="st-perm-head">
        <span className="st-perm-icon" data-tone={pending ? "warn" : "muted"}>
          <ShieldAlert {...ICON} />
        </span>
        <span className="st-perm-purpose" data-tone={pending ? "warn" : "muted"}>
          {t.labels.permissionPurpose[permission.purpose]}
        </span>
        <button
          type="button"
          className="st-perm-title"
          aria-label={w.showDetails}
          aria-expanded={item.detail === null ? undefined : detailOpen}
          disabled={item.detail === null}
          onClick={() => env.toggle(detailKey, false)}
        >
          <span className="st-perm-title-text">{permission.title}</span>
          {item.detail !== null && <Chevron open={detailOpen} />}
        </button>
      </div>
      {detailOpen && <code className="st-perm-detail">{item.detail}</code>}
      {pending ? (
        env.canRespond(permission.purpose) ? (
          <div className="st-perm-options">
            {permission.options.map((option) => (
              <button
                key={option.option_id}
                type="button"
                className="st-option"
                data-variant={optionVariant(option)}
                disabled={responding}
                onClick={() => env.respond(permission.requestId, option.option_id)}
              >
                {optionLabel(option)}
              </button>
            ))}
            <span className="st-mono-muted st-perm-policy">
              {t.labels.permissionPolicy[env.policy]}
            </span>
          </div>
        ) : (
          <div className="st-perm-resolved">
            {permission.purpose === "config_trust" ? w.waitingForAdmin : w.waitingForMember}
          </div>
        )
      ) : (
        <div className="st-perm-resolved">
          <span>
            {permission.resolved?.selectedOptionId === null
              ? w.requestCanceled
              : w.resolved(
                  selected ? optionLabel(selected) : (permission.resolved?.selectedOptionId ?? ""),
                )}
          </span>
          {responder && (
            <span className="st-perm-by">
              <Avatar
                person={{ name: responder.githubLogin, avatarUrl: responder.avatarUrl }}
                size={18}
              />
              <span>{responder.githubLogin}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 狀態列 ----------

export function StatusRow({ item }: { item: Of<"status"> }) {
  const t = useT();
  const status = item.item.status;
  const verifying = status === "verifying";
  const color = TONE_COLOR[runTone(status)];
  const label = verifying
    ? t.labels.runStatus.verifying
    : runStatusLabel(t, status, item.item.gate);
  const message = verifying ? t.workspace.stream.verifyingMessage : item.item.message;
  return (
    <div className="st-status" data-status={status}>
      <span className="st-status-dot">
        <StatusDot color={color} />
      </span>
      <span style={{ color }}>{label}</span>
      {message && <span className="st-status-msg">{message}</span>}
      <span className="st-spacer" />
      <span className="st-mono-muted">{clockTime(item.item.ts)}</span>
    </div>
  );
}

export function ErrorRow({ item }: { item: Of<"error"> }) {
  const t = useT();
  const color = TONE_COLOR.danger;
  return (
    <div className="st-status" role="alert" data-error={item.item.code}>
      <span className="st-status-dot">
        <StatusDot color={color} />
      </span>
      <span style={{ color }}>{t.labels.runError[item.item.code]}</span>
      <span className="st-status-msg">
        {item.item.message}
        {item.item.fatal && ` ${t.workspace.stream.fatal}`}
      </span>
      <span className="st-spacer" />
      <span className="st-mono-muted">{clockTime(item.item.ts)}</span>
    </div>
  );
}

export function RateLimitedRow({ item }: { item: Of<"rate_limited"> }) {
  const t = useT();
  const color = TONE_COLOR.warn;
  return (
    <div className="st-status">
      <span className="st-status-dot">
        <StatusDot color={color} />
      </span>
      <span style={{ color }}>{t.labels.runStatus.rate_limited}</span>
      <span className="st-status-msg">
        {item.item.message}
        {item.item.resetsAt &&
          ` ${t.workspace.stream.rateLimitResetsAt(formatTime(item.item.resetsAt))}`}
      </span>
      <span className="st-spacer" />
      <span className="st-mono-muted">{clockTime(item.item.ts)}</span>
    </div>
  );
}

// ---------- 系統事件 ----------

function SystemLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="st-sys">
      <span className="st-sys-icon">{icon}</span>
      <div className="st-sys-text">{children}</div>
    </div>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="st-sys-code">{children}</code>
);

export function SystemRow({ item }: { item: Of<"system"> }) {
  const t = useT();
  const w = t.workspace.stream;
  const event = item.item;
  switch (event.type) {
    case "worktree_ready":
      return (
        <SystemLine icon={<GitBranch {...ICON} />}>
          {w.worktreeReady} <Code>{event.branch ?? w.noBranch}</Code> {w.worktreeBase}{" "}
          <Code>{event.baseCommit.slice(0, 7)}</Code>
        </SystemLine>
      );
    case "preview_ready":
      return (
        <SystemLine icon={<Globe {...ICON} />}>
          {w.previewReady} <Code>{event.url.replace(/^https?:\/\//, "")}</Code>
        </SystemLine>
      );
    case "preview_stopped":
      return (
        <SystemLine icon={<Globe {...ICON} />}>
          {w.previewStopped} {t.labels.previewStopReason[event.reason]}
          {event.exitCode !== null && (
            <>
              {" "}
              <Code>{w.exitCode(event.exitCode)}</Code>
            </>
          )}
          {event.output && <pre className="st-tool-out">{event.output}</pre>}
        </SystemLine>
      );
    case "run_diff":
      return <SystemLine icon={<FileDiff {...ICON} />}>{w.runDiff(event.fileCount)}</SystemLine>;
    case "child_merged":
      return (
        <SystemLine icon={<GitMerge {...ICON} />}>
          {event.outcome === "merged" ? w.childMerged : w.childConflict}{" "}
          <Code>{event.childRunId}</Code>
          {event.commitSha && (
            <>
              {" "}
              <Code>{event.commitSha.slice(0, 7)}</Code>
            </>
          )}
          {event.conflictedPaths.map((path) => (
            <div key={path}>
              <Code>{path}</Code>
            </div>
          ))}
        </SystemLine>
      );
    case "verification_completed":
      return (
        <SystemLine icon={<ListChecks {...ICON} />}>
          {w.verificationCompleted(event.attempt)} {t.labels.verificationOutcome[event.outcome]}
        </SystemLine>
      );
  }
}

/** TODO(backend, run-settings)：執行中切換設定的系統事件。 */
export function SwitchRow({ item }: { item: Of<"switch"> }) {
  const t = useT();
  const w = t.workspace.stream;
  const change = item.change;
  if (change.kind === "model") {
    return (
      <SystemLine
        icon={change.agent ? <AgentLogo agent={change.agent} size={14} /> : <Bot {...ICON} />}
      >
        {w.modelSwitched} <Code>{change.model ? modelDisplayName(change.model) : ""}</Code>
        {w.fromNextStep}
      </SystemLine>
    );
  }
  if (change.kind === "effort") {
    return (
      <SystemLine icon={<Brain {...ICON} />}>
        {w.effortSet} <Code>{change.effort ? t.workspace.effort[change.effort] : ""}</Code>
      </SystemLine>
    );
  }
  return (
    <SystemLine icon={<Shield {...ICON} />}>
      {w.policySet}{" "}
      <Code>
        {change.permissionPolicy ? t.labels.permissionPolicy[change.permissionPolicy] : ""}
      </Code>
    </SystemLine>
  );
}

/** TODO(backend, task-pull-request)：開出與合併 PR 的系統事件。 */
export function PullRequestRow({ item }: { item: Of<"pull_request"> }) {
  const t = useT();
  const w = t.workspace.stream;
  return (
    <SystemLine icon={item.merged ? <GitMerge {...ICON} /> : <GitPullRequest {...ICON} />}>
      <a href={item.pr.url} target="_blank" rel="noreferrer" className="st-sys-link">
        {item.merged ? w.prMerged(item.pr.number) : w.prOpened(item.pr.number)}
      </a>
    </SystemLine>
  );
}

// ---------- 尾列 ----------

export function TailRow({ tail }: { tail: StreamTail }) {
  const t = useT();
  const env = useStreamEnv();
  return (
    <div className="st-tail" data-testid="stream-tail">
      <button
        type="button"
        className="st-icon-btn"
        aria-label={t.workspace.stream.copy}
        data-tip={t.workspace.stream.copy}
        onClick={() => env.copy(tail.text)}
      >
        <Copy {...ICON} />
      </button>
      <span className="st-tail-text">{relativeTime(tail.ts, env.now, t.common)}</span>
      <span className="st-tail-text">
        {t.workspace.stream.workedFor(duration(tail.turnSeconds, t.common))}
      </span>
    </div>
  );
}
