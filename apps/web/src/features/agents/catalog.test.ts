import type { DispatchOptions } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import { catalogFromDispatchOptions, catalogModel, modelDisplayName } from "./catalog";
import { defaultModelOf } from "./default-models";

describe("modelDisplayName", () => {
  it("已知模型用表中的名稱", () => {
    expect(modelDisplayName("sonnet-4.5")).toBe("Sonnet 4.5");
    expect(modelDisplayName("grok-code-fast-1")).toBe("Grok Code Fast 1");
  });

  it("不在表中的模型由 id 推導", () => {
    expect(modelDisplayName("claude-sonnet-6-0")).toBe("Sonnet 6.0");
    expect(modelDisplayName("gpt-6-codex")).toBe("GPT-6 Codex");
    expect(modelDisplayName("gemini-3-pro")).toBe("Gemini 3 Pro");
  });

  it("不在表中的模型推理強度視為可調整、沒有 tag", () => {
    expect(catalogModel("mystery-1")).toEqual({
      id: "mystery-1",
      name: "Mystery 1",
      tag: null,
      effort: "adjustable",
    });
    expect(catalogModel("grok-4").effort).toBe("none");
    expect(catalogModel("claude-haiku-5-5").effort).toBe("fixed:fast");
  });
});

describe("catalogFromDispatchOptions", () => {
  const agent = (id: string, available: boolean, models: string[]) => ({
    id,
    version: null,
    available,
    unavailableReason: available ? null : "未安裝",
    models,
    permissionGaps: [],
  });

  it("合併 Local 與 Team 的 Agent，依已知順序排列，任一邊可用就算已登入", () => {
    const options: DispatchOptions = {
      defaultPermissionPolicy: "auto",
      local: {
        online: true,
        unavailableReason: null,
        agents: [agent("codex", false, []), agent("claude-code", true, ["claude-opus-5-5"])],
      },
      team: {
        online: true,
        unavailableReason: null,
        agents: [
          agent("codex", true, ["gpt-5"]),
          agent("claude-code", true, ["claude-sonnet-5-5"]),
        ],
      },
    };
    const catalog = catalogFromDispatchOptions(options);
    expect(catalog.map((entry) => [entry.agentId, entry.tool, entry.signedIn])).toEqual([
      ["claude-code", "Claude Code", true],
      ["codex", "Codex", true],
    ]);
    expect(catalog[0]?.models.map((model) => model.name)).toEqual(["Opus 5.5", "Sonnet 5.5"]);
  });

  it("沒有任何 Runner 時目錄是空的", () => {
    expect(
      catalogFromDispatchOptions({ defaultPermissionPolicy: "auto", local: null, team: null }),
    ).toEqual([]);
  });
});

describe("defaultModelOf", () => {
  const entry = {
    agentId: "claude-code",
    tool: "Claude Code",
    vendor: "Anthropic",
    cliId: "claude",
    signedIn: true,
    models: [catalogModel("claude-opus-5-5"), catalogModel("claude-sonnet-5-5")],
  };

  it("有設定且還在目錄中時用設定的模型，否則用第一個", () => {
    expect(defaultModelOf(entry, { "claude-code": "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(defaultModelOf(entry, { "claude-code": "removed-model" })).toBe("claude-opus-5-5");
    expect(defaultModelOf(entry, {})).toBe("claude-opus-5-5");
    expect(defaultModelOf({ ...entry, models: [] }, {})).toBeNull();
  });
});
