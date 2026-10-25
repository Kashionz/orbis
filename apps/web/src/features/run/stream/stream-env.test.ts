import { describe, expect, it } from "vitest";
import { agentAt, fileReference } from "./stream-env";

describe("agentAt", () => {
  const run = { agent: "codex", model: "gpt-5" };
  const change = {
    actorMemberId: "me",
    agent: null,
    model: null,
    effort: null,
    permissionPolicy: null,
    notApplied: [],
  };
  const settings = {
    initial: {
      agent: "claude-code",
      model: "claude-sonnet-5-5",
      effort: null,
      permissionPolicy: "auto" as const,
    },
    changes: [
      { ...change, seq: 10, ts: "2026-10-25T08:05:00Z", model: "claude-opus-5-5" },
      {
        ...change,
        seq: 12,
        ts: "2026-10-25T08:10:00Z",
        model: "claude-haiku-5-5",
        notApplied: ["model" as const],
      },
      { ...change, seq: 20, ts: "2026-10-25T08:20:00Z", agent: "codex", model: "gpt-5" },
    ],
  };

  it("依時間套用切換：換模型、換 Agent，沒有生效的不算", () => {
    expect(agentAt("2026-10-25T08:00:00Z", run, settings)).toEqual({
      agent: "claude-code",
      model: "claude-sonnet-5-5",
    });
    expect(agentAt("2026-10-25T08:15:00Z", run, settings)).toEqual({
      agent: "claude-code",
      model: "claude-opus-5-5",
    });
    expect(agentAt("2026-10-25T08:25:00Z", run, settings)).toEqual({
      agent: "codex",
      model: "gpt-5",
    });
  });

  it("沒有切換紀錄時用 Run 目前的值", () => {
    expect(agentAt("2026-10-25T08:00:00Z", run, null)).toEqual(run);
  });
});

describe("fileReference", () => {
  const paths = ["apps/web/src/lib/text.ts", "apps/web/src/features/run/DiffPreview.tsx"];

  it("完全符合、結尾符合或檔名符合變更的檔案", () => {
    expect(fileReference("apps/web/src/lib/text.ts", paths)).toBe("apps/web/src/lib/text.ts");
    expect(fileReference("run/DiffPreview.tsx", paths)).toBe(
      "apps/web/src/features/run/DiffPreview.tsx",
    );
    expect(fileReference("text.ts", paths)).toBe("apps/web/src/lib/text.ts");
  });

  it("像檔名但不在變更中時回傳原文；版本號、一般程式碼不是檔名", () => {
    expect(fileReference("README.md", paths)).toBe("README.md");
    expect(fileReference("1.2.3", paths)).toBeNull();
    expect(fileReference("normalizeEol", paths)).toBeNull();
    expect(fileReference("autocrlf = true", paths)).toBeNull();
  });
});
