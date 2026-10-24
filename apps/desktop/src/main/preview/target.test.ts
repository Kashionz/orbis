import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  decidePreviewNavigation,
  type PreviewState,
  type PreviewTarget,
  parsePreviewBounds,
  parseRunId,
  previewCommentUrl,
  resolvePreviewTarget,
} from "./target";

const RUN = "0192f0c4-7a1b-7c3d-8e9f-0a1b2c3d4e5f";
const SERVER = "https://team.example.com";

function ready(overrides: Partial<PreviewState> = {}): PreviewState {
  return {
    status: "ready",
    runnerId: "runner-local",
    port: 41234,
    localUrl: "http://localhost:41234/",
    shareUrl: `https://${RUN}.preview.example.com/`,
    stopped: null,
    ...overrides,
  };
}

function opened(target: PreviewTarget) {
  if (target.mode === "unavailable") throw new Error(target.message);
  return target;
}

describe("resolvePreviewTarget", () => {
  it("這台 Desktop 的 Local Runner 跑的 Run 直接開 localhost", () => {
    const target = opened(
      resolvePreviewTarget({ runId: RUN, state: ready(), localRunnerId: "runner-local" }),
    );
    expect(target.mode).toBe("local");
    expect(target.url).toBe("http://localhost:41234/");
    expect(target.origins).toEqual([
      "http://localhost:41234",
      "http://127.0.0.1:41234",
      "http://[::1]:41234",
    ]);
  });

  it("別人的 Run 開 Preview 網址", () => {
    const target = opened(
      resolvePreviewTarget({ runId: RUN, state: ready(), localRunnerId: "runner-other" }),
    );
    expect(target.mode).toBe("share");
    expect(target.url).toBe(`https://${RUN}.preview.example.com/`);
    expect(target.origins).toEqual([`https://${RUN}.preview.example.com`]);
  });

  it("本機網址不是 loopback 或 port 不符時不開本機，改開 Preview 網址", () => {
    for (const localUrl of [
      "http://evil.example.com:41234/",
      "http://localhost:9999/",
      "file:///C:/x",
      "https://localhost:41234/",
    ]) {
      const target = opened(
        resolvePreviewTarget({
          runId: RUN,
          state: ready({ localUrl }),
          localRunnerId: "runner-local",
        }),
      );
      expect(target.mode, localUrl).toBe("share");
    }
  });

  it("Preview 網址不是這個 Run 的子網域時不開", () => {
    for (const shareUrl of [
      "https://evil.example.com/",
      "javascript:alert(1)",
      `https://x${RUN}.preview.example.com/`,
    ]) {
      const target = resolvePreviewTarget({
        runId: RUN,
        state: ready({ shareUrl }),
        localRunnerId: null,
      });
      expect(target.mode, shareUrl).toBe("unavailable");
    }
  });

  it("沒有 Preview 網域時，別人的 Run 無法開啟並說明原因", () => {
    const target = resolvePreviewTarget({
      runId: RUN,
      state: ready({ shareUrl: null }),
      localRunnerId: "runner-other",
    });
    expect(target).toEqual({
      mode: "unavailable",
      message: "Server 沒有設定 Preview 網域，只能在執行這個 Run 的電腦上開啟 Preview",
    });
  });

  it("還沒就緒時不開", () => {
    for (const status of ["not_configured", "starting", "stopped"] as const) {
      const target = resolvePreviewTarget({
        runId: RUN,
        state: ready({ status }),
        localRunnerId: "runner-local",
      });
      expect(target.mode, status).toBe("unavailable");
    }
  });
});

describe("previewCommentUrl", () => {
  const share = `https://${RUN}.preview.example.com`;

  it("本機 Run：localhost 的網址換成這個 Run 的 Preview 網址，路徑、查詢字串與 hash 保留", () => {
    const local = opened(
      resolvePreviewTarget({ runId: RUN, state: ready(), localRunnerId: "runner-local" }),
    );
    expect(local.commentOrigin).toBe(share);
    expect(previewCommentUrl("http://localhost:41234/settings?tab=a#b", local)).toBe(
      `${share}/settings?tab=a#b`,
    );
    expect(previewCommentUrl("http://127.0.0.1:41234/", local)).toBe(`${share}/`);
    // 不是這個 Preview 的網址（例如用外部瀏覽器開的連結）原樣回傳
    expect(previewCommentUrl("https://docs.example.com/x", local)).toBe(
      "https://docs.example.com/x",
    );
  });

  it("別人的 Run：已經是 Preview 網址，原樣回傳", () => {
    const target = opened(
      resolvePreviewTarget({ runId: RUN, state: ready(), localRunnerId: "runner-other" }),
    );
    expect(target.commentOrigin).toBe(share);
    expect(previewCommentUrl(`${share}/a`, target)).toBe(`${share}/a`);
  });

  it("Server 沒有設定 Preview 網域時沒有可以換的網址，原樣回傳 localhost", () => {
    const local = opened(
      resolvePreviewTarget({
        runId: RUN,
        state: ready({ shareUrl: null }),
        localRunnerId: "runner-local",
      }),
    );
    expect(local.commentOrigin).toBeNull();
    expect(previewCommentUrl("http://localhost:41234/", local)).toBe("http://localhost:41234/");
  });
});

describe("decidePreviewNavigation", () => {
  const share = opened(resolvePreviewTarget({ runId: RUN, state: ready(), localRunnerId: null }));
  const local = opened(
    resolvePreviewTarget({ runId: RUN, state: ready(), localRunnerId: "runner-local" }),
  );

  it("同一個 Preview 的網址留在內嵌瀏覽器", () => {
    expect(decidePreviewNavigation(`https://${RUN}.preview.example.com/a?b=1`, share, SERVER)).toBe(
      "allow",
    );
    expect(decidePreviewNavigation("http://127.0.0.1:41234/x", local, SERVER)).toBe("allow");
  });

  it("換票時經過這個 Run 的 authorize（交給 main 程序）", () => {
    expect(
      decidePreviewNavigation(`${SERVER}/api/preview/${RUN}/authorize?return=%2F`, share, SERVER),
    ).toBe("authorize");
    // 其他 Run 的 authorize、Web UI 的其他頁面都不在內嵌瀏覽器中開
    expect(decidePreviewNavigation(`${SERVER}/api/preview/other/authorize`, share, SERVER)).toBe(
      "external",
    );
    expect(decidePreviewNavigation(`${SERVER}/tasks`, share, SERVER)).toBe("external");
    expect(decidePreviewNavigation(`${SERVER}/api/preview/${RUN}/authorize`, local, SERVER)).toBe(
      "external",
    );
  });

  it("其他網站用外部瀏覽器，其他 scheme 擋下", () => {
    expect(decidePreviewNavigation("http://localhost:41235/", local, SERVER)).toBe("external");
    expect(decidePreviewNavigation("https://example.com/", share, SERVER)).toBe("external");
    expect(decidePreviewNavigation("file:///etc/passwd", local, SERVER)).toBe("deny");
    expect(decidePreviewNavigation("not a url", local, SERVER)).toBe("deny");
  });
});

describe("Web UI 傳來的參數", () => {
  it("位置必須是合理的數字", () => {
    expect(parsePreviewBounds({ x: 10, y: 20.5, width: 800, height: 600 })).toEqual({
      x: 10,
      y: 20.5,
      width: 800,
      height: 600,
    });
    expect(parsePreviewBounds({ x: 0, y: 0, width: -1, height: 1 })).toBeNull();
    expect(parsePreviewBounds({ x: 0, y: 0, width: Number.NaN, height: 1 })).toBeNull();
    expect(parsePreviewBounds({ x: "0", y: 0, width: 1, height: 1 })).toBeNull();
    expect(parsePreviewBounds(null)).toBeNull();
  });

  it("Run ID 只能是識別字", () => {
    expect(parseRunId(RUN)).toBe(RUN);
    expect(parseRunId("../x")).toBeNull();
    expect(parseRunId("")).toBeNull();
    expect(parseRunId(1)).toBeNull();
  });
});

describe("createRateLimiter", () => {
  it("間隔內只允許一次", () => {
    let t = 0;
    const allow = createRateLimiter(3000, () => t);
    expect(allow()).toBe(true);
    t = 2999;
    expect(allow()).toBe(false);
    t = 3000;
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
  });
});
