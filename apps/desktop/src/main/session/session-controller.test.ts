import type { MeResponse } from "@orbis/api-contract";
import { describe, expect, it } from "vitest";
import type { ServerApi } from "./server-api";
import { type RunnerControl, SessionController } from "./session-controller";

const member = (id: string): MeResponse => ({
  githubUserId: 1,
  githubLogin: "octo",
  name: null,
  avatarUrl: null,
  member: { id, teamId: "t1", teamName: "Team", role: "member" },
});

function setup() {
  const calls: string[] = [];
  let cookie = false;
  let me: MeResponse | null | Error = null;
  let tokens = 0;
  let pairingError: Error | null = null;
  const api: ServerApi = {
    me: async () => {
      if (me instanceof Error) throw me;
      return me;
    },
    createLocalPairingToken: async () => {
      if (pairingError) throw pairingError;
      tokens += 1;
      return { token: `pt_${tokens}`, expiresAt: null };
    },
    listNeedsYou: async () => [],
  };
  const runner: RunnerControl = {
    start: async (token) => {
      calls.push(`start:${token}`);
    },
    stop: async () => {
      calls.push("stop");
    },
    clearState: async () => {
      calls.push("clear");
    },
  };
  const controller = new SessionController({
    api,
    runner,
    hasSessionCookie: async () => cookie,
    log: () => {},
    retryDelayMs: 60_000,
    pairingLoopWindowMs: 0,
  });
  return {
    controller,
    calls,
    signIn: (value: MeResponse | null | Error) => {
      cookie = true;
      me = value;
    },
    signOut: () => {
      cookie = false;
      me = null;
    },
    failPairing: (error: Error | null) => {
      pairingError = error;
    },
  };
}

describe("SessionController", () => {
  it("沒有 session cookie 時維持 signed_out，不呼叫 sidecar", async () => {
    const { controller, calls } = setup();
    await controller.refresh();
    expect(controller.snapshot().phase).toBe("signed_out");
    expect(calls).toEqual([]);
  });

  it("登入後取得 Pairing token 並啟動 sidecar；重複的 cookie 事件不會重複 Pairing", async () => {
    const { controller, calls, signIn } = setup();
    signIn(member("m1"));
    await Promise.all([controller.refresh(), controller.refresh(), controller.refresh()]);
    expect(controller.snapshot()).toMatchObject({ phase: "paired", error: null });
    expect(calls).toEqual(["start:pt_1"]);
  });

  it("登出時停止 sidecar 並刪除本機的 Runner 狀態", async () => {
    const { controller, calls, signIn, signOut } = setup();
    signIn(member("m1"));
    await controller.refresh();
    signOut();
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ phase: "signed_out", me: null });
    expect(calls).toEqual(["start:pt_1", "stop", "clear"]);
  });

  it("cookie 還在但 /me 回 401（session 過期）也視為登出", async () => {
    const { controller, calls, signIn } = setup();
    signIn(member("m1"));
    await controller.refresh();
    signIn(null);
    await controller.refresh();
    expect(controller.snapshot().phase).toBe("signed_out");
    expect(calls).toEqual(["start:pt_1", "stop", "clear"]);
  });

  it("還不是任何 Team 的 Member 時不 Pairing", async () => {
    const { controller, calls, signIn } = setup();
    signIn({ ...member("m1"), member: null });
    await controller.refresh();
    expect(controller.snapshot().phase).toBe("no_team");
    expect(calls).toEqual([]);
  });

  it("換了另一個 Member 登入時，先解除前一個人的 Pairing 再重新 Pairing", async () => {
    const { controller, calls, signIn } = setup();
    signIn(member("m1"));
    await controller.refresh();
    signIn(member("m2"));
    await controller.refresh();
    expect(calls).toEqual(["start:pt_1", "stop", "clear", "start:pt_2"]);
    expect(controller.snapshot().me?.member?.id).toBe("m2");
  });

  it("換 Server 時先停止 sidecar、刪除本機狀態，才套用新的 URL 並重新確認登入", async () => {
    const { controller, calls, signIn } = setup();
    signIn(member("m1"));
    await controller.refresh();
    calls.length = 0;
    await controller.changeServer(() => {
      calls.push("apply");
    });
    expect(calls).toEqual(["stop", "clear", "apply", "start:pt_2"]);
    expect(controller.snapshot().phase).toBe("paired");
  });

  it("暫時連不上 Server 時顯示 error，但不重啟已經在跑的 sidecar", async () => {
    const { controller, calls, signIn } = setup();
    signIn(member("m1"));
    await controller.refresh();
    signIn(new Error("ECONNREFUSED"));
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      phase: "error",
      error: "無法確認登入狀態：ECONNREFUSED",
    });
    signIn(member("m1"));
    await controller.refresh();
    expect(controller.snapshot().phase).toBe("paired");
    expect(calls).toEqual(["start:pt_1"]);
    await controller.dispose();
  });

  it("取得 Pairing token 失敗時顯示原因，下次 refresh 再試", async () => {
    const { controller, calls, signIn, failPairing } = setup();
    signIn(member("m1"));
    failPairing(new Error("HTTP 500"));
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      phase: "error",
      error: "取得 Pairing token 失敗：HTTP 500",
    });
    failPairing(null);
    await controller.refresh();
    expect(controller.snapshot().phase).toBe("paired");
    expect(calls).toEqual(["start:pt_1"]);
  });

  it("sidecar 要求重新 Pairing 時，清掉本機狀態並以新的 token 重啟", async () => {
    const { controller, calls, signIn } = setup();
    signIn(member("m1"));
    await controller.refresh();
    await controller.runnerNeedsPairing();
    expect(calls).toEqual(["start:pt_1", "stop", "clear", "start:pt_2"]);
    expect(controller.snapshot().phase).toBe("paired");
  });

  it("新的 token 馬上又被拒絕時停止自動 Pairing", async () => {
    const { calls, signIn } = setup();
    signIn(member("m1"));
    const strict = new SessionController({
      api: {
        me: async () => member("m1"),
        createLocalPairingToken: async () => ({ token: "pt_x", expiresAt: null }),
        listNeedsYou: async () => [],
      },
      runner: {
        start: async (t) => {
          calls.push(`start:${t}`);
        },
        stop: async () => {
          calls.push("stop");
        },
        clearState: async () => {
          calls.push("clear");
        },
      },
      hasSessionCookie: async () => true,
      log: () => {},
      pairingLoopWindowMs: 60_000,
    });
    await strict.refresh();
    await strict.runnerNeedsPairing();
    expect(strict.snapshot()).toMatchObject({ phase: "error", error: "Pairing 失敗，請重新登入" });
    expect(calls).toEqual(["start:pt_x", "stop"]);
  });
});
