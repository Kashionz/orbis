import { describe, expect, it } from "vitest";
import { headerLayout } from "./header-layout";

describe("headerLayout", () => {
  it("中文：620 以下藏頭像與中止的文字，480 以下分享只留圖示", () => {
    expect(headerLayout(1000, "zh-TW")).toEqual({
      wide: true,
      shareLabel: true,
      titleMinWidth: 80,
      gap: 12,
    });
    expect(headerLayout(619, "zh-TW")).toMatchObject({ wide: false, shareLabel: true });
    expect(headerLayout(479, "zh-TW")).toMatchObject({ wide: false, shareLabel: false });
  });

  it("英文的門檻比較寬", () => {
    expect(headerLayout(650, "en")).toMatchObject({ wide: false, shareLabel: true });
    expect(headerLayout(530, "en")).toMatchObject({ shareLabel: false });
  });

  it("440 以下縮小標題的最小寬度與間距；還沒量到寬度時當成夠寬", () => {
    expect(headerLayout(439, "en")).toMatchObject({ titleMinWidth: 24, gap: 8 });
    expect(headerLayout(null, "zh-TW")).toMatchObject({ wide: true, titleMinWidth: 80 });
  });
});
