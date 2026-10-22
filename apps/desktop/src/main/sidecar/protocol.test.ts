import { describe, expect, it } from "vitest";
import { encodeSidecarCommand, parseSidecarLine } from "./protocol";

describe("sidecar 協定", () => {
  it("解析狀態行", () => {
    expect(
      parseSidecarLine(
        '{"type":"status","state":"connected","runner_id":"r1","active_runs":2,"claiming_paused":true}',
      ),
    ).toEqual({
      type: "status",
      state: "connected",
      runner_id: "r1",
      active_runs: 2,
      claiming_paused: true,
    });
  });

  it("容錯：未知欄位忽略、缺少的欄位用預設值、未知的 state 視為 offline", () => {
    expect(parseSidecarLine('{"type":"status","state":"warming_up","extra":1}')).toEqual({
      type: "status",
      state: "offline",
      runner_id: null,
      active_runs: 0,
      claiming_paused: false,
    });
    expect(parseSidecarLine('{"type":"status","state":"connecting","active_runs":-1}')).toEqual(
      expect.objectContaining({ active_runs: 0 }),
    );
  });

  it("不是狀態 JSON 的行回傳 null", () => {
    expect(parseSidecarLine("INFO 連線到 Server")).toBeNull();
    expect(parseSidecarLine("{壞掉的 json")).toBeNull();
    expect(parseSidecarLine('{"type":"other"}')).toBeNull();
    expect(parseSidecarLine("")).toBeNull();
  });

  it("指令編碼成一行 JSON", () => {
    expect(encodeSidecarCommand({ type: "pause_claiming" })).toBe('{"type":"pause_claiming"}\n');
  });
});
