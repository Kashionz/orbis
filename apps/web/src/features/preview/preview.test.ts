import { describe, expect, it } from "vitest";
import { type PreviewState, unavailableMessage } from "./preview-api";
import { cropToElement } from "./screenshot";

describe("cropToElement", () => {
  it("依擷取影像與 viewport 的比例換算（例如 devicePixelRatio 2）", () => {
    expect(
      cropToElement(
        { left: 100, top: 50, width: 400, height: 300 },
        { width: 1000, height: 800 },
        { width: 2000, height: 1600 },
      ),
    ).toEqual({ x: 200, y: 100, width: 800, height: 600 });
  });

  it("超出畫面的部分裁掉；完全在畫面外時回傳 null", () => {
    expect(
      cropToElement(
        { left: -50, top: 700, width: 200, height: 300 },
        { width: 1000, height: 800 },
        { width: 1000, height: 800 },
      ),
    ).toEqual({ x: 0, y: 700, width: 150, height: 100 });
    expect(
      cropToElement(
        { left: 0, top: 900, width: 100, height: 100 },
        { width: 1000, height: 800 },
        { width: 1000, height: 800 },
      ),
    ).toBeNull();
  });
});

describe("unavailableMessage", () => {
  const ready: PreviewState = {
    status: "ready",
    runnerId: "r",
    port: 41000,
    localUrl: "http://localhost:41000/",
    shareUrl: "https://x.preview.example.com/",
  };

  it("就緒而且有 Preview 網址時可以開啟", () => {
    expect(unavailableMessage(ready, false)).toBeNull();
  });

  it("沒有 Preview 網域時，瀏覽器版本無法開啟；Desktop 交給 Desktop 判斷", () => {
    const noDomain = { ...ready, shareUrl: null };
    expect(unavailableMessage(noDomain, false)).toContain("沒有設定 Preview 網域");
    expect(unavailableMessage(noDomain, true)).toBeNull();
  });

  it("還沒就緒時說明原因", () => {
    expect(unavailableMessage({ ...ready, status: "starting" }, true)).toBe("Preview 啟動中…");
    expect(unavailableMessage({ ...ready, status: "stopped" }, false)).toBe("Preview 已停止");
  });
});
