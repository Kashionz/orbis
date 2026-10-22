// 組裝 HTTP API 與 Runner WebSocket，並開始 listen。main.ts 與測試共用。

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { createApp } from "./app";
import type { GitHubOAuth } from "./auth/github-oauth";
import type { Config } from "./config";
import type { Database } from "./db/client";
import type { Logger } from "./logger";
import { attachRunnerEndpoint, type RunnerEndpoint } from "./runner/endpoint";

export interface ServerDeps {
  config: Pick<
    Config,
    | "port"
    | "publicUrl"
    | "bootstrapOwnerGithubUserId"
    | "devPairingToken"
    | "runnerHeartbeatIntervalMs"
  >;
  db: Database;
  logger: Logger;
  githubOAuth: GitHubOAuth;
  /** 測試用：縮短等待 Hello 的時間。 */
  helloTimeoutMs?: number;
}

export interface RunningServer {
  /** 實際 listen 的 port（config.port 為 0 時由系統分配）。 */
  port: number;
  runnerEndpoint: RunnerEndpoint;
  close(): Promise<void>;
}

export async function startServer(deps: ServerDeps): Promise<RunningServer> {
  const app = createApp(deps);
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const runnerEndpoint = attachRunnerEndpoint(server, {
    db: deps.db,
    logger: deps.logger,
    devPairingToken: deps.config.devPairingToken,
    heartbeatIntervalMs: deps.config.runnerHeartbeatIntervalMs,
    helloTimeoutMs: deps.helloTimeoutMs,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.config.port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    port,
    runnerEndpoint,
    close: async () => {
      await runnerEndpoint.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
