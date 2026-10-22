// 從 GitHub App 最近的 webhook delivery 錄製真實 payload，存成 test/fixtures/webhooks/<event>.<action>.json。
// 每種 event／action 取最新的一筆。手動驗證走過一輪之後執行：
//
//   pnpm --filter @orbis/github fixtures:record

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NAMES } from "@orbis/api-contract";
import { z } from "zod";
import { createAppJwtSigner } from "../src/auth/app-jwt";
import { GITHUB_API_URL } from "../src/client/http";
import { loadGitHubAppConfig } from "../src/config";
import { WEBHOOK_HANDLERS } from "../src/webhook/handler";
import { readEnvFile } from "./env-file";

const OUT_DIR = fileURLToPath(new URL("../test/fixtures/webhooks/", import.meta.url));

const config = loadGitHubAppConfig({ ...readEnvFile(), ...process.env });
if (!config) throw new Error("找不到 GitHub App 設定");
const signer = createAppJwtSigner({ appId: config.appId, privateKey: config.privateKey });

/** delivery id 超過 JS 的安全整數範圍，先轉成字串再解析。 */
async function getDeliveries(path: string): Promise<unknown> {
  const text = await getText(path);
  return JSON.parse(text.replace(/"id":(\d+)/g, '"id":"$1"'));
}

async function get(path: string): Promise<unknown> {
  return JSON.parse(await getText(path));
}

async function getText(path: string): Promise<string> {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${signer.token()}`,
      "user-agent": NAMES.productSlug,
    },
  });
  if (!response.ok) throw new Error(`GET ${path} 失敗：HTTP ${response.status}`);
  return response.text();
}

const Deliveries = z.array(
  z.object({
    id: z.string(),
    event: z.string(),
    action: z.string().nullable(),
    status_code: z.number(),
  }),
);
const Delivery = z.object({ request: z.object({ payload: z.record(z.string(), z.unknown()) }) });

const deliveries = Deliveries.parse(await getDeliveries("/app/hook/deliveries?per_page=100"));
const seen = new Set<string>();
for (const delivery of deliveries) {
  if (delivery.event !== "ping" && !WEBHOOK_HANDLERS[delivery.event]) continue;
  const name = delivery.action ? `${delivery.event}.${delivery.action}` : delivery.event;
  if (seen.has(name)) continue; // 列表由新到舊，只取最新的一筆
  seen.add(name);
  const detail = Delivery.parse(await get(`/app/hook/deliveries/${delivery.id}`));
  writeFileSync(`${OUT_DIR}${name}.json`, `${JSON.stringify(detail.request.payload, null, 2)}\n`);
  console.log(`已錄製 ${name}（delivery ${delivery.id}）`);
}
