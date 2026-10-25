// 原型中有、但後端還沒有的功能（共同決定第 4 點）。mock 模式全部開啟（MSW 提供完整行為）；
// 真實模式關閉，UI 停用入口並以 Tooltip 顯示「尚未開放」，不假裝成功。
// 每一項在用到的地方標 `TODO(backend, <代號>)`，後端完成後把這裡改成 true 再移除旗標。

import { mockConfig } from "../mocks/config";

export const FEATURE_NAMES = [
  /** Task 層級的成員與角色、一般存取設定（分享卡）。 */
  "taskSharing",
  /** 以 Email 邀請還不是 Member 的人。 */
  "taskInvites",
  /** 模型目錄 API（tag、推理強度、vendor、是否已登入）。 */
  "modelCatalog",
  /** 代理重新登入（設定→代理）。 */
  "agentRelogin",
  /** Runner 的 Windows 長路徑開關（設定→執行器）。 */
  "runnerLongPaths",
  /** 桌面通知總開關（設定→通知）。 */
  "desktopNotifyToggle",
  /** 不指定 Repo 建立 Task（新增任務的「尚未指定」）。 */
  "taskWithoutRepo",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

const IS_MOCK = import.meta.env.MODE === "mock";

/** 這個功能目前可不可以用。mock 模式可以用 `window.__MOCK_CONFIG__.features` 個別關閉（e2e 測停用狀態）。 */
export function isFeatureEnabled(name: FeatureName): boolean {
  if (!IS_MOCK) return false;
  return mockConfig().features?.[name] ?? true;
}
