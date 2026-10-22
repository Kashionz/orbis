// 每一份錄製的 webhook payload 都能被對應的 schema 解析（GitHub 改了格式時這裡會先壞）。

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEBHOOK_HANDLERS } from "../src/webhook/handler";
import { fixture } from "./helpers/world";

const names = readdirSync(fileURLToPath(new URL("./fixtures/webhooks/", import.meta.url)))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

describe("錄製的 webhook payload", () => {
  it("涵蓋每一種處理的事件", () => {
    const events = new Set(names.map((n) => n.split(".")[0]));
    for (const event of Object.keys(WEBHOOK_HANDLERS)) expect(events.has(event), event).toBe(true);
  });

  for (const name of names.filter((n) => n !== "ping")) {
    it(`${name} 符合 schema`, () => {
      const event = name.split(".")[0] ?? "";
      const handler = WEBHOOK_HANDLERS[event];
      expect(handler, event).toBeDefined();
      const result = handler?.schema.safeParse(fixture(name));
      expect(result?.success, JSON.stringify(result?.error?.issues)).toBe(true);
    });
  }
});
