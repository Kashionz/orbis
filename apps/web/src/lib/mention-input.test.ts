import type { MentionCandidates } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  insertMention,
  mentionedAgents,
  mentionOptions,
} from "./mention-input";

const CANDIDATES: MentionCandidates = {
  members: [
    { memberId: "m-1", githubLogin: "alice", name: "Alice Chen", avatarUrl: null },
    { memberId: "m-2", githubLogin: "bob", name: null, avatarUrl: null },
  ],
  agents: [{ agent: "claude-code", label: "claude" }],
};

describe("activeMentionQuery", () => {
  it("游標前是 @ 開頭的字時回傳查詢", () => {
    expect(activeMentionQuery("請 @al", 5)).toEqual({ start: 2, query: "al" });
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("email、已經有空白，或已經插入的 token 不算", () => {
    expect(activeMentionQuery("a@b", 3)).toBeNull();
    expect(activeMentionQuery("@alice ", 7)).toBeNull();
    expect(activeMentionQuery("@[alice](member:m-1)", 20)).toBeNull();
  });
});

describe("mentionOptions", () => {
  it("Agent 在前，成員比對 login 與名稱（不分大小寫）", () => {
    expect(mentionOptions(CANDIDATES, "").map((o) => o.key)).toEqual([
      "agent:claude-code",
      "member:m-1",
      "member:m-2",
    ]);
    expect(mentionOptions(CANDIDATES, "CHEN").map((o) => o.label)).toEqual(["alice"]);
    expect(mentionOptions(CANDIDATES, "cla").map((o) => o.label)).toEqual(["claude"]);
  });
});

describe("insertMention", () => {
  it("把 @查詢 換成 token，游標移到 token 後的空白之後", () => {
    const text = "請 @al 看一下";
    const result = insertMention(text, { start: 2, query: "al" }, 5, {
      label: "alice",
      target: { type: "member", memberId: "m-1" },
    });
    expect(result.text).toBe("請 @[alice](member:m-1)  看一下");
    expect(result.caret).toBe("請 @[alice](member:m-1) ".length);
  });
});

describe("mentionedAgents", () => {
  it("只列出 Agent，去掉重複，略過程式碼中的 token", () => {
    const text =
      "@[claude](agent:claude-code) 和 @[alice](member:m-1)，`@[codex](agent:codex)`、@[claude](agent:claude-code)";
    expect(mentionedAgents(text)).toEqual(["claude-code"]);
  });
});
