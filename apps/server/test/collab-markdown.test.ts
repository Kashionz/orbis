// 共同編輯文件（TipTap 的 Y.XmlFragment）與 markdown 的互轉。

import { COLLAB_FRAGMENT } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  fragmentToMarkdown,
  isSafeHref,
  markdownToDocUpdate,
  replaceFragmentWithMarkdown,
} from "../src/collab/markdown";

const fragmentOf = (markdown: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, markdownToDocUpdate(markdown));
  return doc.getXmlFragment(COLLAB_FRAGMENT);
};

const roundTrip = (markdown: string) => fragmentToMarkdown(fragmentOf(markdown));

describe("markdown → 文件 → markdown", () => {
  it.each([
    ["段落", "第一段\n\n第二段"],
    ["標題", "# 標題一\n\n### 標題三"],
    [
      "粗體、斜體、刪除線、行內程式碼、連結",
      "有 **粗體**、*斜體*、~~刪除~~、`code` 與 [連結](https://example.com)",
    ],
    ["項目清單與巢狀清單", "- 第一項\n- 第二項\n  - 子項目"],
    ["編號清單（自訂起始值）", "3. 三\n4. 四"],
    ["引言", "> 引用的文字\n>\n> 第二段"],
    ["程式碼區塊", "```ts\nconst a = 1;\nconst b = 2;\n```"],
    ["分隔線", "上\n\n---\n\n下"],
    [
      "mention",
      "請 @[Alice](member:7f1c2e2a-1111-4222-8333-944445555666) 看一下，@[claude](agent:claude-code) 也是",
    ],
  ])("%s", (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("mention 轉成 mention 節點（id 與 label）", () => {
    const fragment = fragmentOf("嗨 @[claude](agent:claude-code)");
    const paragraph = fragment.get(0) as Y.XmlElement;
    const mention = paragraph
      .toArray()
      .find(
        (node): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === "mention",
      );
    expect(mention?.getAttribute("id")).toBe("agent:claude-code");
    expect(mention?.getAttribute("label")).toBe("claude");
  });

  it("只保留 http、https、mailto 與相對路徑的連結，其他 scheme 只留文字", () => {
    expect(roundTrip("[a](https://x.dev) [b](mailto:a@b.c) [c](./docs/spec.md)")).toBe(
      "[a](https://x.dev) [b](mailto:a@b.c) [c](./docs/spec.md)",
    );
    expect(roundTrip("[點我](javascript:alert(1)) 與 [資料](data:text/html,x)")).toBe(
      "點我 與 資料",
    );
    // client 直接寫進文件的危險連結，轉成 markdown 時也只留文字。
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    doc.getXmlFragment(COLLAB_FRAGMENT).insert(0, [paragraph]);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, "x", { link: { href: "JavaScript:alert(1)" } });
    expect(fragmentToMarkdown(doc.getXmlFragment(COLLAB_FRAGMENT))).toBe("x");
  });

  it("scheme 照瀏覽器的方式判斷：夾帶 tab、控制字元或括號的 href 不收", () => {
    for (const href of ["java\tscript:alert(1)", "\u0001javascript:x", "https://a.dev/(x)", ""]) {
      expect(isSafeHref(href)).toBe(false);
    }
    expect(isSafeHref("/tasks/ORB-1")).toBe(true);
    expect(isSafeHref("#heading")).toBe(true);
  });

  it("文字跳脫：不能組出連結、HTML 或跳出行內程式碼", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    const paragraph = new Y.XmlElement("paragraph");
    fragment.insert(0, [paragraph]);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, "x](javascript:alert(1)", { link: { href: "https://ok.dev" } });
    text.insert(text.length, " <img src=x onerror=alert(1)> ", {});
    text.insert(text.length, "a`b", { code: {} });
    const markdown = fragmentToMarkdown(fragment);
    expect(markdown).toBe(
      "[x\\](javascript:alert(1)](https://ok.dev) \\<img src=x onerror=alert(1)\\> ``a`b``",
    );
    // 轉回文件後文字內容不變。
    const restored = fragmentOf(markdown).get(0) as Y.XmlElement;
    expect((restored.get(0) as Y.XmlText).toString()).toContain("x](javascript:alert(1)");
  });

  it("程式碼區塊的內容含有 ``` 時用更長的 fence", () => {
    expect(roundTrip("````\n```\ninner\n```\n````")).toBe("````\n```\ninner\n```\n````");
  });

  it("不支援的區塊（表格）保留原文", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(roundTrip(table)).toBe(table);
  });

  it("空字串得到空文件", () => {
    expect(fragmentOf("").length).toBe(0);
    expect(roundTrip("")).toBe("");
  });
});

describe("TipTap 編輯後的文件 → markdown", () => {
  it("y-prosemirror 的結構：段落中的文字與 mark、hardBreak、mention", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    const paragraph = new Y.XmlElement("paragraph");
    fragment.insert(0, [paragraph]);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, "一般");
    text.insert(2, "粗體", { bold: {} });
    text.insert(4, "連結", { link: { href: "https://orbis.dev" } });
    const br = new Y.XmlElement("hardBreak");
    paragraph.insert(1, [br]);
    const mention = new Y.XmlElement("mention");
    paragraph.insert(2, [mention]);
    mention.setAttribute("id", "member:7f1c2e2a-1111-4222-8333-944445555666");
    mention.setAttribute("label", "Bob");
    expect(fragmentToMarkdown(fragment)).toBe(
      "一般**粗體**[連結](https://orbis.dev)\\\n@[Bob](member:7f1c2e2a-1111-4222-8333-944445555666)",
    );
  });

  it("replaceFragmentWithMarkdown 在同一個 transaction 中取代全部內容", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    replaceFragmentWithMarkdown(fragment, "舊的內容");
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    replaceFragmentWithMarkdown(fragment, "# 新的\n\n內容");
    expect(transactions).toBe(1);
    expect(fragmentToMarkdown(fragment)).toBe("# 新的\n\n內容");
  });
});
