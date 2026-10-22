import type * as protocol from "@orbis/protocol";
import { describe, expectTypeOf, it } from "vitest";
import type {
  AcceptanceCriterion,
  AcceptanceCriterionKind,
  NeedsYouGate,
  NeedsYouItem,
  NeedsYouKind,
  NeedsYouPermissionRequest,
  Run,
  RunEvent,
  RunUsage,
  Task,
  TaskStatus,
} from "../src/index";

/** `input_tokens` → `inputTokens` */
type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

describe("資源 schema 的型別", () => {
  it("Run 的列舉欄位與 Rust 協定一致", () => {
    expectTypeOf<Run["status"]>().toEqualTypeOf<protocol.RunStatus>();
    expectTypeOf<Run["permissionPolicy"]>().toEqualTypeOf<protocol.PermissionPolicy>();
    expectTypeOf<Run["delegationMode"]>().toEqualTypeOf<protocol.DelegationMode | null>();
    expectTypeOf<Run["runnerKind"]>().toEqualTypeOf<protocol.RunnerKind>();
  });

  it("Event 的 runId、ts 與協定的 RunId、Timestamp 相容", () => {
    expectTypeOf<RunEvent["runId"]>().toEqualTypeOf<protocol.RunId>();
    expectTypeOf<RunEvent["ts"]>().toEqualTypeOf<protocol.Timestamp>();
    expectTypeOf<RunEvent["seq"]>().toEqualTypeOf<number>();
  });

  it("Event 內容就是協定的 EventKind，可以用 kind 縮小型別", () => {
    expectTypeOf<RunEvent["event"]>().toEqualTypeOf<protocol.EventKind>();
    expectTypeOf<RunEvent["event"]["kind"]>().toEqualTypeOf<protocol.EventKindName>();
  });

  it("用量的欄位是協定 Usage 的 camelCase 版本", () => {
    expectTypeOf<keyof RunUsage>().toEqualTypeOf<CamelCase<keyof protocol.Usage>>();
  });

  it("權限請求的選項種類與協定一致", () => {
    expectTypeOf<
      NeedsYouPermissionRequest["options"][number]["kind"]
    >().toEqualTypeOf<protocol.PermissionOptionKind>();
  });

  it("Needs You 項目涵蓋每一種 NeedsYouKind，Gate 種類與協定一致", () => {
    expectTypeOf<NeedsYouItem["kind"]>().toEqualTypeOf<NeedsYouKind>();
    expectTypeOf<NeedsYouGate["gateKind"]>().toEqualTypeOf<protocol.GateKind>();
  });

  it("Task 與 Acceptance Criterion 使用共用列舉", () => {
    expectTypeOf<Task["status"]>().toEqualTypeOf<TaskStatus>();
    expectTypeOf<AcceptanceCriterion["kind"]>().toEqualTypeOf<AcceptanceCriterionKind>();
  });
});
