import { describe, expect, it } from "vitest";
import { agentAt, fileReference } from "./stream-env";

describe("agentAt", () => {
  const run = { agent: "codex", model: "gpt-5" };
  const settings = {
    initial: { agent: "claude-code", model: "sonnet-4.5" },
    changes: [
      {
        ts: "2026-10-25T08:10:00Z",
        memberId: "me",
        kind: "effort" as const,
        agent: null,
        model: null,
        effort: "deep" as const,
        permissionPolicy: null,
      },
      {
        ts: "2026-10-25T08:20:00Z",
        memberId: "me",
        kind: "model" as const,
        agent: "codex",
        model: "gpt-5",
        effort: null,
        permissionPolicy: null,
      },
    ],
  };

  it("切換之前用派工時的 Agent，之後用切換後的", () => {
    expect(agentAt("2026-10-25T08:15:00Z", run, settings)).toEqual({
      agent: "claude-code",
      model: "sonnet-4.5",
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
