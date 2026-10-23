// @mention（ARCHITECTURE §12.3）：解析 Task 留言、Spec、diff 行內留言中的 @member 與 @agent。

import { describe, expect, it } from "vitest";
import { formatMention, parseMentions, replaceMentions } from "../src/mentions/parse";

const ALICE = "7f1c2e2a-1111-4222-8333-944445555666";
const BOB = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";

describe("mention 的解析", () => {
  it("解析 @member 與 @agent，依出現順序、同一個對象只算一次", () => {
    const text = `@[Alice](member:${ALICE}) 請看，@[claude](agent:claude-code) 也幫忙；再找一次 @[A](member:${ALICE.toUpperCase()}) 與 @[Bob](member:${BOB})`;
    expect(parseMentions(text)).toEqual([
      { target: { kind: "member", memberId: ALICE }, label: "Alice" },
      { target: { kind: "agent", agent: "claude-code" }, label: "claude" },
      { target: { kind: "member", memberId: BOB }, label: "Bob" },
    ]);
  });

  it("程式碼區塊與行內程式碼中的 token 不算", () => {
    const text = [
      "`@[Alice](member:" + ALICE + ")`",
      "```",
      `@[Bob](member:${BOB})`,
      "```",
      "@[claude](agent:claude-code)",
    ].join("\n");
    expect(parseMentions(text).map((m) => m.label)).toEqual(["claude"]);
  });

  it("沒有 token 格式的 @login 與格式錯誤的 id 不算", () => {
    expect(parseMentions("@alice 請看 @[x](member:not-a-uuid) @[y](team:abc)")).toEqual([]);
  });

  it("formatMention 產生的 token 可以被解析回來", () => {
    const token = formatMention({ kind: "member", memberId: ALICE }, "Al]ice\n");
    expect(token).toBe(`@[Alice](member:${ALICE})`);
    expect(parseMentions(token)).toEqual([
      { target: { kind: "member", memberId: ALICE }, label: "Alice" },
    ]);
  });

  it("replaceMentions：換成其他文字，程式碼中的保留原樣，回傳 null 時只留顯示名稱", () => {
    const text = `嗨 @[Alice](member:${ALICE}) 與 @[Bob](member:${BOB})，\`@[Alice](member:${ALICE})\``;
    const replaced = replaceMentions(text, (m) =>
      m.target.kind === "member" && m.target.memberId === ALICE ? "@alice-gh" : null,
    );
    expect(replaced).toBe(`嗨 @alice-gh 與 Bob，\`@[Alice](member:${ALICE})\``);
  });
});
