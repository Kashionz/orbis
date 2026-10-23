// 系統匣（Electron）。內容由 tray-model.ts 算出，這裡只負責畫出來與轉送點擊。

import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from "electron";
import type { TrayMenuId, TrayMenuItem, TrayModel, TrayTone } from "./tray-model";

const TONE_COLORS: Record<TrayTone, [number, number, number]> = {
  idle: [142, 142, 147],
  busy: [245, 159, 0],
  ok: [47, 158, 68],
  warn: [224, 49, 49],
};

const ICON_SIZE = 32;

/** 畫一個實心圓當圖示，顏色代表 Runner 狀態。用 BGRA bitmap 產生，不需要額外的圖檔。 */
function iconFor(tone: TrayTone): Electron.NativeImage {
  const [r, g, b] = TONE_COLORS[tone];
  const buffer = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  const center = (ICON_SIZE - 1) / 2;
  const radius = ICON_SIZE * 0.42;
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const distance = Math.hypot(x - center, y - center);
      // 邊緣做 1px 的反鋸齒
      const alpha = Math.max(0, Math.min(1, radius - distance + 0.5));
      const offset = (y * ICON_SIZE + x) * 4;
      buffer[offset] = Math.round(b * alpha);
      buffer[offset + 1] = Math.round(g * alpha);
      buffer[offset + 2] = Math.round(r * alpha);
      buffer[offset + 3] = Math.round(255 * alpha);
    }
  }
  return nativeImage.createFromBitmap(buffer, {
    width: ICON_SIZE,
    height: ICON_SIZE,
    scaleFactor: 2,
  });
}

export class DesktopTray {
  private readonly tray: Tray;
  private tone: TrayTone | null = null;

  constructor(
    private readonly onAction: (id: TrayMenuId) => void,
    onClick: () => void,
  ) {
    this.tray = new Tray(iconFor("idle"));
    this.tray.on("click", onClick);
  }

  render(model: TrayModel): void {
    if (this.tone !== model.tone) {
      this.tray.setImage(iconFor(model.tone));
      this.tone = model.tone;
    }
    this.tray.setToolTip(model.tooltip);
    const template = model.items.map((item) => this.toMenuItem(item));
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private toMenuItem(item: TrayMenuItem): MenuItemConstructorOptions {
    if (item.kind === "label") return { label: item.label, enabled: false };
    if (item.kind === "separator") return { type: "separator" };
    const click = () => this.onAction(item.id);
    if (item.kind === "action") return { label: item.label, enabled: item.enabled, click };
    return {
      label: item.label,
      type: "checkbox",
      checked: item.checked,
      enabled: item.enabled,
      click,
    };
  }

  destroy(): void {
    this.tray.destroy();
  }
}
