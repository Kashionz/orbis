import type { AgentCatalogEntry } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { findModel, modelDisplayName } from "./catalog";
import { defaultModelOf } from "./default-models";

const model = (id: string, name: string) => ({
  id,
  name,
  tag: null,
  effort: { kind: "adjustable" as const },
  source: "profile" as const,
});

const entry: AgentCatalogEntry = {
  agentId: "claude-code",
  tool: "Claude Code",
  vendor: "Anthropic",
  cliId: "claude",
  signedIn: true,
  loginHint: null,
  models: [model("claude-opus-5-5", "Opus 5.5"), model("claude-sonnet-5-5", "Sonnet 5.5")],
};

describe("modelDisplayName", () => {
  it("目錄中有的模型用目錄的名稱", () => {
    expect(modelDisplayName("claude-sonnet-5-5", [entry])).toBe("Sonnet 5.5");
  });

  it("目錄中沒有的模型由 id 推導", () => {
    expect(modelDisplayName("claude-sonnet-6-0")).toBe("Sonnet 6.0");
    expect(modelDisplayName("gpt-6-codex")).toBe("GPT-6 Codex");
    expect(modelDisplayName("gemini-3-pro")).toBe("Gemini 3 Pro");
    expect(modelDisplayName("claude-sonnet-6-0", [entry])).toBe("Sonnet 6.0");
  });
});

describe("findModel", () => {
  it("依 Agent 與 model id 找到目錄中的模型，找不到時為 null", () => {
    expect(findModel([entry], "claude-code", "claude-opus-5-5")?.name).toBe("Opus 5.5");
    expect(findModel([entry], "codex", "claude-opus-5-5")).toBeNull();
    expect(findModel([entry], "claude-code", "removed")).toBeNull();
  });
});

describe("defaultModelOf", () => {
  it("有設定且還在目錄中時用設定的模型，否則用第一個", () => {
    expect(defaultModelOf(entry, { "claude-code": "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(defaultModelOf(entry, { "claude-code": "removed-model" })).toBe("claude-opus-5-5");
    expect(defaultModelOf(entry, {})).toBe("claude-opus-5-5");
    expect(defaultModelOf({ ...entry, models: [] }, {})).toBeNull();
  });
});
