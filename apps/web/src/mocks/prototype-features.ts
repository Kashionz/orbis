// 原型中有、後端還沒有的功能（lib/features.ts）在 mock 模式的完整行為。
// 路徑與資料形狀是暫定的（定義在各 feature 的 api.ts／types），不在 @orbis/api-contract 中。

import { http } from "msw";
import { z } from "zod";
import { AGENT_CATALOG_PATH, type AgentCatalogEntry } from "../features/agents/catalog";
import { TASK_WITHOUT_REPO_PATH } from "../features/new-task/api";
import {
  DesktopNotificationSetting,
  RunnerSettings,
  SETTINGS_ROUTES,
} from "../features/settings/api";
import {
  AddTaskShareInput,
  SHARE_ROUTES,
  type TaskShare,
  UpdateGeneralAccessInput,
  UpdateTaskShareMemberInput,
} from "../features/share/types";
import { ME_ID, type MockBackend, MockError } from "./backend";
import { handle, parse } from "./handlers";

/** 不指定 Repo 建立 Task 的暫定輸入（CreateTaskInput 去掉 repoId）。 */
const CreateTaskWithoutRepoInput = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().default(""),
    assigneeMemberId: z.string().nullable().default(null),
    dependsOn: z.array(z.string()).default([]),
  })
  .strict();

/** mock 的模型目錄：與 dispatch-options 的模型 id 一致，涵蓋可調整、固定、不支援三種推理強度。 */
export const MOCK_AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    agentId: "claude-code",
    tool: "Claude Code",
    vendor: "Anthropic",
    cliId: "claude",
    signedIn: true,
    models: [
      { id: "claude-opus-5-5", name: "Opus 5.5", tag: "best", effort: "adjustable" },
      { id: "claude-sonnet-5-5", name: "Sonnet 5.5", tag: "balanced", effort: "adjustable" },
      { id: "claude-haiku-5-5", name: "Haiku 5.5", tag: "fast", effort: "fixed:fast" },
    ],
  },
  {
    agentId: "codex",
    tool: "Codex",
    vendor: "OpenAI",
    cliId: "codex",
    signedIn: true,
    models: [
      { id: "gpt-5-codex", name: "GPT-5 Codex", tag: "coding", effort: "adjustable" },
      { id: "gpt-5", name: "GPT-5", tag: "best", effort: "adjustable" },
      { id: "gpt-5-mini", name: "GPT-5 Mini", tag: "fast", effort: "adjustable" },
    ],
  },
  {
    agentId: "antigravity",
    tool: "Antigravity",
    vendor: "Google",
    cliId: "agy",
    signedIn: false,
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tag: "best", effort: "adjustable" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tag: "fast", effort: "adjustable" },
    ],
  },
  {
    agentId: "grok-build",
    tool: "Grok Build",
    vendor: "xAI",
    cliId: "grok",
    signedIn: true,
    models: [
      { id: "grok-4", name: "Grok 4", tag: "best", effort: "none" },
      { id: "grok-code-fast-1", name: "Grok Code Fast 1", tag: "coding", effort: "none" },
    ],
  },
];

/** 每個 Task 的分享狀態（只存在記憶體，重新整理後回到預設）。 */
class MockShares {
  private readonly shares = new Map<string, TaskShare>();

  constructor(private readonly backend: MockBackend) {}

  get(taskId: string): TaskShare {
    const task = this.backend.task(taskId);
    let share = this.shares.get(taskId);
    if (!share) {
      const owner = task.createdByMemberId ?? ME_ID;
      // ORB-4 預設多一位可操作的成員與一筆 Email 邀請，展示完整的分享卡
      const sample = task.key.endsWith("-4");
      share = {
        members: [
          { memberId: owner, role: "owner" },
          ...(sample && owner !== "member-alice"
            ? [{ memberId: "member-alice", role: "edit" as const }]
            : []),
        ],
        invites: sample ? [{ email: "ops@example.com", role: "view" }] : [],
        general: "team-view",
      };
      this.shares.set(taskId, share);
    }
    return share;
  }

  add(taskId: string, input: AddTaskShareInput): TaskShare {
    const share = this.get(taskId);
    const known = new Set(this.backend.members().map((m) => m.id));
    for (const memberId of input.memberIds) {
      if (!known.has(memberId)) throw new MockError(404, "not_found", "找不到這位成員");
      if (!share.members.some((m) => m.memberId === memberId)) {
        share.members.push({ memberId, role: input.role });
      }
    }
    for (const email of input.emails) {
      if (!share.invites.some((i) => i.email === email)) {
        share.invites.push({ email, role: input.role });
      }
    }
    return share;
  }

  setRole(taskId: string, memberId: string, role: "edit" | "view"): TaskShare {
    const share = this.get(taskId);
    const entry = share.members.find((m) => m.memberId === memberId);
    if (!entry) throw new MockError(404, "not_found", "這位成員不在這個 Task 中");
    if (entry.role === "owner") throw new MockError(409, "invalid_state", "不能變更擁有者的角色");
    entry.role = role;
    return share;
  }

  remove(taskId: string, memberId: string): void {
    const share = this.get(taskId);
    if (share.members.some((m) => m.memberId === memberId && m.role === "owner")) {
      throw new MockError(409, "invalid_state", "不能移除擁有者");
    }
    share.members = share.members.filter((m) => m.memberId !== memberId);
  }

  revoke(taskId: string, email: string): void {
    const share = this.get(taskId);
    share.invites = share.invites.filter((i) => i.email !== email);
  }

  setGeneral(taskId: string, general: TaskShare["general"]): TaskShare {
    const share = this.get(taskId);
    share.general = general;
    return share;
  }
}

export function createPrototypeHandlers(backend: MockBackend) {
  const shares = new MockShares(backend);
  const catalog = structuredClone(MOCK_AGENT_CATALOG);
  const runnerSettings = new Map<string, RunnerSettings>();
  let desktopNotifications: DesktopNotificationSetting = { enabled: true };
  return [
    http.post(
      SETTINGS_ROUTES.agentRelogin,
      handle((_, p) => {
        const entry = catalog.find((agent) => agent.agentId === p.agentId);
        if (!entry) throw new MockError(404, "not_found", "找不到這個 Agent");
        // 模擬使用者在跳出的登入流程中完成登入
        entry.signedIn = true;
      }),
    ),
    http.get(
      SETTINGS_ROUTES.runnerSettings,
      handle((_, p) => runnerSettings.get(p.runnerId ?? "") ?? { windowsLongPaths: true }),
    ),
    http.put(
      SETTINGS_ROUTES.runnerSettings,
      handle(async (request, p) => {
        const settings = await parse(request, RunnerSettings);
        runnerSettings.set(p.runnerId ?? "", settings);
        return settings;
      }),
    ),
    http.get(
      SETTINGS_ROUTES.desktopNotifications,
      handle(() => desktopNotifications),
    ),
    http.put(
      SETTINGS_ROUTES.desktopNotifications,
      handle(async (request) => {
        desktopNotifications = await parse(request, DesktopNotificationSetting);
        return desktopNotifications;
      }),
    ),
    http.get(
      SHARE_ROUTES.share,
      handle((_, p) => shares.get(p.taskId ?? "")),
    ),
    http.post(
      SHARE_ROUTES.shareMembers,
      handle(async (request, p) =>
        shares.add(p.taskId ?? "", await parse(request, AddTaskShareInput)),
      ),
    ),
    http.patch(
      SHARE_ROUTES.shareMember,
      handle(async (request, p) =>
        shares.setRole(
          p.taskId ?? "",
          p.memberId ?? "",
          (await parse(request, UpdateTaskShareMemberInput)).role,
        ),
      ),
    ),
    http.delete(
      SHARE_ROUTES.shareMember,
      handle((_, p) => {
        shares.remove(p.taskId ?? "", p.memberId ?? "");
      }),
    ),
    http.delete(
      SHARE_ROUTES.shareInvite,
      handle((_, p) => {
        shares.revoke(p.taskId ?? "", decodeURIComponent(p.email ?? ""));
      }),
    ),
    http.put(
      SHARE_ROUTES.shareGeneral,
      handle(async (request, p) =>
        shares.setGeneral(p.taskId ?? "", (await parse(request, UpdateGeneralAccessInput)).general),
      ),
    ),
    http.get(
      AGENT_CATALOG_PATH,
      handle(() => catalog),
    ),
    http.post(
      TASK_WITHOUT_REPO_PATH,
      handle(async (request, p) => {
        const input = await parse(request, CreateTaskWithoutRepoInput);
        // Task 的 repoId 可以是 null（契約），只是建立的輸入要求 Repo
        return backend.createTaskAsMember(p.projectId ?? "", {
          ...input,
          repoId: null as unknown as string,
        });
      }, 201),
    ),
  ];
}
