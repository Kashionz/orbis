// Runner 的 Pairing、重新連線與 Heartbeat 紀錄。

import type { RunnerInfo } from "@orbis/protocol";
import { asc, eq } from "drizzle-orm";
import { validate as isUuid } from "uuid";
import { constantTimeEqual, randomToken, sha256Hex } from "../crypto";
import type { Database } from "../db/client";
import { runners, teams } from "../db/schema";

export interface AuthenticatedRunner {
  id: string;
  name: string;
  teamId: string;
}

export type PairingResult =
  | { ok: true; runner: AuthenticatedRunner; runnerToken: string }
  | { ok: false; message: string };

export type ReconnectResult = { ok: true; runner: AuthenticatedRunner } | { ok: false };

/**
 * 以 Pairing token 完成 Pairing（00 階段的 stub）：token 等於 DEV_PAIRING_TOKEN 才接受，
 * Runner 綁到最早建立的 Team，種類記為 `team`。依 token 判定 Local／Team 與綁定對象留給 B1。
 */
export async function pairRunner(
  db: Database,
  params: { token: string; devPairingToken: string | null; info: RunnerInfo },
): Promise<PairingResult> {
  if (params.devPairingToken === null) {
    return { ok: false, message: "Server 未設定 Pairing token，目前不接受新的 Runner" };
  }
  if (!constantTimeEqual(params.token, params.devPairingToken)) {
    return { ok: false, message: "Pairing token 不正確" };
  }
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .orderBy(asc(teams.createdAt), asc(teams.id))
    .limit(1);
  if (!team) {
    return { ok: false, message: "還沒有任何 Team，請先以 bootstrap owner 登入 Web" };
  }

  const runnerToken = randomToken();
  const now = new Date();
  const [runner] = await db
    .insert(runners)
    .values({
      teamId: team.id,
      kind: "team",
      name: params.info.name,
      runnerVersion: params.info.runner_version,
      os: params.info.os,
      arch: params.info.arch,
      tokenHash: sha256Hex(runnerToken),
      lastConnectedAt: now,
    })
    .returning({ id: runners.id, name: runners.name, teamId: runners.teamId });
  if (!runner) throw new Error("建立 Runner 失敗");
  return { ok: true, runner, runnerToken };
}

/** 以 Runner token 重新連線，並更新 Runner 回報的資訊。 */
export async function reconnectRunner(
  db: Database,
  params: { runnerId: string; token: string; info: RunnerInfo },
): Promise<ReconnectResult> {
  if (!isUuid(params.runnerId)) return { ok: false };
  const [runner] = await db
    .select({ tokenHash: runners.tokenHash, revokedAt: runners.revokedAt })
    .from(runners)
    .where(eq(runners.id, params.runnerId))
    .limit(1);
  if (!runner || runner.revokedAt !== null) return { ok: false };
  if (!constantTimeEqual(sha256Hex(params.token), runner.tokenHash)) return { ok: false };

  const [updated] = await db
    .update(runners)
    .set({
      name: params.info.name,
      runnerVersion: params.info.runner_version,
      os: params.info.os,
      arch: params.info.arch,
      lastConnectedAt: new Date(),
    })
    .where(eq(runners.id, params.runnerId))
    .returning({ id: runners.id, name: runners.name, teamId: runners.teamId });
  return updated ? { ok: true, runner: updated } : { ok: false };
}

/** 記錄 Heartbeat：以 Server 收到的時間更新最後 Heartbeat 時間。 */
export async function recordHeartbeat(db: Database, runnerId: string, at: Date): Promise<void> {
  await db.update(runners).set({ lastHeartbeatAt: at }).where(eq(runners.id, runnerId));
}
