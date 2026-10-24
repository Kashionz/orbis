import { describe, expect, it } from "vitest";
import { type Box, clamp, nearestIndex, placeMenu, placeTooltip, stepValue } from "./geometry";

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const viewport = { width: 1200, height: 800 };

describe("placeMenu", () => {
  it("下方空間較大時往下開，top 在 anchor 下方 6px", () => {
    const placement = placeMenu({
      anchor: box(100, 100, 120, 28),
      viewport,
      estimatedHeight: 200,
      width: 220,
    });
    expect(placement).toMatchObject({ up: false, top: 134, bottom: null, left: 100 });
    expect(placement.maxHeight).toBe(800 - 128 - 20);
  });

  it("anchor 靠近底部時翻到上方", () => {
    const placement = placeMenu({
      anchor: box(100, 700, 120, 28),
      viewport,
      estimatedHeight: 300,
      width: 220,
    });
    expect(placement).toMatchObject({ up: true, top: null, bottom: 800 - 700 + 6 });
  });

  it("偏好往上但上方放不下而下方比較大時，翻到下方", () => {
    const placement = placeMenu({
      anchor: box(100, 120, 120, 28),
      viewport,
      estimatedHeight: 300,
      width: 220,
      prefer: "up",
    });
    expect(placement.up).toBe(false);
  });

  it("偏好往下但下方放不下而上方比較大時，翻到上方", () => {
    const placement = placeMenu({
      anchor: box(100, 600, 120, 28),
      viewport,
      estimatedHeight: 300,
      width: 220,
      prefer: "down",
    });
    expect(placement.up).toBe(true);
  });

  it("不超出視窗左右，可以對齊 anchor 右緣", () => {
    expect(
      placeMenu({ anchor: box(1150, 100, 40, 28), viewport, estimatedHeight: 100, width: 220 })
        .left,
    ).toBe(1200 - 220 - 8);
    expect(
      placeMenu({
        anchor: box(500, 100, 100, 28),
        viewport,
        estimatedHeight: 100,
        width: 220,
        align: "end",
      }).left,
    ).toBe(380);
  });

  it("可用高度至少 160px", () => {
    const placement = placeMenu({
      anchor: box(100, 60, 120, 700),
      viewport,
      estimatedHeight: 400,
      width: 220,
    });
    expect(placement.maxHeight).toBe(160);
  });
});

describe("placeTooltip", () => {
  it("放在上方置中，間隔 8px", () => {
    expect(placeTooltip(box(100, 100, 40, 20), { width: 60, height: 28 }, viewport)).toEqual({
      left: 90,
      top: 64,
      up: true,
    });
  });

  it("上方放不下時翻到下方", () => {
    expect(placeTooltip(box(100, 10, 40, 20), { width: 60, height: 28 }, viewport)).toEqual({
      left: 90,
      top: 38,
      up: false,
    });
  });

  it("左右夾在視窗內", () => {
    expect(placeTooltip(box(0, 100, 10, 20), { width: 100, height: 28 }, viewport).left).toBe(8);
  });
});

describe("nearestIndex", () => {
  const items = [box(0, 0, 100, 28), box(0, 29, 100, 28), box(0, 58, 100, 28)];

  it("沿 y 軸找最近的項目（間隙也算）", () => {
    expect(nearestIndex(items, { x: 50, y: 28.5 }, "y")).toBe(0);
    expect(nearestIndex(items, { x: 500, y: 70 }, "y")).toBe(2);
  });

  it("沒有項目時回 -1", () => {
    expect(nearestIndex([], { x: 0, y: 0 }, "y")).toBe(-1);
  });
});

describe("clamp 與 stepValue", () => {
  it("夾在範圍內", () => {
    expect(clamp(400, 200, 360)).toBe(360);
    expect(clamp(100, 200, 360)).toBe(200);
  });

  it("方向鍵每次 ±2%，不超過 26%–62%", () => {
    expect(stepValue(0.42, 0.02, 0.26, 0.62)).toBe(0.44);
    expect(stepValue(0.61, 0.02, 0.26, 0.62)).toBe(0.62);
    expect(stepValue(0.27, -0.02, 0.26, 0.62)).toBe(0.26);
  });
});
