// 登出（ARCHITECTURE §16、§16.1）：在 Desktop 中先呼叫 bridge 的 beforeLogout()，
// 由 Desktop 撤銷這台 Local Runner 後才送出登出；使用者取消時不登出。

import { type DesktopBridge, getDesktopBridge } from "@orbis/desktop/bridge";
import { logoutRequest } from "../../api/resources";

/** 登出。回傳 false 表示使用者在 Desktop 的確認中取消，沒有登出。 */
export async function logout(
  bridge: DesktopBridge | null = getDesktopBridge(),
  send: () => Promise<void> = logoutRequest,
): Promise<boolean> {
  if (bridge) {
    const { proceed } = await bridge.beforeLogout();
    if (!proceed) return false;
  }
  await send();
  return true;
}
