// Server 自己的版本（package.json 的 version），由 `/api/health` 回報給 Web 與 Desktop 顯示。

import packageJson from "../package.json" with { type: "json" };

export const SERVER_VERSION: string = packageJson.version;
