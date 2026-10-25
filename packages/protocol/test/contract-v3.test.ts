import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AgentInfo,
  type DispatchOffer,
  type DispatchRepo,
  EFFORTS,
  type Effort,
  type EffortSupport,
  type EventKind,
  type LOCAL_MERGE_STRATEGIES,
  LOGIN_HINT_KINDS,
  type LocalMergeStrategy,
  type LoginHintKind,
  MODEL_TAGS,
  type MODEL_SOURCES,
  type ModelSource,
  type ModelTag,
  PROMPT_DELIVERIES,
  PROMPT_SOURCES,
  PROTOCOL_VERSION,
  type PromptDelivery,
  REPO_KINDS,
  type REPO_SPEC_COMMIT_FAILURES,
  type RepoKind,
  type RepoSpecCommitFailure,
  RUN_CONTROL_ACTIONS,
  type RUN_SETTING_NAMES,
  type RunControlAction,
  type RunnerToServer,
  type RunSettingName,
  type ServerToRunner,
  TERMINAL_EXIT_REASONS,
  TERMINAL_IDLE_TIMEOUT_SECS,
  TERMINAL_MAX_CHUNK,
  TERMINAL_MAX_PER_RUN,
  type TerminalExitReason,
} from "../src/index";

const fixtureDir = new URL("../../../crates/orbis-protocol/tests/fixtures/", import.meta.url);

function fixtures(prefix: string): Record<string, unknown>[] {
  return readdirSync(fixtureDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8")));
}

describe("協定 v3：版本與列舉", () => {
  it("協定版本是 3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it("值陣列涵蓋對應型別的每一個值", () => {
    expectTypeOf<(typeof EFFORTS)[number]>().toEqualTypeOf<Effort>();
    expectTypeOf<(typeof PROMPT_DELIVERIES)[number]>().toEqualTypeOf<PromptDelivery>();
    expectTypeOf<(typeof REPO_KINDS)[number]>().toEqualTypeOf<RepoKind>();
    expectTypeOf<(typeof LOCAL_MERGE_STRATEGIES)[number]>().toEqualTypeOf<LocalMergeStrategy>();
    expectTypeOf<(typeof MODEL_TAGS)[number]>().toEqualTypeOf<ModelTag>();
    expectTypeOf<(typeof MODEL_SOURCES)[number]>().toEqualTypeOf<ModelSource>();
    expectTypeOf<(typeof LOGIN_HINT_KINDS)[number]>().toEqualTypeOf<LoginHintKind>();
    expectTypeOf<(typeof RUN_SETTING_NAMES)[number]>().toEqualTypeOf<RunSettingName>();
    expectTypeOf<(typeof TERMINAL_EXIT_REASONS)[number]>().toEqualTypeOf<TerminalExitReason>();
    expectTypeOf<
      (typeof REPO_SPEC_COMMIT_FAILURES)[number]
    >().toEqualTypeOf<RepoSpecCommitFailure>();
  });

  it("推理強度、模型標記與 Web 的原型一致", () => {
    expect(EFFORTS).toEqual(["fast", "std", "deep"]);
    expect(MODEL_TAGS).toEqual(["best", "balanced", "fast", "coding"]);
    expect(PROMPT_DELIVERIES[0]).toBe("queue");
    expect(REPO_KINDS).toEqual(["github", "local"]);
  });

  it("新增 prompt 來源 handoff 與 RunControl 動作", () => {
    expect(PROMPT_SOURCES).toContain("handoff");
    expect(RUN_CONTROL_ACTIONS).toEqual(
      expect.arrayContaining([
        "withdraw_prompt",
        "set_session_config",
        "set_permission_policy",
        "switch_agent",
        "merge_local",
      ]),
    );
  });

  it("終端機的上限與閒置時間", () => {
    expect(TERMINAL_MAX_PER_RUN).toBe(3);
    expect(TERMINAL_IDLE_TIMEOUT_SECS).toBe(30 * 60);
    expect(TERMINAL_MAX_CHUNK).toBe(64 * 1024);
  });
});

describe("協定 v3：型別的形狀", () => {
  it("AgentInfo.models 是 ModelInfo，推理強度以 kind 區分", () => {
    expectTypeOf<AgentInfo["models"][number]["effort"]>().toEqualTypeOf<EffortSupport>();
    expectTypeOf<Extract<EffortSupport, { kind: "fixed" }>["level"]>().toEqualTypeOf<Effort>();
    const [availability] = fixtures("runner_to_server.agent_availability.json") as {
      agents: AgentInfo[];
    }[];
    const models = availability?.agents.flatMap((agent) => agent.models) ?? [];
    expect(models.map((m) => m.effort.kind)).toEqual(
      expect.arrayContaining(["adjustable", "fixed", "unsupported"]),
    );
  });

  it("DispatchOffer.repo 以 kind 區分；本機 Repo 沒有 clone_url", () => {
    expectTypeOf<DispatchOffer["repo"]>().toEqualTypeOf<DispatchRepo>();
    type Local = Extract<DispatchRepo, { kind: "local" }>;
    expectTypeOf<Local>().not.toHaveProperty("clone_url");
    const kinds = fixtures("server_to_runner.dispatch_offer.").map(
      (f) => (f.repo as DispatchRepo).kind,
    );
    expect(new Set(kinds)).toEqual(new Set(["github", "local"]));
  });

  it("Prompt 的 delivery 與 Event 的 control_id 可以省略", () => {
    type Prompt = Extract<RunControlAction, { action: "prompt" }>;
    expectTypeOf<Prompt["delivery"]>().toEqualTypeOf<PromptDelivery | undefined>();
    type Submitted = Extract<EventKind, { kind: "prompt_submitted" }>;
    expectTypeOf<Omit<Submitted, "control_id">>().toExtend<Submitted>();
    type Resolved = Extract<EventKind, { kind: "permission_resolved" }>;
    expectTypeOf<Omit<Resolved, "control_id">>().toExtend<Resolved>();
  });

  it("WithdrawPrompt 的欄位不和 RunControl 的 control_id 撞名", () => {
    type Withdraw = Extract<RunControlAction, { action: "withdraw_prompt" }>;
    expectTypeOf<Withdraw>().toHaveProperty("prompt_control_id");
    expectTypeOf<Withdraw>().not.toHaveProperty("control_id");
  });

  it("終端機與 Repo Spec 提交的 frame 在兩個方向", () => {
    expectTypeOf<
      Extract<ServerToRunner, { type: "terminal_open" | "terminal_input" | "repo_spec_commit" }>
    >().not.toBeNever();
    expectTypeOf<
      Extract<RunnerToServer, { type: "terminal_output" | "repo_spec_commit_result" }>
    >().not.toBeNever();
  });
});
