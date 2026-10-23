// 設定的讀取，以及 App manifest 與實際處理的 webhook 一致。

import { describe, expect, it } from "vitest";
import { GITHUB_APP_ENV, GitHubAppConfigError, loadGitHubAppConfig } from "../src/config";
import { ALWAYS_DELIVERED_EVENTS, APP_EVENTS, appManifest } from "../src/manifest";
import { WEBHOOK_HANDLERS } from "../src/webhook/handler";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY-----";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    [GITHUB_APP_ENV.appId]: "123456",
    [GITHUB_APP_ENV.privateKey]: PEM,
    [GITHUB_APP_ENV.webhookSecret]: "s3cret",
    [GITHUB_APP_ENV.slug]: "acme-pm",
    ...overrides,
  };
}

describe("loadGitHubAppConfig", () => {
  it("變數名稱都以環境變數前綴開頭", () => {
    expect(Object.values(GITHUB_APP_ENV)).toEqual([
      "ORBIS_GITHUB_APP_ID", // names-check: allow
      "ORBIS_GITHUB_APP_PRIVATE_KEY", // names-check: allow
      "ORBIS_GITHUB_WEBHOOK_SECRET", // names-check: allow
      "ORBIS_GITHUB_APP_SLUG", // names-check: allow
    ]);
  });

  it("讀取設定，private key 的 \\n 跳脫還原成換行", () => {
    expect(loadGitHubAppConfig(env())).toEqual({
      appId: 123456,
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      webhookSecret: "s3cret",
      slug: "acme-pm",
    });
  });

  it("四個變數都沒設定時回傳 null（GitHub 整合停用）", () => {
    expect(loadGitHubAppConfig({})).toBeNull();
    expect(loadGitHubAppConfig({ [GITHUB_APP_ENV.appId]: "  " })).toBeNull();
  });

  it("只設定一部分或格式錯誤時，列出每個有問題的變數", () => {
    const error = (() => {
      try {
        loadGitHubAppConfig(
          env({
            [GITHUB_APP_ENV.appId]: "abc",
            [GITHUB_APP_ENV.privateKey]: "not a key",
            [GITHUB_APP_ENV.webhookSecret]: undefined,
          }),
        );
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(GitHubAppConfigError);
    const problems = (error as GitHubAppConfigError).problems.join("\n");
    expect(problems).toContain(GITHUB_APP_ENV.appId);
    expect(problems).toContain(GITHUB_APP_ENV.privateKey);
    expect(problems).toContain(GITHUB_APP_ENV.webhookSecret);
    expect(problems).not.toContain(GITHUB_APP_ENV.slug);
  });
});

describe("App manifest", () => {
  it("每個有處理的 webhook 事件都有訂閱（或是 App 一律會收到的事件）", () => {
    const subscribed = new Set<string>([...APP_EVENTS, ...ALWAYS_DELIVERED_EVENTS]);
    for (const event of Object.keys(WEBHOOK_HANDLERS)) {
      expect(subscribed.has(event), event).toBe(true);
    }
  });

  it("組出 webhook 與 redirect 網址", () => {
    const manifest = appManifest({
      publicUrl: "https://pm.example.com/",
      redirectUrl: "http://localhost:4401/callback",
    });
    expect(manifest.hook_attributes.url).toBe("https://pm.example.com/api/webhooks/github");
    expect(manifest.redirect_url).toBe("http://localhost:4401/callback");
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toMatchObject({
      issues: "write",
      pull_requests: "write",
      contents: "write",
      metadata: "read",
    });
    expect(
      appManifest({
        publicUrl: "https://a.test",
        webhookUrl: "https://smee.io/x",
        redirectUrl: "r",
      }).hook_attributes.url,
    ).toBe("https://smee.io/x");
  });
});
