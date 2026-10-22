import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HeartbeatFrame, HelloFrame, parseFrame } from "../src/runner/frames";

/** Rust 協定的 wire format fixture，確認 Server 的驗證與 Rust 端一致。 */
const FIXTURES_DIR = fileURLToPath(
  new URL("../../../crates/orbis-protocol/tests/fixtures", import.meta.url),
);

function fixtures(prefix: string): [string, unknown][] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.startsWith(prefix))
    .map((name) => [name, JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"))]);
}

describe("Runner frame 驗證", () => {
  it.each(fixtures("runner_to_server.hello."))("接受協定 fixture %s", (_name, json) => {
    expect(HelloFrame.safeParse(json).success).toBe(true);
  });

  it.each(fixtures("runner_to_server.heartbeat"))("接受協定 fixture %s", (_name, json) => {
    expect(HeartbeatFrame.safeParse(json).success).toBe(true);
  });

  it("parseFrame 只接受帶 type 的 JSON 物件，並保留其他欄位", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame("[]")).toBeNull();
    expect(parseFrame('{"kind":"hello"}')).toBeNull();
    expect(parseFrame('{"type":"agent_availability","agents":[]}')).toEqual({
      type: "agent_availability",
      agents: [],
    });
  });

  it("拒絕缺欄位的 Hello", () => {
    expect(
      HelloFrame.safeParse({ type: "hello", protocol_version: 1, pairing: { kind: "x" } }).success,
    ).toBe(false);
  });
});
