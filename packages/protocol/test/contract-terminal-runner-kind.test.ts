import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type HelloAck,
  PROTOCOL_VERSION,
  RUNNER_KINDS,
  type RunnerKind,
  TERMINAL_EXIT_REASONS,
  type TerminalExited,
} from "../src/index";

const fixtureDir = new URL("../../../crates/orbis-protocol/tests/fixtures/", import.meta.url);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));
}

describe("終端機的 disabled 原因與 HelloAck 的 runner_kind", () => {
  it("協定版本不變（都是可以忽略的新增）", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it("終端機的結束原因多了 disabled", () => {
    expect(TERMINAL_EXIT_REASONS).toContain("disabled");
    const exited = fixture("runner_to_server.terminal_exited.disabled.json");
    expect(exited.reason).toBe("disabled");
    expectTypeOf<"disabled">().toExtend<TerminalExited["reason"]>();
  });

  it("HelloAck 的 runner_kind 是選填的 Runner 種類", () => {
    expectTypeOf<HelloAck["runner_kind"]>().toEqualTypeOf<RunnerKind | undefined>();
    expect(RUNNER_KINDS).toEqual(["local", "team"]);
    expect(fixture("server_to_runner.hello_ack.runner_kind.json").runner_kind).toBe("team");
    expect(fixture("server_to_runner.hello_ack.json")).not.toHaveProperty("runner_kind");
  });
});
