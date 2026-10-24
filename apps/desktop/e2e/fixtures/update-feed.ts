// e2e 用的 fake 更新來源：electron-updater generic provider 讀的 latest.yml／latest-mac.yml，加上對應的安裝檔
// （隨機內容，sha512 與大小寫在 yml 中，Windows 的下載會驗證）。一律聽 port 0。

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NAMES } from "@orbis/api-contract/names";

export interface UpdateFeed {
  url: string;
  version: string;
  /** 收到的請求路徑，依序。 */
  requests: string[];
  close(): Promise<void>;
}

export async function startUpdateFeed(version: string): Promise<UpdateFeed> {
  const asset = randomBytes(64 * 1024);
  const sha512 = createHash("sha512").update(asset).digest("base64");
  const files: Record<string, string> = {
    "/latest.yml": `${NAMES.productName}-${version}-win-x64.exe`,
    "/latest-mac.yml": `${NAMES.productName}-${version}-mac-arm64.zip`,
  };
  const manifest = (file: string) =>
    [
      `version: ${version}`,
      "files:",
      `  - url: ${file}`,
      `    sha512: ${sha512}`,
      `    size: ${asset.length}`,
      `path: ${file}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-10-25T00:00:00.000Z'",
      "",
    ].join("\n");
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    requests.push(pathname);
    const file = files[pathname];
    if (file) {
      res.writeHead(200, { "content-type": "text/yaml" });
      return res.end(manifest(file));
    }
    if (Object.values(files).some((name) => pathname === `/${name}`)) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(asset.length),
      });
      return res.end(asset);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    version,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
