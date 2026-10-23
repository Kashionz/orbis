import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type EventKind,
  type FILE_CHANGES,
  type FileChange,
  type Heartbeat,
  type PERMISSION_PURPOSES,
  type PermissionPurpose,
  RUNNER_BLOB_PATH,
  type SIDECAR_CONNECTION_STATES,
  SIDECAR_EXIT_NEEDS_PAIRING,
  SIDECAR_EXIT_VERSION_MISMATCH,
  SIDECAR_FLAG,
  type SidecarCommand,
  type SidecarConnectionState,
  type SidecarOutput,
} from "../src/index";

describe("W2–4 契約：協定新增的型別", () => {
  it("值陣列涵蓋對應型別的每一個值", () => {
    expectTypeOf<(typeof PERMISSION_PURPOSES)[number]>().toEqualTypeOf<PermissionPurpose>();
    expectTypeOf<(typeof FILE_CHANGES)[number]>().toEqualTypeOf<FileChange>();
    expectTypeOf<
      (typeof SIDECAR_CONNECTION_STATES)[number]
    >().toEqualTypeOf<SidecarConnectionState>();
  });

  it("權限請求帶 purpose，run_diff 帶每個檔案的新舊內容", () => {
    type PermissionRequest = Extract<EventKind, { kind: "permission_request" }>;
    expectTypeOf<PermissionRequest["purpose"]>().toEqualTypeOf<PermissionPurpose>();

    type RunDiffEvent = Extract<EventKind, { kind: "run_diff" }>;
    type DiffFile = RunDiffEvent["files"][number];
    expectTypeOf<DiffFile["change"]>().toEqualTypeOf<FileChange>();
    expectTypeOf<DiffFile["binary"]>().toEqualTypeOf<boolean>();
  });

  it("Heartbeat 回報是否接受新的 Dispatch", () => {
    expectTypeOf<Heartbeat["accepting_dispatches"]>().toEqualTypeOf<boolean>();
  });

  it("sidecar 的輸出與指令都以 type 區分", () => {
    expectTypeOf<SidecarOutput["type"]>().toEqualTypeOf<"status">();
    expectTypeOf<SidecarCommand["type"]>().toEqualTypeOf<
      "pause_claiming" | "resume_claiming" | "shutdown"
    >();
  });

  it("常數", () => {
    expect(RUNNER_BLOB_PATH.startsWith("/api/")).toBe(true);
    expect(SIDECAR_FLAG).toBe("--sidecar");
    expect(SIDECAR_EXIT_NEEDS_PAIRING).toBe(78);
    expect(SIDECAR_EXIT_VERSION_MISMATCH).toBe(76);
  });
});
