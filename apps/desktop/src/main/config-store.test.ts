import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, defaultConfig } from "./config-store";

describe("ConfigStore", () => {
  const dirs: string[] = [];
  const tempPath = () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-config-"));
    dirs.push(dir);
    return join(dir, "sub", "config.json");
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("檔案不存在時用預設值，update 後寫入並可以重新讀回", () => {
    const path = tempPath();
    const store = new ConfigStore(path, "win32");
    expect(store.get()).toEqual(defaultConfig("win32"));
    expect(store.get().terminal.preset).toBe("windows-terminal");
    store.update({ serverUrl: "https://s.example", claimingPaused: true });
    expect(new ConfigStore(path, "win32").get()).toMatchObject({
      serverUrl: "https://s.example",
      claimingPaused: true,
    });
    expect(JSON.parse(readFileSync(path, "utf8")).serverUrl).toBe("https://s.example");
  });

  it("壞掉的 JSON 回到預設值", () => {
    const path = tempPath();
    new ConfigStore(path).update({ serverUrl: "https://x" });
    writeFileSync(path, "{壞掉");
    expect(new ConfigStore(path).get()).toEqual(defaultConfig());
  });

  it("逐欄容錯：未知的 preset、型別錯誤的欄位只讓那一欄回到預設值", () => {
    const path = tempPath();
    new ConfigStore(path, "linux").update({ serverUrl: "https://x" });
    writeFileSync(
      path,
      JSON.stringify({
        serverUrl: "https://x",
        claimingPaused: "yes",
        editor: { preset: "notepad", customCommand: "vim {path}" },
        terminal: { preset: "windows-terminal", customCommand: 3 },
      }),
    );
    expect(new ConfigStore(path, "linux").get()).toEqual({
      serverUrl: "https://x",
      claimingPaused: false,
      editor: { preset: "vscode", customCommand: "vim {path}" },
      terminal: { preset: "x-terminal-emulator", customCommand: "" },
    });
  });
});
