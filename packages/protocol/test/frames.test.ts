import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AGENT_CAPABILITIES,
  type AgentCapability,
  DISPATCH_REJECT_REASONS,
  type DispatchRejectReason,
  EVENT_KINDS,
  type EventEnvelope,
  type EventFrame,
  type EventKind,
  type EventKindName,
  type PERMISSION_OPTION_KINDS,
  type PermissionOptionKind,
  RUN_CONTROL_ACTIONS,
  type RUN_CONTROL_REJECT_REASONS,
  type RUN_ERROR_CODES,
  type RunControl,
  type RunControlAction,
  type RunControlActionName,
  type RunControlRejectReason,
  type RunControlResult,
  type RunErrorCode,
  type RunnerToServer,
  type ServerToRunner,
  type TOOL_CALL_STATUSES,
  type TOOL_KINDS,
  type ToolCallStatus,
  type ToolKind,
} from "../src/index";

const fixtureDir = new URL("../../../crates/orbis-protocol/tests/fixtures/", import.meta.url);

/** 讀取某個前綴的 golden fixture（與 Rust 端的 wire_format 測試共用同一批檔案）。 */
function fixtures(prefix: string): Record<string, unknown>[] {
  return readdirSync(fixtureDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8")));
}

describe("frame 的 type", () => {
  it("Runner→Server 涵蓋所有 frame", () => {
    expectTypeOf<RunnerToServer["type"]>().toEqualTypeOf<
      | "hello"
      | "heartbeat"
      | "agent_availability"
      | "dispatch_accept"
      | "dispatch_reject"
      | "event"
      | "run_control_result"
    >();
  });

  it("Server→Runner 涵蓋所有 frame", () => {
    expectTypeOf<ServerToRunner["type"]>().toEqualTypeOf<
      "hello_ack" | "hello_rejected" | "dispatch_offer" | "run_control" | "event_ack"
    >();
  });
});

describe("Event", () => {
  it("EventEnvelope['kind'] 的 tag 聯集涵蓋所有 kind", () => {
    expectTypeOf<EventEnvelope["kind"]>().toEqualTypeOf<EventKindName>();
    expectTypeOf<EventKind["kind"]>().toEqualTypeOf<EventKindName>();
    expectTypeOf<(typeof EVENT_KINDS)[number]>().toEqualTypeOf<EventKindName>();
  });

  it("event frame 是 EventEnvelope 加上 dispatch_id", () => {
    expectTypeOf<Extract<RunnerToServer, { type: "event" }>>().toExtend<EventFrame>();
    expectTypeOf<EventFrame>().toExtend<EventEnvelope>();
    expectTypeOf<EventFrame["dispatch_id"]>().toEqualTypeOf<string>();
    expectTypeOf<EventEnvelope>().not.toHaveProperty("dispatch_id");
  });

  it("以 kind 縮小型別後可以取得 payload 欄位", () => {
    type ToolCallEvent = Extract<EventEnvelope, { kind: "tool_call" }>;
    expectTypeOf<ToolCallEvent["tool_call_id"]>().toEqualTypeOf<string>();
    type StatusEvent = Extract<EventEnvelope, { kind: "status_changed" }>;
    expectTypeOf<StatusEvent["status"]>().toEqualTypeOf<
      | "queued"
      | "dispatched"
      | "starting"
      | "running"
      | "awaiting_permission"
      | "rate_limited"
      | "awaiting_gate"
      | "completed"
      | "failed"
      | "canceled"
    >();
  });

  it("每一種 kind 都有 golden fixture，fixture 的 kind 也都在 EVENT_KINDS 中", () => {
    const kinds = new Set(fixtures("runner_to_server.event.").map((f) => f.kind));
    expect([...kinds].sort()).toEqual([...EVENT_KINDS].sort());
  });
});

describe("RunControl", () => {
  it("action 的聯集涵蓋所有動作", () => {
    expectTypeOf<RunControl["action"]>().toEqualTypeOf<RunControlActionName>();
    expectTypeOf<RunControlAction["action"]>().toEqualTypeOf<RunControlActionName>();
    expectTypeOf<(typeof RUN_CONTROL_ACTIONS)[number]>().toEqualTypeOf<RunControlActionName>();
  });

  it("結果以 outcome 區分", () => {
    expectTypeOf<RunControlResult["outcome"]>().toEqualTypeOf<
      "applied" | "branch_pushed" | "rejected"
    >();
  });

  it("每一種動作都有 golden fixture", () => {
    const actions = new Set(fixtures("server_to_runner.run_control.").map((f) => f.action));
    expect([...actions].sort()).toEqual([...RUN_CONTROL_ACTIONS].sort());
  });
});

describe("其他列舉的值陣列", () => {
  it("涵蓋對應型別的每一個值", () => {
    expectTypeOf<(typeof DISPATCH_REJECT_REASONS)[number]>().toEqualTypeOf<DispatchRejectReason>();
    expectTypeOf<
      (typeof RUN_CONTROL_REJECT_REASONS)[number]
    >().toEqualTypeOf<RunControlRejectReason>();
    expectTypeOf<(typeof AGENT_CAPABILITIES)[number]>().toEqualTypeOf<AgentCapability>();
    expectTypeOf<(typeof TOOL_KINDS)[number]>().toEqualTypeOf<ToolKind>();
    expectTypeOf<(typeof TOOL_CALL_STATUSES)[number]>().toEqualTypeOf<ToolCallStatus>();
    expectTypeOf<(typeof PERMISSION_OPTION_KINDS)[number]>().toEqualTypeOf<PermissionOptionKind>();
    expectTypeOf<(typeof RUN_ERROR_CODES)[number]>().toEqualTypeOf<RunErrorCode>();
  });

  it("dispatch_reject fixture 的理由都在 DISPATCH_REJECT_REASONS 中", () => {
    for (const f of fixtures("runner_to_server.dispatch_reject.")) {
      expect(DISPATCH_REJECT_REASONS).toContain(f.reason);
    }
  });

  it("agent_availability fixture 的能力旗標都在 AGENT_CAPABILITIES 中", () => {
    for (const f of fixtures("runner_to_server.agent_availability.")) {
      for (const agent of f.agents as { capabilities: string[] }[]) {
        for (const capability of agent.capabilities) {
          expect(AGENT_CAPABILITIES).toContain(capability);
        }
      }
    }
  });
});
