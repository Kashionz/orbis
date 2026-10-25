// Task 分享、Task 邀請與預覽邀請的 MSW handler（ADR-0012、ADR-0015）：路徑、輸入與回應同 @orbis/api-contract。
// 狀態只存在記憶體，重新整理後回到預設。邀請連結的 token 只出現在建立的回應中（同 Server）。

import {
  AddTaskShareMembersInput,
  API_ROUTES,
  CreatePreviewInviteInput,
  CreateTaskInviteInput,
  type PreviewInvite,
  type PreviewInviteCreated,
  type PreviewInviteDuration,
  TASK_INVITE_TTL_DAYS,
  type TaskInvite,
  type TaskInviteCreated,
  type TaskShare,
  type TaskShareMember,
  UpdateGeneralAccessInput,
  UpdateTaskShareMemberInput,
} from "@orbis/api-contract";
import { http } from "msw";
import { ME_ID, type MockBackend, MockError } from "./backend";
import { handle, parse } from "./handlers";

const HOUR_MS = 60 * 60 * 1000;
const DURATION_MS: Record<PreviewInviteDuration, number> = {
  "1h": HOUR_MS,
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
};

/** mock 中已知的 GitHub 帳號（Team 成員之外的受邀者）。 */
const GITHUB_USERS: Record<string, number> = { "client-reviewer": 9001, "design-partner": 9002 };

function token(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

class MockSharing {
  private readonly members = new Map<string, TaskShareMember[]>();
  private readonly invites = new Map<string, TaskInvite[]>();
  private readonly previewInvites = new Map<string, PreviewInvite[]>();
  private counter = 0;

  constructor(private readonly backend: MockBackend) {}

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-share-${this.counter}`;
  }

  private taskMembers(taskId: string): TaskShareMember[] {
    const task = this.backend.task(taskId);
    let list = this.members.get(taskId);
    if (!list) {
      const owner = task.createdByMemberId;
      // ORB-4 預設多一位可操作的成員與一筆 Email 邀請，展示完整的分享卡
      const sample = task.key.endsWith("-4");
      list = [
        ...(owner ? [{ memberId: owner, role: "owner" as const }] : []),
        ...(sample && owner !== "member-alice"
          ? [{ memberId: "member-alice", role: "edit" as const }]
          : []),
      ];
      this.members.set(taskId, list);
      if (sample) {
        const now = new Date();
        this.invites.set(taskId, [
          {
            id: this.id("invite"),
            email: "ops@example.com",
            role: "view",
            expiresAt: new Date(now.getTime() + TASK_INVITE_TTL_DAYS * 24 * HOUR_MS).toISOString(),
            invitedByMemberId: owner ?? ME_ID,
            createdAt: now.toISOString(),
          },
        ]);
      }
    }
    return list;
  }

  /** 管理分享：Task 的擁有者、Admin 以上（同 Server 的 requireManage）。 */
  private requireManage(taskId: string): void {
    const task = this.backend.task(taskId);
    if (task.viewerAccess !== "manage") {
      throw new MockError(403, "forbidden", "只有 Task 的擁有者與 Admin 以上能管理分享");
    }
  }

  share(taskId: string): TaskShare {
    const task = this.backend.task(taskId);
    const members = this.taskMembers(taskId);
    const now = Date.now();
    return {
      ownerMemberId: members.find((m) => m.role === "owner")?.memberId ?? null,
      members: [...members],
      invites: (this.invites.get(taskId) ?? []).filter((i) => Date.parse(i.expiresAt) > now),
      generalAccess: task.generalAccess,
    };
  }

  private upsert(taskId: string, memberId: string, role: "edit" | "view"): void {
    const list = this.taskMembers(taskId);
    const entry = list.find((m) => m.memberId === memberId);
    // 擁有者不會因為加入而降級
    if (entry && entry.role !== "owner") entry.role = role;
    else if (!entry) list.push({ memberId, role });
  }

  addMembers(taskId: string, input: AddTaskShareMembersInput): TaskShare {
    this.requireManage(taskId);
    const known = new Set(this.backend.members().map((m) => m.id));
    if (input.memberIds.some((id) => !known.has(id))) {
      throw new MockError(404, "not_found", "找不到 Member");
    }
    for (const memberId of input.memberIds) this.upsert(taskId, memberId, input.role);
    return this.share(taskId);
  }

  setRole(taskId: string, memberId: string, input: UpdateTaskShareMemberInput): TaskShare {
    this.requireManage(taskId);
    const list = this.taskMembers(taskId);
    const target = list.find((m) => m.memberId === memberId);
    if (input.role === "owner") {
      if (!this.backend.members().some((m) => m.id === memberId)) {
        throw new MockError(404, "not_found", "找不到 Member");
      }
      if (target?.role === "owner") return this.share(taskId);
      for (const m of list) if (m.role === "owner") m.role = "edit";
      if (target) target.role = "owner";
      else list.push({ memberId, role: "owner" });
      const task = this.backend.task(taskId);
      task.createdByMemberId = memberId;
      return this.share(taskId);
    }
    if (!target) throw new MockError(404, "not_found", "找不到 Task 成員");
    if (target.role === "owner") {
      throw new MockError(409, "conflict", "要改變擁有者的角色，請先把擁有者轉移給別人");
    }
    target.role = input.role;
    return this.share(taskId);
  }

  remove(taskId: string, memberId: string): TaskShare {
    this.requireManage(taskId);
    const list = this.taskMembers(taskId);
    const target = list.find((m) => m.memberId === memberId);
    if (!target) throw new MockError(404, "not_found", "找不到 Task 成員");
    if (target.role === "owner") {
      throw new MockError(409, "conflict", "不能移除擁有者，請先把擁有者轉移給別人");
    }
    this.members.set(
      taskId,
      list.filter((m) => m.memberId !== memberId),
    );
    return this.share(taskId);
  }

  setGeneral(taskId: string, input: UpdateGeneralAccessInput): TaskShare {
    this.requireManage(taskId);
    this.backend.task(taskId).generalAccess = input.generalAccess;
    return this.share(taskId);
  }

  invite(taskId: string, input: CreateTaskInviteInput): TaskInviteCreated {
    this.requireManage(taskId);
    const email = input.email.trim().toLowerCase();
    const member = this.backend.members().find((m) => m.email === email);
    if (member) {
      this.upsert(taskId, member.id, input.role);
      return { kind: "member_added", member, role: input.role };
    }
    const now = new Date();
    const invite: TaskInvite = {
      id: this.id("invite"),
      email,
      role: input.role,
      expiresAt: new Date(now.getTime() + TASK_INVITE_TTL_DAYS * 24 * HOUR_MS).toISOString(),
      invitedByMemberId: ME_ID,
      createdAt: now.toISOString(),
    };
    // 同一個 email 已有邀請時先撤銷，再產生新的
    this.invites.set(taskId, [
      ...(this.invites.get(taskId) ?? []).filter((i) => i.email !== email),
      invite,
    ]);
    return {
      kind: "invited",
      invite,
      inviteUrl: `${window.location.origin}/invites/${token()}`,
      emailSent: this.backend.config.smtp ?? false,
    };
  }

  revokeInvite(taskId: string, inviteId: string): TaskShare {
    this.requireManage(taskId);
    const list = this.invites.get(taskId) ?? [];
    if (!list.some((i) => i.id === inviteId)) throw new MockError(404, "not_found", "找不到邀請");
    this.invites.set(
      taskId,
      list.filter((i) => i.id !== inviteId),
    );
    return this.share(taskId);
  }

  // ---------- 預覽邀請（ADR-0015） ----------

  private requirePreviewInvites(runId: string): void {
    const run = this.backend.run(runId);
    const task = this.backend.task(run.taskId);
    if (task.viewerAccess === "view") {
      throw new MockError(403, "forbidden", "沒有權限邀請別人檢視這個 Preview");
    }
    if (!this.backend.team().allowExternalPreview) {
      throw new MockError(403, "preview_sharing_disabled", "Team 設定沒有打開對外分享預覽");
    }
  }

  previewInviteList(runId: string): PreviewInvite[] {
    this.backend.run(runId);
    const now = Date.now();
    return (this.previewInvites.get(runId) ?? [])
      .map((invite) => ({
        ...invite,
        status:
          invite.revokedAt !== null
            ? ("revoked" as const)
            : Date.parse(invite.expiresAt) <= now
              ? ("expired" as const)
              : ("active" as const),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createPreviewInvite(runId: string, input: CreatePreviewInviteInput): PreviewInviteCreated {
    this.requirePreviewInvites(runId);
    const duration = input.duration ?? "24h";
    let githubLogin: string | null = null;
    let githubUserId: number | null = null;
    let email: string | null = null;
    if ("githubLogin" in input) {
      const login = input.githubLogin.trim();
      const member = this.backend.members().find((m) => m.githubLogin === login);
      githubUserId = member?.githubUserId ?? GITHUB_USERS[login] ?? null;
      if (githubUserId === null) {
        throw new MockError(422, "invalid_input", `找不到 GitHub 帳號 ${login}`);
      }
      githubLogin = login;
    } else {
      email = input.email.trim().toLowerCase();
    }
    const now = new Date();
    const invite: PreviewInvite = {
      id: this.id("preview-invite"),
      runId,
      githubLogin,
      githubUserId,
      email,
      expiresAt: new Date(now.getTime() + DURATION_MS[duration]).toISOString(),
      createdByMemberId: ME_ID,
      createdAt: now.toISOString(),
      revokedAt: null,
      lastOpenedAt: null,
      status: "active",
    };
    this.previewInvites.set(runId, [...(this.previewInvites.get(runId) ?? []), invite]);
    return {
      invite,
      inviteUrl: `${window.location.origin}/preview-invites/${token()}`,
      emailSent: email !== null && (this.backend.config.smtp ?? false),
    };
  }

  /** 撤銷：Team 設定關閉後仍可以撤銷（同 Server）。 */
  revokePreviewInvite(runId: string, inviteId: string): void {
    const run = this.backend.run(runId);
    if (this.backend.task(run.taskId).viewerAccess === "view") {
      throw new MockError(403, "forbidden", "沒有權限撤銷這個預覽邀請");
    }
    const invite = (this.previewInvites.get(runId) ?? []).find((i) => i.id === inviteId);
    if (!invite) throw new MockError(404, "not_found", "找不到預覽邀請");
    invite.revokedAt ??= new Date().toISOString();
  }
}

export function createShareHandlers(backend: MockBackend) {
  const sharing = new MockSharing(backend);
  return [
    http.get(
      API_ROUTES.taskShare,
      handle((_, p) => sharing.share(p.taskId ?? "")),
    ),
    http.post(
      API_ROUTES.taskShareMembers,
      handle(async (request, p) =>
        sharing.addMembers(p.taskId ?? "", await parse(request, AddTaskShareMembersInput)),
      ),
    ),
    http.patch(
      API_ROUTES.taskShareMember,
      handle(async (request, p) =>
        sharing.setRole(
          p.taskId ?? "",
          p.memberId ?? "",
          await parse(request, UpdateTaskShareMemberInput),
        ),
      ),
    ),
    http.delete(
      API_ROUTES.taskShareMember,
      handle((_, p) => sharing.remove(p.taskId ?? "", p.memberId ?? "")),
    ),
    http.put(
      API_ROUTES.taskShareGeneral,
      handle(async (request, p) =>
        sharing.setGeneral(p.taskId ?? "", await parse(request, UpdateGeneralAccessInput)),
      ),
    ),
    http.post(
      API_ROUTES.taskShareInvites,
      handle(
        async (request, p) =>
          sharing.invite(p.taskId ?? "", await parse(request, CreateTaskInviteInput)),
        201,
      ),
    ),
    http.delete(
      API_ROUTES.taskShareInvite,
      handle((_, p) => sharing.revokeInvite(p.taskId ?? "", p.inviteId ?? "")),
    ),
    http.get(
      API_ROUTES.runPreviewInvites,
      handle((_, p) => sharing.previewInviteList(p.runId ?? "")),
    ),
    http.post(
      API_ROUTES.runPreviewInvites,
      handle(
        async (request, p) =>
          sharing.createPreviewInvite(
            p.runId ?? "",
            await parse(request, CreatePreviewInviteInput),
          ),
        201,
      ),
    ),
    http.delete(
      API_ROUTES.runPreviewInvite,
      handle((_, p) => {
        sharing.revokePreviewInvite(p.runId ?? "", p.inviteId ?? "");
      }),
    ),
  ];
}
