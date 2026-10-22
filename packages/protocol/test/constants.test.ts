import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DELEGATION_MODES,
  type DelegationMode,
  type GATE_DECISIONS,
  type GATE_KINDS,
  type GateDecision,
  type GateKind,
  type PERMISSION_POLICIES,
  type PermissionPolicy,
  PROTOCOL_VERSION,
  RUN_STATUSES,
  type RUNNER_KINDS,
  type RunnerKind,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
} from "../src/index";

describe("產生的列舉值陣列", () => {
  it("涵蓋對應型別的每一個值", () => {
    expectTypeOf<(typeof RUN_STATUSES)[number]>().toEqualTypeOf<RunStatus>();
    expectTypeOf<(typeof PERMISSION_POLICIES)[number]>().toEqualTypeOf<PermissionPolicy>();
    expectTypeOf<(typeof DELEGATION_MODES)[number]>().toEqualTypeOf<DelegationMode>();
    expectTypeOf<(typeof RUNNER_KINDS)[number]>().toEqualTypeOf<RunnerKind>();
    expectTypeOf<(typeof GATE_KINDS)[number]>().toEqualTypeOf<GateKind>();
    expectTypeOf<(typeof GATE_DECISIONS)[number]>().toEqualTypeOf<GateDecision>();
  });

  it("終止狀態是 Run 狀態的子集合", () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(RUN_STATUSES).toContain(status);
    }
  });

  it("協定版本是正整數", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
