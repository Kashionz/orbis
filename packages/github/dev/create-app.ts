// 以 manifest 流程建立 GitHub App，憑證寫進 repo 根目錄的 .env。
//
//   pnpm --filter @orbis/github app:create -- --webhook-url https://smee.io/xxxx [--name "..."] [--org acme] [--port 4401]
//
// 開啟瀏覽器到印出的網址 → 按「Create GitHub App」→ 導回本機後自動換成憑證。

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { NAMES } from "@orbis/api-contract";
import { z } from "zod";
import { GITHUB_APP_ENV } from "../src/config";
import { appManifest } from "../src/manifest";
import { ENV_FILE, writeEnvValues } from "./env-file";

const { values } = parseArgs({
  options: {
    "webhook-url": { type: "string" },
    "public-url": { type: "string", default: "http://localhost:4402" },
    name: { type: "string" },
    org: { type: "string" },
    port: { type: "string", default: "4401" },
  },
});

const port = Number(values.port);
const state = randomBytes(16).toString("hex");
const redirectUrl = `http://localhost:${port}/callback`;
const manifest = appManifest({
  name: values.name ?? `${NAMES.productName} dev ${randomBytes(2).toString("hex")}`,
  publicUrl: values["public-url"],
  ...(values["webhook-url"] ? { webhookUrl: values["webhook-url"] } : {}),
  redirectUrl,
});
const createUrl = values.org
  ? `https://github.com/organizations/${encodeURIComponent(values.org)}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`;

const Conversion = z.object({
  id: z.number(),
  slug: z.string(),
  pem: z.string(),
  webhook_secret: z.string().nullable(),
  html_url: z.string(),
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>建立 GitHub App</title>
<form method="post" action="${escapeHtml(createUrl)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<p>即將在 GitHub 上建立 App「${escapeHtml(manifest.name)}」。</p>
<button type="submit">前往 GitHub 建立</button></form>`);
    return;
  }
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || !code) {
      res.writeHead(400).end("state 不符或缺少 code");
      return;
    }
    const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": NAMES.productSlug },
    });
    if (!response.ok) {
      res.writeHead(502).end(`換憑證失敗：HTTP ${response.status}`);
      return;
    }
    const app = Conversion.parse(await response.json());
    writeEnvValues({
      [GITHUB_APP_ENV.appId]: String(app.id),
      [GITHUB_APP_ENV.privateKey]: app.pem,
      [GITHUB_APP_ENV.webhookSecret]: app.webhook_secret ?? "",
      [GITHUB_APP_ENV.slug]: app.slug,
    });
    const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><p>已建立 App：<a href="${app.html_url}">${escapeHtml(app.slug)}</a>。
憑證已寫入 .env。</p><p>下一步：<a href="${installUrl}">把 App 安裝到測試 repo</a>。</p>`);
    console.log(`已建立 App ${app.slug}（id ${app.id}），憑證已寫入 ${ENV_FILE}`);
    console.log(`下一步：把 App 安裝到測試 repo → ${installUrl}`);
    server.close();
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, () => {
  console.log(`請用瀏覽器開啟 http://localhost:${port}/ 建立 GitHub App`);
  console.log(`webhook URL：${manifest.hook_attributes.url}`);
});
