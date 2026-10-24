#!/bin/sh
# Team Runner 容器的進入點：把 Docker secret（/run/secrets/<名稱>）讀進環境變數後啟動 orbis-runner。
#
# - Credential 只存在容器的程序環境與 tmpfs（/dev/shm），不寫進 image、volume 或 compose 的 environment
#   （ADR-0007）。Runner 啟動的 Agent 子程序會繼承這些環境變數。
# - 每個 secret 都是選填：檔案不存在或是空的就略過。
# - 環境變數名稱必須和 Runner（crates/orbis-protocol/src/names.rs）與各 Agent CLI 一致，shell 中無法引用
#   名稱常數，所以寫在這裡；改名時要一起改。
set -eu

SECRETS_DIR="${ORBIS_SECRETS_DIR:-/run/secrets}"

# 讀 secret 檔的內容（去掉結尾的換行與 CR）；沒有檔案時輸出空字串。
read_secret() {
  file="$SECRETS_DIR/$1"
  if [ -f "$file" ]; then
    tr -d '\r\n' < "$file"
  fi
}

# 把 secret 匯出成環境變數：export_secret <secret 名稱> <環境變數>
export_secret() {
  value="$(read_secret "$1")"
  if [ -n "$value" ]; then
    export "$2=$value"
  fi
}

# Pairing token：只在第一次連線時需要；Runner 完成 Pairing 後把 Runner token 存在 volume 中，之後會忽略它。
export_secret pairing_token ORBIS_PAIRING_TOKEN

# Agent 的 Credential：一個 KEY=VALUE 格式的檔案（例如 CLAUDE_CODE_OAUTH_TOKEN=...、OPENAI_API_KEY=...），
# 逐行匯出。只接受看起來像環境變數名稱的行，其他（註解、空行）略過。
agent_credentials="$SECRETS_DIR/agent_credentials"
if [ -s "$agent_credentials" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(printf '%s' "$line" | tr -d '\r')"
    case "$line" in
      [A-Za-z_]*=*)
        key="${line%%=*}"
        value="${line#*=}"
        if printf '%s' "$key" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
          export "$key=$value"
        fi
        ;;
    esac
  done < "$agent_credentials"
fi

# Codex 以 ChatGPT 帳號登入時的 auth.json（`codex login` 產生的 ~/.codex/auth.json）。
codex_auth="$SECRETS_DIR/codex_auth_json"
if [ -s "$codex_auth" ]; then
  codex_home="${CODEX_HOME:-$HOME/.codex}"
  mkdir -p "$codex_home"
  cp "$codex_auth" "$codex_home/auth.json"
  chmod 600 "$codex_home/auth.json"
fi

# git push 用的 GitHub token（fine-grained PAT 或機器帳號；Phase 1 的做法，§11）：寫到 tmpfs 的 credential
# store，不落到 volume。clone URL 是 https://github.com/...，git 會以 x-access-token 帶上這個 token。
github_token="$(read_secret github_token)"
if [ -n "$github_token" ]; then
  cred_dir="/dev/shm"
  [ -d "$cred_dir" ] && [ -w "$cred_dir" ] || cred_dir="$(mktemp -d)"
  cred_file="$cred_dir/orbis-git-credentials"
  umask 077
  printf 'https://x-access-token:%s@github.com\n' "$github_token" > "$cred_file"
  umask 022
  git config --global credential.helper "store --file=$cred_file"
fi
# 無人值守：不要跳出互動式的憑證提示（Runner 也會自己設定，這裡是雙保險）
export GIT_TERMINAL_PROMPT=0
# Runner 自動 commit 時的作者（compose 的 ORBIS_GIT_USER_NAME／ORBIS_GIT_USER_EMAIL）；已設定過的不改
git config --global --get user.name > /dev/null \
  || git config --global user.name "${ORBIS_GIT_USER_NAME:-Team Runner}"
git config --global --get user.email > /dev/null \
  || git config --global user.email "${ORBIS_GIT_USER_EMAIL:-team-runner@localhost}"

exec orbis-runner "$@"
