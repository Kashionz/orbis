import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ACCEPTANCE_CRITERION_KINDS,
  type AcceptanceCriterionKind,
  type DELEGATION_PURPOSES,
  type DelegationPurpose,
  type DispatchOffer,
  decodePreviewData,
  type EventKind,
  encodePreviewData,
  type MERGE_OUTCOMES,
  type MergeOutcome,
  type ORBIS_TOOL_ERROR_CODES,
  ORBIS_TOOLS,
  type OrbisToolCall,
  type OrbisToolErrorCode,
  type OrbisToolName,
  type OrbisToolOutput,
  type PLAN_SOURCES,
  type PlanSource,
  PREVIEW_DATA_HEADER_LEN,
  PREVIEW_DATA_KINDS,
  PREVIEW_INITIAL_WINDOW,
  PREVIEW_MAX_CHUNK,
  type PREVIEW_RESET_REASONS,
  type PREVIEW_STOP_REASONS,
  type PREVIEW_STREAM_KINDS,
  type PROMPT_SOURCES,
  PROTOCOL_VERSION,
  type PreviewResetReason,
  type PreviewStopReason,
  type PreviewStreamKind,
  type PromptSource,
  type RUN_ORIGINS,
  RUN_STATUSES,
  type RunControlAction,
  type RunOrigin,
  type VERIFICATION_KINDS,
  type VERIFICATION_OUTCOMES,
  type VerificationEvidence,
  type VerificationKind,
  type VerificationOutcome,
} from "../src/index";

const crateDir = new URL("../../../crates/orbis-protocol/tests/", import.meta.url);
const fixtureDir = new URL("fixtures/", crateDir);

function fixtures(prefix: string): Record<string, unknown>[] {
  return readdirSync(fixtureDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8")));
}

function hex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

describe("W5–7 契約：協定版本與列舉", () => {
  it("協定版本是 2", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("Run 狀態加入 verifying", () => {
    expect(RUN_STATUSES).toContain("verifying");
  });

  it("值陣列涵蓋對應型別的每一個值", () => {
    expectTypeOf<(typeof RUN_ORIGINS)[number]>().toEqualTypeOf<RunOrigin>();
    expectTypeOf<(typeof PROMPT_SOURCES)[number]>().toEqualTypeOf<PromptSource>();
    expectTypeOf<
      (typeof ACCEPTANCE_CRITERION_KINDS)[number]
    >().toEqualTypeOf<AcceptanceCriterionKind>();
    expectTypeOf<(typeof VERIFICATION_KINDS)[number]>().toEqualTypeOf<VerificationKind>();
    expectTypeOf<(typeof VERIFICATION_OUTCOMES)[number]>().toEqualTypeOf<VerificationOutcome>();
    expectTypeOf<(typeof PLAN_SOURCES)[number]>().toEqualTypeOf<PlanSource>();
    expectTypeOf<(typeof MERGE_OUTCOMES)[number]>().toEqualTypeOf<MergeOutcome>();
    expectTypeOf<(typeof PREVIEW_STOP_REASONS)[number]>().toEqualTypeOf<PreviewStopReason>();
    expectTypeOf<(typeof ORBIS_TOOLS)[number]>().toEqualTypeOf<OrbisToolName>();
    expectTypeOf<(typeof ORBIS_TOOL_ERROR_CODES)[number]>().toEqualTypeOf<OrbisToolErrorCode>();
    expectTypeOf<(typeof DELEGATION_PURPOSES)[number]>().toEqualTypeOf<DelegationPurpose>();
    expectTypeOf<(typeof PREVIEW_STREAM_KINDS)[number]>().toEqualTypeOf<PreviewStreamKind>();
    expectTypeOf<(typeof PREVIEW_RESET_REASONS)[number]>().toEqualTypeOf<PreviewResetReason>();
  });

  it("Acceptance Criterion 的類型順序與 M1 的 DB enum 相同", () => {
    expect(ACCEPTANCE_CRITERION_KINDS).toEqual(["command", "agent", "browser", "manual"]);
  });
});

describe("W5–7 契約：既有型別的新增欄位都是 optional", () => {
  it("DispatchOffer 的新欄位可以省略，M1 的 Server 程式不必修改", () => {
    type M1Fields =
      | "dispatch_id"
      | "run_id"
      | "expires_at"
      | "task"
      | "run_seq"
      | "repo"
      | "branch"
      | "agent"
      | "model"
      | "permission_policy"
      | "prompt"
      | "plan_gate"
      | "delegation"
      | "last_event_seq";
    expectTypeOf<Pick<DispatchOffer, M1Fields>>().toExtend<DispatchOffer>();
  });

  it("prompt 的 source 可以省略", () => {
    type Prompt = Extract<RunControlAction, { action: "prompt" }>;
    expectTypeOf<{ action: "prompt"; prompt: Prompt["prompt"] }>().toExtend<Prompt>();
  });
});

describe("W5–7 契約：Event 與 RunControl", () => {
  it("verification_result 帶證據與判定的 Run", () => {
    type Result = Extract<EventKind, { kind: "verification_result" }>;
    expectTypeOf<Result["outcome"]>().toEqualTypeOf<VerificationOutcome>();
    expectTypeOf<Result["evidence"]>().toEqualTypeOf<VerificationEvidence[]>();
    expectTypeOf<Result["judged_by_run_id"]>().toEqualTypeOf<string | null>();
  });

  it("verify 列出要檢查的條件", () => {
    type Verify = Extract<RunControlAction, { action: "verify" }>;
    expectTypeOf<Verify["criteria"][number]["kind"]>().toEqualTypeOf<VerificationKind>();
  });
});

describe("W5–7 契約：Orbis MCP 工具呼叫", () => {
  it("呼叫與輸出都以 tool 區分，種類一一對應", () => {
    expectTypeOf<OrbisToolCall["tool"]>().toEqualTypeOf<OrbisToolName>();
    expectTypeOf<OrbisToolOutput["tool"]>().toEqualTypeOf<OrbisToolName>();
  });

  it("每個工具都有 tool_call 與 tool_result 的 fixture", () => {
    const calls = new Set(
      fixtures("runner_to_server.tool_call.").map((f) => (f.call as { tool: string }).tool),
    );
    expect([...calls].sort()).toEqual([...ORBIS_TOOLS].sort());
    const outputs = new Set(
      fixtures("server_to_runner.tool_result.")
        .map((f) => f.result as { outcome: string; output?: { tool: string } })
        .flatMap((r) => (r.output ? [r.output.tool] : [])),
    );
    expect([...outputs].sort()).toEqual([...ORBIS_TOOLS].sort());
  });
});

describe("W5–7 契約：Preview binary 訊息", () => {
  const cases = JSON.parse(readFileSync(new URL("preview_data.json", crateDir), "utf8")) as {
    name: string;
    kind: keyof typeof PREVIEW_DATA_KINDS;
    stream_id: number;
    payload_hex: string;
    bytes_hex: string;
  }[];

  it("常數與 Rust 一致", () => {
    expect(PREVIEW_DATA_KINDS).toEqual({ body: 0, ws_text: 1, ws_binary: 2 });
    expect(PREVIEW_DATA_HEADER_LEN).toBe(5);
    expect(PREVIEW_INITIAL_WINDOW).toBe(256 * 1024);
    expect(PREVIEW_MAX_CHUNK).toBe(64 * 1024);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "%s：編碼與 Rust 的 golden bytes 相同",
    (_, c) => {
      const payload = hex(c.payload_hex);
      const bytes = encodePreviewData({ kind: c.kind, streamId: c.stream_id, payload });
      expect(Buffer.from(bytes).toString("hex")).toBe(c.bytes_hex);
      const decoded = decodePreviewData(hex(c.bytes_hex));
      expect(decoded.kind).toBe(c.kind);
      expect(decoded.streamId).toBe(c.stream_id);
      expect(Buffer.from(decoded.payload).toString("hex")).toBe(c.payload_hex);
    },
  );

  it("拒絕格式不對的訊息", () => {
    expect(() => decodePreviewData(new Uint8Array([0, 0, 0]))).toThrow();
    expect(() => decodePreviewData(new Uint8Array([9, 0, 0, 0, 1]))).toThrow();
    const big = new Uint8Array(PREVIEW_DATA_HEADER_LEN + PREVIEW_MAX_CHUNK + 1);
    expect(() => decodePreviewData(big)).toThrow();
    expect(() =>
      encodePreviewData({ kind: "body", streamId: -1, payload: new Uint8Array() }),
    ).toThrow();
  });

  it("解碼時 payload 不複製，可以解析 buffer 中間的一段", () => {
    const inner = encodePreviewData({ kind: "ws_binary", streamId: 3, payload: hex("abcd") });
    const outer = new Uint8Array(inner.byteLength + 2);
    outer.set(inner, 1);
    const decoded = decodePreviewData(outer.subarray(1, 1 + inner.byteLength));
    expect(decoded.streamId).toBe(3);
    expect(Buffer.from(decoded.payload).toString("hex")).toBe("abcd");
  });
});
