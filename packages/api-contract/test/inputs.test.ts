import { describe, expect, it } from "vitest";
import {
  CreateAcceptanceCriterionInput,
  CreateTaskInput,
  TransitionTaskInput,
  UpdateAcceptanceCriterionInput,
  UpdateTaskInput,
} from "../src/index";

describe("CreateTaskInput", () => {
  it("只給必要欄位時補上預設值", () => {
    expect(CreateTaskInput.parse({ repoId: "r1", title: "新增登入頁" })).toEqual({
      repoId: "r1",
      title: "新增登入頁",
      description: "",
      assigneeMemberId: null,
      specPath: null,
      dependsOn: [],
      planGateEnabled: null,
    });
  });

  it.each([
    ["缺少 repoId", { title: "新增登入頁" }],
    ["空白標題", { repoId: "r1", title: "  " }],
    ["超過 200 字的標題", { repoId: "r1", title: "字".repeat(201) }],
    ["由 Server 產生的 Task Key", { repoId: "r1", title: "新增登入頁", key: "ORB-1" }],
    ["由狀態機決定的狀態", { repoId: "r1", title: "新增登入頁", status: "ready" }],
  ])("拒絕%s", (_, input) => {
    expect(CreateTaskInput.safeParse(input).success).toBe(false);
  });
});

describe("UpdateTaskInput", () => {
  it("接受只改部分欄位，包含清除指派", () => {
    expect(UpdateTaskInput.safeParse({ title: "改名" }).success).toBe(true);
    expect(UpdateTaskInput.safeParse({ assigneeMemberId: null }).success).toBe(true);
  });

  it.each([
    ["空物件", {}],
    ["更換 Repo", { repoId: "r2" }],
    ["直接改狀態", { status: "done" }],
    ["空白標題", { title: "" }],
  ])("拒絕%s", (_, input) => {
    expect(UpdateTaskInput.safeParse(input).success).toBe(false);
  });
});

describe("TransitionTaskInput", () => {
  it("只接受 Task 狀態", () => {
    expect(TransitionTaskInput.safeParse({ status: "ready" }).success).toBe(true);
    expect(TransitionTaskInput.safeParse({ status: "archived" }).success).toBe(false);
  });
});

describe("CreateAcceptanceCriterionInput", () => {
  it("非 command 類型的指令預設為 null", () => {
    expect(
      CreateAcceptanceCriterionInput.parse({ kind: "manual", description: "設計稿確認" }),
    ).toEqual({ kind: "manual", description: "設計稿確認", command: null });
  });

  it("command 類型可以帶指令與位置", () => {
    const input = { kind: "command", description: "測試通過", command: "pnpm test", position: 2 };
    expect(CreateAcceptanceCriterionInput.parse(input)).toEqual(input);
  });

  it.each([
    ["非 command 類型帶指令", { kind: "agent", description: "符合 Spec", command: "pnpm test" }],
    ["不存在的類型", { kind: "unit", description: "測試通過" }],
    ["空白描述", { kind: "manual", description: "" }],
    ["由 Verification 寫入的結果", { kind: "manual", description: "確認", result: "passed" }],
  ])("拒絕%s", (_, input) => {
    expect(CreateAcceptanceCriterionInput.safeParse(input).success).toBe(false);
  });
});

describe("UpdateAcceptanceCriterionInput", () => {
  it("接受只改部分欄位", () => {
    expect(UpdateAcceptanceCriterionInput.safeParse({ description: "改寫" }).success).toBe(true);
    expect(UpdateAcceptanceCriterionInput.safeParse({ command: "pnpm lint" }).success).toBe(true);
    expect(
      UpdateAcceptanceCriterionInput.safeParse({ kind: "manual", command: null }).success,
    ).toBe(true);
  });

  it.each([
    ["空物件", {}],
    ["改成非 command 類型但沒有清除指令", { kind: "browser" }],
    ["改成非 command 類型又帶指令", { kind: "agent", command: "pnpm test" }],
    ["直接改結果", { result: "passed" }],
  ])("拒絕%s", (_, input) => {
    expect(UpdateAcceptanceCriterionInput.safeParse(input).success).toBe(false);
  });
});
