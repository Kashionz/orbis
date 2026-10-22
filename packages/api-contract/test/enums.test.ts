import type * as protocol from "@orbis/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DelegationMode,
  type GateDecision,
  type GateKind,
  type PermissionPolicy,
  type RunnerKind,
  RunStatus,
  TaskStatus,
} from "../src/enums";

describe("共用列舉", () => {
  it("與 Rust 協定產生的型別一致", () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<protocol.RunStatus>();
    expectTypeOf<PermissionPolicy>().toEqualTypeOf<protocol.PermissionPolicy>();
    expectTypeOf<DelegationMode>().toEqualTypeOf<protocol.DelegationMode>();
    expectTypeOf<RunnerKind>().toEqualTypeOf<protocol.RunnerKind>();
    expectTypeOf<GateKind>().toEqualTypeOf<protocol.GateKind>();
    expectTypeOf<GateDecision>().toEqualTypeOf<protocol.GateDecision>();
  });

  it("拒絕不存在的值", () => {
    expect(RunStatus.safeParse("running").success).toBe(true);
    expect(RunStatus.safeParse("paused").success).toBe(false);
    expect(TaskStatus.safeParse("canceled").success).toBe(false);
  });
});
