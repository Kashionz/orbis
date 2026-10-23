// 組裝 HTTP API、Runner 與 Web 的 WebSocket、背景工作，並開始 listen。main.ts 與測試共用。

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { createApp } from "./app";
import type { GitHubOAuth } from "./auth/github-oauth";
import { attachCollabEndpoint, type CollabEndpoint } from "./collab/endpoint";
import { type CollabStore, MemoryCollabStore } from "./collab/store";
import type { Config } from "./config";
import type { Database } from "./db/client";
import type { Logger } from "./logger";
import { createPreviewHost } from "./preview/host";
import { PreviewRelayService } from "./preview/relay";
import { attachRunnerEndpoint, type RunnerEndpoint } from "./runner/endpoint";
import { createServices, type Services, type ServicesOptions } from "./services";
import { attachWebEndpoint, type WebEndpoint } from "./web/ws";
import { UpgradeRouter } from "./ws-upgrade";

export interface ServerDeps {
  config: Pick<
    Config,
    | "port"
    | "publicUrl"
    | "bootstrapOwnerGithubUserId"
    | "devPairingToken"
    | "runnerHeartbeatIntervalMs"
  > &
    Partial<Pick<Config, "blobDir" | "apiOrigin" | "previewDomain">>;
  db: Database;
  logger: Logger;
  githubOAuth: GitHubOAuth;
  /** 未提供時以 config、db、logger 建立預設的服務。 */
  services?: Services;
  /** GitHub 整合（main.ts 依 GitHub App 的環境變數提供）。 */
  github?: ServicesOptions["github"];
  /** 測試用：縮短等待 Hello 的時間。 */
  helloTimeoutMs?: number;
  /** 測試用：Web 即時推送重新檢查權限的間隔。 */
  webAuthzRecheckMs?: number;
  /** 派工檢查的間隔；設為 0 時不啟動定期檢查（測試自行呼叫 dispatcher.kick()）。 */
  dispatcherIntervalMs?: number;
  /** 共同編輯文件的快照儲存。TODO(contract): 契約 v2 合併後預設改用 Postgres。 */
  collabStore?: CollabStore;
  /** 測試用：共同編輯重新檢查權限的間隔與寫回的 debounce。 */
  collabAuthzRecheckMs?: number;
  collabPersistDebounceMs?: number;
}

export interface RunningServer {
  /** 實際 listen 的 port（config.port 為 0 時由系統分配）。 */
  port: number;
  services: Services;
  runnerEndpoint: RunnerEndpoint;
  webEndpoint: WebEndpoint;
  collabEndpoint: CollabEndpoint;
  close(): Promise<void>;
}

export async function startServer(deps: ServerDeps): Promise<RunningServer> {
  const services =
    deps.services ??
    createServices({
      db: deps.db,
      logger: deps.logger,
      heartbeatIntervalMs: deps.config.runnerHeartbeatIntervalMs,
      blobDir: deps.config.blobDir,
      publicUrl: deps.config.publicUrl,
      previewDomain: deps.config.previewDomain,
      ...(deps.github && { github: deps.github }),
    });
  const app = createApp({ ...deps, services });
  // Preview 網址（`<run-id>.<Preview 網域>`）的請求依 Host 分流給 E 軌的 src/preview/，其他照常交給 API
  const previewRelay = new PreviewRelayService({
    db: deps.db,
    hub: services.hub,
    logger: deps.logger,
    scheme: services.preview.domain?.scheme ?? "http",
  });
  const previewHost = createPreviewHost({
    domain: services.preview.domain,
    publicUrl: services.preview.publicUrl,
    auth: services.preview.auth,
    relay: previewRelay,
  });
  const server = createAdaptorServer({
    fetch: (request: Request, env: unknown) => {
      const runId = previewHost.runIdFor(request.headers.get("host") ?? undefined);
      return runId ? previewHost.fetch(runId, request) : app.fetch(request, env);
    },
  }) as Server;
  const router = new UpgradeRouter(server);
  router.registerHost(
    (host) => previewHost.runIdFor(host) !== null,
    (request, socket, head) => {
      const runId = previewHost.runIdFor(request.headers.host);
      if (runId) void previewHost.upgrade(runId, request, socket, head);
    },
  );
  const runnerEndpoint = attachRunnerEndpoint(router, {
    db: deps.db,
    logger: deps.logger,
    clock: services.clock,
    hub: services.hub,
    dispatcher: services.dispatcher,
    ingest: services.ingest,
    runControls: services.runControls,
    devPairingToken: deps.config.devPairingToken,
    heartbeatIntervalMs: services.heartbeatIntervalMs,
    helloTimeoutMs: deps.helloTimeoutMs,
    preview: previewRelay,
  });
  const webEndpoint = attachWebEndpoint(router, services, {
    publicUrl: deps.config.publicUrl,
    authzRecheckMs: deps.webAuthzRecheckMs,
  });
  const collabEndpoint = attachCollabEndpoint(router, services, {
    publicUrl: deps.config.publicUrl,
    store: deps.collabStore ?? new MemoryCollabStore(),
    authzRecheckMs: deps.collabAuthzRecheckMs,
    persistDebounceMs: deps.collabPersistDebounceMs,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.config.port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const intervalMs = deps.dispatcherIntervalMs ?? 1000;
  if (intervalMs > 0) {
    services.dispatcher.start(intervalMs);
    services.blobCleanup.start();
    services.sessionCleanup.start();
  }

  return {
    port,
    services,
    runnerEndpoint,
    webEndpoint,
    collabEndpoint,
    close: async () => {
      services.dispatcher.stop();
      services.blobCleanup.stop();
      services.sessionCleanup.stop();
      await services.dispatcher.idle();
      await services.githubIdle();
      router.close();
      await runnerEndpoint.close();
      await webEndpoint.close();
      await collabEndpoint.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
