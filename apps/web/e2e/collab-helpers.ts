// 共同編輯 e2e 的共用操作（mock 與完整系統共用）。

import { expect, type Locator } from "@playwright/test";

/**
 * 把游標放到編輯器最後一段的結尾：點那一段右側的空白處，並確認瀏覽器的選取真的在那裡
 * （負載高時點擊或 Ctrl+End 偶爾沒有移動游標，直接輸入會打在文件開頭）。
 */
export async function placeCaretAtEnd(editor: Locator): Promise<void> {
  const last = editor.locator(":scope > *").last();
  await expect(async () => {
    const box = await last.boundingBox();
    if (!box) throw new Error("找不到最後一段");
    await last.click({ position: { x: box.width - 2, y: box.height / 2 } });
    const atEnd = await last.evaluate((element) => {
      const selection = window.getSelection();
      if (!selection?.isCollapsed || !selection.focusNode) return false;
      if (!element.contains(selection.focusNode)) return false;
      const range = document.createRange();
      range.selectNodeContents(element);
      range.setStart(selection.focusNode, selection.focusOffset);
      // 游標之後只剩其他人的游標標籤（不是文件內容）也算在結尾
      const rest = range.cloneContents();
      for (const caret of rest.querySelectorAll(".collaboration-carets__caret")) caret.remove();
      return (rest.textContent ?? "") === "";
    });
    expect(atEnd).toBe(true);
  }).toPass({ timeout: 10_000 });
}
