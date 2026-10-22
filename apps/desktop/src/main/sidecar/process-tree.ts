// 強制結束整個程序樹。只在 Runner 沒有依關閉協定自行結束時使用（使用者核准的決定 D4）。
// - Windows：`taskkill /T /F`，在 Runner 還活著時才找得到它的子孫程序。
// - macOS／Linux：sidecar 以 detached 啟動、自成一個 process group，對整個 group 送 SIGKILL。
//   Runner 已經結束後也照樣送，清掉留在 group 裡的子孫程序。

import { execFile } from "node:child_process";

export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") {
    await new Promise<void>((resolve) => {
      // 程序已經結束時 taskkill 會回傳錯誤，忽略即可
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () =>
        resolve(),
      );
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** 程序是否還在。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：程序存在但沒有權限送訊號
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
