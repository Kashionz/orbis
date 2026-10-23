// 完整系統 e2e 的 port。設定檔在主程序與每個 worker 都會載入，第一次載入時向作業系統要兩個空的
// port，存在環境變數中，之後載入的都用同一組。

import { execFileSync } from "node:child_process";
import { envVar } from "@orbis/api-contract/names";

const SCRIPT =
  "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";

function port(suffix: string): number {
  const name = envVar(suffix);
  if (!process.env[name]) {
    process.env[name] = execFileSync(process.execPath, ["-e", SCRIPT], { encoding: "utf8" }).trim();
  }
  return Number(process.env[name]);
}

export function systemPorts(): { serverPort: number; webPort: number } {
  return { serverPort: port("SYSTEM_E2E_SERVER_PORT"), webPort: port("SYSTEM_E2E_WEB_PORT") };
}
