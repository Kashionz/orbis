import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envVar, NAMES } from "../src/names";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("名稱常數", () => {
  it("TS 版與 Rust 版（orbis-runner --print-names）完全一致", () => {
    const stdout = execFileSync(
      "cargo",
      ["run", "--quiet", "-p", "orbis-runner", "--", "--print-names"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(JSON.parse(stdout)).toEqual(NAMES);
  }, 300_000);

  it("Worktree 環境變數都使用前綴", () => {
    for (const name of Object.values(NAMES.env)) {
      expect(name.startsWith(NAMES.envPrefix)).toBe(true);
    }
    expect(envVar("PORT")).toBe(NAMES.env.port);
  });
});
