# Team Runner 的 image（ARCHITECTURE §16）：在伺服器容器中執行的 orbis-runner，領取 Team 佇列的 Run。
# build context 是 repo 根目錄（deploy/docker-compose.yml 已設定）。
#
#   docker build -f crates/runner/Dockerfile -t orbis-runner .
#
# image 不含任何 Credential：Pairing token、GitHub token 與 Agent 的 Credential 都以 Docker secret
# 在啟動時掛進 /run/secrets，由 docker-entrypoint.sh 讀進程序的環境變數（ADR-0007）。

# ── 建置：編譯 orbis-runner ───────────────────────────────────────────────────
FROM rust:1.97.1-bookworm AS build
# 小主機與多個 worker 共用的開發機都吃緊，預設限制平行編譯數；需要時以 --build-arg 調高。
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
# 只用 rustls，不需要 OpenSSL；--locked 確保和 Cargo.lock 一致
RUN cargo build --release --locked -p orbis-runner

# ── 執行 ───────────────────────────────────────────────────────────────────
# Claude Code 與 Codex 的 ACP adapter 由 Runner 在第一次派工時以 npm 安裝到狀態目錄，需要 node ≥ 22（§7）。
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*
# 以非 root 使用者執行；家目錄下的 .orbis 是 Runner 的本機目錄（runner.toml、狀態、Worktree）。
# 先建好目錄並設定擁有者：新的 named volume 會沿用 image 中這個目錄的擁有者，否則掛進來是 root 的，Runner 寫不進去。
RUN useradd --create-home --uid 10001 --shell /bin/sh orbis \
  && mkdir -p /home/orbis/.orbis && chown orbis:orbis /home/orbis/.orbis
COPY --from=build /src/target/release/orbis-runner /usr/local/bin/orbis-runner
COPY --chmod=755 crates/runner/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Windows 上 checkout 可能是 CRLF，shell 讀不懂結尾的 CR，統一成 LF
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh
USER orbis
WORKDIR /home/orbis
# Runner 的本機目錄（compose 掛 volume）：Runner token、port 分配、Event 暫存、Worktree（~/.orbis/wt）
VOLUME ["/home/orbis/.orbis"]
ENTRYPOINT ["docker-entrypoint.sh"]
