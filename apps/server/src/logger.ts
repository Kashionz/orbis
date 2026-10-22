// 結構化 log（pino）。開發時以 pino-pretty 輸出易讀格式。

import { type DestinationStream, type Logger, pino } from "pino";

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  /** 測試用：把 log 寫到指定的 stream（JSON 格式），此時忽略 pretty。 */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  if (options.destination) {
    return pino({ level: options.level }, options.destination);
  }
  if (options.pretty) {
    return pino({
      level: options.level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
      },
    });
  }
  return pino({ level: options.level });
}
