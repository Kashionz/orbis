# Orbis Server 的 image（ARCHITECTURE §16）：同時提供 API、Runner WebSocket 與 Web 的靜態檔。
# build context 是 repo 根目錄（deploy/docker-compose.yml 已設定），因為要用整個 pnpm workspace。
#
#   docker build -f apps/server/Dockerfile -t orbis-server .
#
# image 不含任何 secret：設定全部由環境變數在啟動時給（見 deploy/.env.example）。

# ── 建置：安裝 workspace、建置 Web ─────────────────────────────────────────
FROM node:24-bookworm-slim AS build
ENV CI=1 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# 依 package.json 的 packageManager 欄位使用固定版本的 pnpm
RUN corepack enable
WORKDIR /src
COPY . .
# 只安裝 Server 與 Web（含它們的 workspace 依賴），不碰 Desktop（會下載 Electron）
RUN pnpm install --frozen-lockfile --filter "@orbis/server..." --filter "@orbis/web..."
RUN pnpm --filter @orbis/web build
# 只留 Server 執行時需要的依賴（tsx 在 dependencies 中）
RUN pnpm install --prod --frozen-lockfile --filter "@orbis/server..."

# ── 執行 ───────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# 保留 workspace 的目錄結構：node_modules 中的 @orbis/* 是指向 packages/、apps/ 的 symlink
COPY --from=build /src/package.json /src/pnpm-workspace.yaml /src/tsconfig.base.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/apps/server ./apps/server
COPY --from=build /src/apps/web/dist ./apps/web/dist
# blob 的存放目錄（compose 掛 volume）
RUN mkdir -p /data/blobs && chown -R node:node /data
USER node
# 容器內的 port 固定 4000；對外的 port 由 compose 對應。
# 注意這些環境變數名稱必須和 apps/server/src/config.ts（envVar()）一致。
ENV ORBIS_SERVER_PORT=4000 \
    ORBIS_BLOB_DIR=/data/blobs \
    ORBIS_WEB_DIR=/app/apps/web/dist
EXPOSE 4000
VOLUME ["/data/blobs"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
WORKDIR /app/apps/server
# 和 `pnpm start` 相同：以 tsx 直接執行 TypeScript。migration 在啟動時自動執行（src/main.ts）。
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
