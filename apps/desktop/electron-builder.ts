// electron-builder 的設定（ARCHITECTURE §16）。用 TS 而不用 yml：產品名稱、appId 與發布來源都從常數取得，
// 不在設定檔中寫死。electron-builder 以 jiti 載入這個檔案。
//
// - Windows：NSIS one-click、per-user 安裝（不需要系統管理員）。Phase 1 不簽章，SmartScreen 會警告（docs/DESKTOP.md）。
// - macOS：dmg 與 zip，arm64 與 x64 各一組；不簽章、不 notarize（使用者核准的 91 決定）。zip 是 electron-updater
//   用來比對版本的（latest-mac.yml），macOS 本身不自動安裝。
// - Runner 執行檔由 scripts/stage-runner.mjs 放到 build/runner/<os>-<arch>/，以 extraResources 打包到
//   resources/bin/（src/main/sidecar/runner-command.ts 從那裡啟動 sidecar）。
// - main 程序已由 esbuild 打包成 dist/main.mjs，不需要 node_modules。
// - 發布到 public GitHub Releases，建立成 draft；協調者確認後才 publish，Desktop 才會抓到更新。

import { NAMES } from "@orbis/api-contract/names";
import type { Configuration } from "electron-builder";
import { APP_USER_MODEL_ID } from "./src/main/names";
import { RELEASE_SOURCE } from "./src/main/update/release-source";

const config: Configuration = {
  appId: APP_USER_MODEL_ID,
  productName: NAMES.productName,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder 的檔名巨集
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "package.json", "!**/*.map"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder 的路徑巨集
  extraResources: [{ from: "build/runner/${os}-${arch}", to: "bin" }],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    shortcutName: NAMES.productName,
  },
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.developer-tools",
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
  },
  dmg: { sign: false },
  publish: {
    provider: RELEASE_SOURCE.provider,
    owner: RELEASE_SOURCE.owner,
    repo: RELEASE_SOURCE.repo,
    releaseType: "draft",
  },
};

export default config;
