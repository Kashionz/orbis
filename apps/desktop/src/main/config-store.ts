// Desktop 的本機設定，存成 userData 下的 JSON 檔。寫入時先寫暫存檔再 rename，避免寫到一半當掉留下壞檔。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  defaultEditor,
  defaultTerminal,
  EDITOR_PRESETS,
  type ToolChoice,
  terminalPresets,
} from "./local-tools/presets";

export interface DesktopConfig {
  /** Web UI 的 origin，例如 `https://orbis.example.com`；第一次啟動前為 null。 */
  serverUrl: string | null;
  /** 系統匣的「暫停領取新 Run」，重啟後保留（使用者核准的決定 D6）。 */
  claimingPaused: boolean;
  /** sidecar 最後一次回報的 Runner ID，登出時用來撤銷這台 Local Runner；從來沒有連上過時為 null。 */
  runnerId: string | null;
  editor: ToolChoice;
  terminal: ToolChoice;
}

export function defaultConfig(platform: NodeJS.Platform = process.platform): DesktopConfig {
  return {
    serverUrl: null,
    claimingPaused: false,
    runnerId: null,
    editor: defaultEditor(),
    terminal: defaultTerminal(platform),
  };
}

function toolChoice(presets: readonly { id: string }[], fallback: ToolChoice) {
  const ids = presets.map((p) => p.id);
  return z
    .object({
      preset: z
        .string()
        .refine((id) => ids.includes(id))
        .catch(fallback.preset),
      customCommand: z.string().catch(""),
    })
    .catch(fallback);
}

/** 讀取時逐欄容錯：某一欄壞掉只會讓那一欄回到預設值。 */
function configSchema(platform: NodeJS.Platform) {
  const defaults = defaultConfig(platform);
  return z.object({
    serverUrl: z.string().nullable().catch(null),
    claimingPaused: z.boolean().catch(false),
    runnerId: z.string().min(1).nullable().catch(null),
    editor: toolChoice(EDITOR_PRESETS, defaults.editor),
    terminal: toolChoice(terminalPresets(platform), defaults.terminal),
  });
}

export class ConfigStore {
  private current: DesktopConfig;

  constructor(
    readonly path: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.current = this.load();
  }

  get(): DesktopConfig {
    return this.current;
  }

  update(patch: Partial<DesktopConfig>): DesktopConfig {
    this.current = configSchema(this.platform).parse({ ...this.current, ...patch });
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.current, null, 2)}\n`);
    renameSync(temp, this.path);
    return this.current;
  }

  private load(): DesktopConfig {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      // 檔案不存在或不是合法的 JSON：用預設值，第一次 update() 時覆寫
      return defaultConfig(this.platform);
    }
    const parsed = configSchema(this.platform).safeParse(raw);
    return parsed.success ? parsed.data : defaultConfig(this.platform);
  }
}
