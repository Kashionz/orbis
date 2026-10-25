// 輸入框：執行環境列、待處理動作的 dock、文字框、chip 列與送出鍵。送出做什麼依 Run 的狀態決定
// （composer-state.ts）。

import type { Project, PromptDelivery, Run, Task } from "@orbis/api-contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Zap } from "lucide-react";
import { useEffect, useRef } from "react";
import { decideGate, decideVerification, queryKeys } from "../../../api/resources";
import { ErrorText } from "../../../components/ErrorText";
import { useT } from "../../../i18n";
import { clearPreviewDrafts, loadPreviewDrafts } from "../../preview/preview-drafts";
import { EMPTY_DRAFT, loadDraft, saveDraft, sortComments } from "../../review/review-drafts";
import type { RunWorkspaceData } from "../workspace/use-run-workspace";
import { submitRunPrompt } from "../workspace-api";
import { ComposerChips } from "./ComposerChips";
import {
  type ComposerSituation,
  type DockState,
  dockFor,
  type PendingPermission,
  type SendAction,
  sendStateFor,
} from "./composer-state";
import { EnvBar } from "./EnvBar";
import "./composer.css";

interface ComposerProps {
  run: Run;
  task: Task;
  project: Project;
  data: RunWorkspaceData;
  pendingPermission: PendingPermission | null;
  /** Review Gate 的 diff 摘要（dock 顯示）。 */
  reviewStats: { files: number; adds: number; dels: number } | null;
  /** 文字框的內容（事件串流的「編輯」會放進來）。 */
  text: string;
  onTextChange: (text: string) => void;
  /** 輸入框要求 focus 的次數（編輯 prompt 後 focus 到文字框）。 */
  focusSignal: number;
  onJumpTo: (key: string) => void;
  onOpenTab: (tab: "diff" | "task" | "terminal", focus?: string) => void;
}

export function Composer({
  run,
  task,
  project,
  data,
  pendingPermission,
  reviewStats,
  text,
  onTextChange,
  focusSignal,
  onJumpTo,
  onOpenTab,
}: ComposerProps) {
  const t = useT();
  const c = t.workspace.composer;
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { permissions } = data;

  useEffect(() => {
    if (focusSignal > 0) textareaRef.current?.focus();
  }, [focusSignal]);

  const situation: ComposerSituation = {
    status: data.status,
    gate: data.gate,
    pendingPermission,
    planGatePending: data.planGate !== null,
    reviewGatePending: data.reviewGate !== null,
    verificationAwaitingDecision: data.verificationAwaitingDecision,
  };
  const dock = dockFor(situation);
  const send = sendStateFor(situation, {
    reject: permissions.can("gate.reject"),
    control: permissions.can("run.control"),
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.taskGates(task.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.run(run.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.verifications(run.id) }),
      queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.needsYou }),
    ]);
  }

  const submit = useMutation({
    mutationFn: async ({
      action,
      message,
      delivery = "queue",
    }: {
      action: SendAction;
      message: string;
      delivery?: PromptDelivery;
    }) => {
      switch (action) {
        case "prompt":
          // 回合中或等待權限回覆時排隊，回合結束後送出；interrupt 先中斷目前的回合
          await submitRunPrompt(run.id, { text: message, delivery });
          return;
        case "plan_reject":
          if (!data.planGate) return;
          await decideGate(data.planGate.id, { action: "reject", comment: message });
          return;
        case "review_reject": {
          if (!data.reviewGate) return;
          const draft = loadDraft(run.id);
          await decideGate(data.reviewGate.id, {
            action: "reject",
            comment: message,
            reviewComments: sortComments(draft.comments),
            previewComments: loadPreviewDrafts(run.id),
          });
          saveDraft(run.id, EMPTY_DRAFT);
          clearPreviewDrafts(run.id);
          return;
        }
        case "verification_retry":
          await decideVerification(run.id, { action: "retry", comment: message });
          return;
      }
    },
    onSuccess: async () => {
      onTextChange("");
      await refresh();
    },
  });

  const approvePlan = useMutation({
    mutationFn: () =>
      data.planGate ? decideGate(data.planGate.id, { action: "approve" }) : Promise.resolve(null),
    onSuccess: refresh,
  });

  const finished = send.blocker === "finished";
  const canSend = text.trim() !== "" && send.blocker === null && !submit.isPending;
  const sendTip =
    send.blocker === "not_accepting"
      ? c.notAccepting
      : send.blocker === "forbidden"
        ? c.forbidden
        : send.action === "prompt" && data.status !== "starting"
          ? c.queuedHint
          : c.sendTooltip[send.action];
  // 執行中可以選擇中斷目前的回合後送出
  const canInterrupt = canSend && send.action === "prompt";

  function doSend(delivery: PromptDelivery = "queue") {
    if (!canSend) return;
    submit.mutate({ action: send.action, message: text.trim(), delivery });
  }

  return (
    <div className="cp-outer">
      <div className="cp-column">
        <EnvBar
          run={run}
          usage={data.usage}
          live={!finished}
          onOpenTerminalTab={() => onOpenTab("terminal")}
        />
        <div className="cp-box">
          {dock && (
            <Dock
              dock={dock}
              review={reviewStats}
              canApprovePlan={permissions.can("gate.approve")}
              approving={approvePlan.isPending}
              onAction={(kind) => {
                if (kind === "permission" && dock.kind === "permission")
                  onJumpTo(dock.permission.key);
                if (kind === "review_gate") onOpenTab("diff");
                if (kind === "plan_gate") approvePlan.mutate();
                if (kind === "verification_decision") onOpenTab("task", "verification");
              }}
            />
          )}
          <textarea
            ref={textareaRef}
            className="cp-textarea"
            rows={2}
            value={text}
            disabled={finished}
            aria-label={c.placeholder[finished ? "finished" : send.action]}
            placeholder={c.placeholder[finished ? "finished" : send.action]}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                doSend();
              }
            }}
          />
          <div className="cp-toolbar">
            <ComposerChips
              run={run}
              settings={data.settings}
              locked={finished || !permissions.can("run.control")}
              connected={!finished && data.connected}
            />
            {send.action === "prompt" && !finished && (
              <button
                type="button"
                className="cp-interrupt"
                aria-label={c.interruptSend}
                data-tip={c.interruptSend}
                aria-disabled={!canInterrupt || undefined}
                onClick={() => canInterrupt && doSend("interrupt")}
              >
                <Zap size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="cp-send"
              aria-label={c.send}
              data-tip={sendTip}
              data-ready={canSend}
              aria-disabled={!canSend || undefined}
              onClick={() => doSend()}
            >
              <ArrowUp size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>
        <ErrorText error={submit.error ?? approvePlan.error} />
      </div>
    </div>
  );
}

function Dock({
  dock,
  review,
  canApprovePlan,
  approving,
  onAction,
}: {
  dock: DockState;
  review: { files: number; adds: number; dels: number } | null;
  canApprovePlan: boolean;
  approving: boolean;
  onAction: (kind: DockState["kind"]) => void;
}) {
  const t = useT();
  const d = t.workspace.composer.dock;
  const [label, detail, action] =
    dock.kind === "permission"
      ? [d.permission, dock.permission.detail ?? dock.permission.title, d.jumpToRequest]
      : dock.kind === "review_gate"
        ? [
            d.reviewGate,
            review ? (
              <>
                {d.reviewDetail(review.files)}
                <span className="st-add">+{review.adds}</span>
                <span className="st-del">−{review.dels}</span>
              </>
            ) : null,
            d.openReview,
          ]
        : dock.kind === "plan_gate"
          ? [d.planGate, d.planDetail, canApprovePlan ? d.approvePlan : null]
          : [d.verification, d.verificationDetail, d.decide];
  return (
    <div className="cp-dock" data-kind={dock.kind}>
      <span className="cp-dock-dot" />
      <span className="cp-dock-label">{label}</span>
      <span className="cp-dock-detail">{detail}</span>
      <span className="cp-dock-spacer" />
      {action && (
        <button
          type="button"
          className="o-btn"
          data-variant="primary"
          disabled={approving}
          onClick={() => onAction(dock.kind)}
        >
          {action}
        </button>
      )}
    </div>
  );
}
