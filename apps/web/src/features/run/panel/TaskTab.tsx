// 右側的任務分頁：狀態、儲存庫、指派對象、依賴、計畫關卡、規格檔；規格（檢視與內嵌編輯）、
// 驗收條件、驗收紀錄、執行紀錄、留言。

import type {
  Member,
  Project,
  Run,
  Task,
  UpdateTaskInput,
  Verification,
} from "@orbis/api-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  acceptanceCriteriaQuery,
  membersQuery,
  queryKeys,
  repoSpecsQuery,
  reposQuery,
  taskMentionsQuery,
  tasksQuery,
  updateTask,
} from "../../../api/resources";
import { Avatar } from "../../../components/Avatar";
import { DoneReasonBadge } from "../../../components/DoneReasonBadge";
import { ErrorText } from "../../../components/ErrorText";
import { type MenuGroup, Popover } from "../../../components/Popover";
import { StatusDot } from "../../../components/StatusDot";
import { useT } from "../../../i18n";
import { repoDisplayName } from "../../../lib/github";
import type { Permissions } from "../../auth/use-permissions";
import { CollabEditor } from "../../collab/CollabEditor";
import { TaskComments } from "../../task/TaskComments";
import { TONE_COLOR, taskTone } from "../run-tone";
import { VERIFICATION_FOCUS } from "../workspace/route-state";
import { AcceptanceList } from "./AcceptanceList";
import { RunHistory } from "./RunHistory";
import { SpecEditor } from "./SpecEditor";
import { VerificationSection } from "./VerificationSection";

interface TaskTabProps {
  task: Task;
  project: Project;
  runs: readonly Run[];
  run: Run | null;
  verifications: readonly Verification[];
  needs: boolean;
  permissions: Permissions;
  /** 要捲到的區塊（`verification`）。 */
  focus: string | null;
}

export function TaskTab({
  task,
  project,
  runs,
  run,
  verifications,
  needs,
  permissions,
  focus,
}: TaskTabProps) {
  const t = useT();
  const w = t.workspace.task;
  const canEdit = permissions.can("task.edit");
  const [editing, setEditing] = useState(false);
  const { data: criteria = [] } = useQuery(acceptanceCriteriaQuery(task.id));
  const { data: mentions = [] } = useQuery(taskMentionsQuery(task.id));
  const scrollRef = useRef<HTMLDivElement>(null);

  // 捲到驗收紀錄（待我處理的「Run 已停下」）
  useEffect(() => {
    if (focus !== VERIFICATION_FOCUS || verifications.length === 0) return;
    scrollRef.current
      ?.querySelector(`#${VERIFICATION_FOCUS}`)
      ?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [focus, verifications.length]);

  return (
    <div ref={scrollRef} className="rp-scroll">
      <div className="rp-task">
        <TaskMeta task={task} project={project} needs={needs} canEdit={canEdit} />
        {editing ? (
          <SpecEditor
            task={task}
            project={project}
            criteria={criteria}
            mentions={mentions}
            onClose={() => setEditing(false)}
          />
        ) : (
          <>
            <section className="rp-section" aria-labelledby="rp-spec-heading">
              <div className="rp-section-head">
                <h2 id="rp-spec-heading" className="rp-section-title">
                  {w.spec}
                </h2>
                {canEdit && (
                  <button type="button" className="rp-text-btn" onClick={() => setEditing(true)}>
                    {w.edit}
                  </button>
                )}
              </div>
              {/* 檢視時也是共同編輯文件（唯讀）：看得到其他人即時的修改與在線名單 */}
              <div className="rp-spec rp-spec-view">
                <CollabEditor
                  docRef={{ kind: "task-description", id: task.id }}
                  label={w.spec}
                  canEdit={false}
                  hideReadOnly={canEdit}
                  projectId={project.id}
                  mentions={mentions}
                  placeholder={w.notWritten}
                />
              </div>
            </section>
            <AcceptanceList
              criteria={criteria}
              verifications={verifications}
              projectId={project.id}
              canEdit={canEdit}
            />
          </>
        )}
        {run && (
          <VerificationSection
            runId={run.id}
            taskId={task.id}
            verifications={verifications}
            maxRetries={project.policy.verificationMaxRetries}
            canDecide={permissions.can("run.control")}
            canSkip={permissions.can("gate.approve")}
          />
        )}
        <RunHistory
          taskKey={task.key}
          runs={runs}
          currentRunId={run?.id ?? null}
          canCancel={permissions.can("run.control")}
        />
        <section className="rp-section rp-comments">
          <TaskComments
            taskId={task.id}
            projectId={project.id}
            memberId={permissions.ctx.memberId}
            canComment={permissions.can("view")}
          />
        </section>
      </div>
    </div>
  );
}

// ---------- 基本資料 ----------

function useUpdateTask(task: Task) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => updateTask(task.id, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.taskByKey(updated.key), updated);
      queryClient.setQueryData(queryKeys.task(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(updated.projectId) });
    },
  });
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="rp-meta-label">{label}</span>
      <span className="rp-meta-value">{children}</span>
    </>
  );
}

/** 可以編輯時是開選單的按鈕，否則只是文字。 */
function MetaPicker<V>({
  label,
  canEdit,
  children,
  groups,
  onSelect,
  closeOnSelect = true,
}: {
  label: string;
  canEdit: boolean;
  children: ReactNode;
  groups: MenuGroup<V>[];
  onSelect: (value: V) => void;
  closeOnSelect?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!canEdit) return <span className="rp-meta-text">{children}</span>;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="rp-meta-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        {children}
      </button>
      <Popover
        anchorRef={ref}
        open={open}
        onClose={() => setOpen(false)}
        groups={groups}
        onSelect={onSelect}
        label={label}
        prefer="down"
        minWidth={220}
        closeOnSelect={closeOnSelect}
      />
    </>
  );
}

function MemberLabel({ member, size }: { member: Member | undefined; size: number }) {
  const t = useT();
  return (
    <span className="rp-person">
      <Avatar
        person={member ? { name: member.githubLogin, avatarUrl: member.avatarUrl } : null}
        size={size}
      />
      <span>{member ? `@${member.githubLogin}` : t.common.unassigned}</span>
    </span>
  );
}

function TaskMeta({
  task,
  project,
  needs,
  canEdit,
}: {
  task: Task;
  project: Project;
  needs: boolean;
  canEdit: boolean;
}) {
  const t = useT();
  const w = t.workspace.task;
  const update = useUpdateTask(task);
  const { data: members = [] } = useQuery(membersQuery);
  const { data: repos = [] } = useQuery(reposQuery(project.id));
  const { data: projectTasks = [] } = useQuery(tasksQuery(project.id));
  const { data: specs = [] } = useQuery({
    ...repoSpecsQuery(task.repoId ?? ""),
    enabled: task.repoId !== null && task.specPath !== null,
  });
  const repo = repos.find((r) => r.id === task.repoId);
  const assignee = members.find((m) => m.id === task.assigneeMemberId);
  const depends = task.dependsOn
    .map((id) => projectTasks.find((p) => p.id === id))
    .filter((p): p is Task => p !== undefined);
  const spec = specs.find((s) => s.path === task.specPath);
  const planGate = task.planGateEnabled === null ? "inherit" : task.planGateEnabled ? "on" : "off";
  const planGateLabel = {
    inherit: w.planGateInherit(project.policy.planGateEnabled),
    on: w.planGateOn,
    off: w.planGateOff,
  } as const;

  return (
    <div className="rp-meta">
      <MetaRow label={w.status}>
        <span className="rp-status" style={{ color: TONE_COLOR[taskTone(task.status)] }}>
          <StatusDot color="currentColor" />
          {t.labels.taskStatus[task.status]}
        </span>
        <DoneReasonBadge task={task} />
        {needs && <span className="rp-needs">{w.needsYou}</span>}
      </MetaRow>
      <MetaRow label={w.repo}>
        {/* Repo 只能從沒有補指定一次，之後不能更換（ADR-0011 的修訂） */}
        <MetaPicker<string>
          label={w.assignRepo}
          canEdit={canEdit && task.repoId === null && repos.length > 0}
          groups={[
            {
              items: repos.map((r) => ({
                value: r.id,
                label: repoDisplayName(r),
                mono: true,
                checked: false,
              })),
            },
          ]}
          onSelect={(repoId) => update.mutate({ repoId })}
        >
          <span className="rp-mono">{repo ? repoDisplayName(repo) : t.common.notSpecified}</span>
        </MetaPicker>
      </MetaRow>
      <MetaRow label={w.assignee}>
        <MetaPicker<string | null>
          label={w.assignee}
          canEdit={canEdit}
          groups={[
            {
              items: [
                {
                  value: null,
                  label: t.common.unassigned,
                  checked: task.assigneeMemberId === null,
                },
                ...members.map((member) => ({
                  value: member.id,
                  label: `@${member.githubLogin}`,
                  sub: member.name ?? undefined,
                  icon: (
                    <Avatar
                      person={{ name: member.githubLogin, avatarUrl: member.avatarUrl }}
                      size={18}
                    />
                  ),
                  checked: member.id === task.assigneeMemberId,
                })),
              ],
            },
          ]}
          onSelect={(assigneeMemberId) => update.mutate({ assigneeMemberId })}
        >
          <MemberLabel member={assignee} size={20} />
        </MetaPicker>
      </MetaRow>
      <MetaRow label={w.dependsOn}>
        <MetaPicker<string>
          label={w.dependsOn}
          canEdit={canEdit}
          closeOnSelect={false}
          groups={[
            {
              items: projectTasks
                .filter((p) => p.id !== task.id)
                .map((p) => ({
                  value: p.id,
                  label: `${p.key} ${p.title}`,
                  checked: task.dependsOn.includes(p.id),
                })),
            },
          ]}
          onSelect={(id) =>
            update.mutate({
              dependsOn: task.dependsOn.includes(id)
                ? task.dependsOn.filter((d) => d !== id)
                : [...task.dependsOn, id],
            })
          }
        >
          {depends.length === 0 ? (
            <span className="rp-muted">{w.dependsNone}</span>
          ) : (
            depends.map((dep) => (
              <span key={dep.id} className="rp-depend">
                <span className="rp-mono">{dep.key}</span>
                <span
                  style={{ color: dep.status === "done" ? TONE_COLOR.success : TONE_COLOR.warn }}
                >
                  {t.labels.taskStatus[dep.status]}
                </span>
              </span>
            ))
          )}
        </MetaPicker>
      </MetaRow>
      <MetaRow label={w.planGate}>
        <MetaPicker<"inherit" | "on" | "off">
          label={w.planGate}
          canEdit={canEdit}
          groups={[
            {
              items: (["inherit", "on", "off"] as const).map((value) => ({
                value,
                label: planGateLabel[value],
                checked: value === planGate,
              })),
            },
          ]}
          onSelect={(value) =>
            update.mutate({ planGateEnabled: value === "inherit" ? null : value === "on" })
          }
        >
          {planGateLabel[planGate]}
        </MetaPicker>
      </MetaRow>
      {task.specPath && (
        <MetaRow label={w.specFile}>
          {spec ? (
            <Link to="/repo-specs/$repoSpecId" params={{ repoSpecId: spec.id }} className="rp-mono">
              {task.specPath}
            </Link>
          ) : (
            <span className="rp-mono">{task.specPath}</span>
          )}
        </MetaRow>
      )}
      {update.error ? (
        <div className="rp-meta-error">
          <ErrorText error={update.error} />
        </div>
      ) : null}
    </div>
  );
}
