// Runner 的 Pairing、重新連線、Heartbeat 與 AgentAvailability 紀錄。

import type { RunnerKind } from "@orbis/api-contract";
import type { AgentAvailability, RunnerInfo } from "@orbis/protocol";
import { DEFAULT_MAX_CONCURRENT_RUNS } from "@orbis/protocol";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { validate as isUuid } from "uuid";
import { constantTimeEqual, randomToken, sha256Hex } from "../crypto";
import type { Database } from "../db/client";
import { agentAvailabilities, runnerPairingTokens, runners, teams } from "../db/schema";

export interface AuthenticatedRunner {
  id: string;
  name: string;
  teamId: string;
  kind: RunnerKind;
  memberId: string | null;
}

export type PairingResult =
  | { ok: true; runner: AuthenticatedRunner; runnerToken: string }
  | { ok: false; message: string };

export type ReconnectResult = { ok: true; runner: AuthenticatedRunner } | { ok: false };

/** Pairing token 的有效期限：Local Runner 由 Electron 登入後立刻使用，Team Runner 由 Admin 手動設定。 */
export const PAIRING_TOKEN_TTL_MS: Record<RunnerKind, number> = {
  local: 10 * 60 * 1000,
  team: 24 * 60 * 60 * 1000,
};

const RUNNER_COLUMNS = {
  id: runners.id,
  name: runners.name,
  teamId: runners.teamId,
  kind: runners.kind,
  memberId: runners.memberId,
};

/** 產生一次性的 Pairing token。Local Runner 綁定 memberId，Team Runner 綁定 Team。 */
export async function createPairingToken(
  db: Database,
  params: {
    teamId: string;
    kind: RunnerKind;
    createdByMemberId: string;
    /** 建立 token 的 session；Pairing 時複製到 runners.paired_session_id（只用於 Local Runner）。 */
    createdBySessionId: string | null;
    now: Date;
  },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(params.now.getTime() + PAIRING_TOKEN_TTL_MS[params.kind]);
  const [row] = await db
    .insert(runnerPairingTokens)
    .values({
      teamId: params.teamId,
      kind: params.kind,
      memberId: params.kind === "local" ? params.createdByMemberId : null,
      tokenHash: sha256Hex(token),
      createdByMemberId: params.createdByMemberId,
      createdBySessionId: params.kind === "local" ? params.createdBySessionId : null,
      expiresAt,
    })
    .returning({ id: runnerPairingTokens.id });
  if (!row) throw new Error("建立 Pairing token 失敗");
  return { id: row.id, token, expiresAt };
}

/**
 * 以 Pairing token 完成 Pairing：
 * 1. 先找 UI 產生的一次性 token（未使用、未撤銷、未過期），依 token 的種類建立 Local／Team Runner。
 * 2. 找不到時，若等於開發用的 DEV_PAIRING_TOKEN，沿用 00 階段的 stub：綁到最早建立的 Team，
 *    種類為 `team`。只供本機開發（`pnpm dev:runner`）使用。
 */
export async function pairRunner(
  db: Database,
  params: { token: string; devPairingToken: string | null; info: RunnerInfo; now: Date },
): Promise<PairingResult & { viaDevToken?: boolean }> {
  const runnerToken = randomToken();
  const runnerValues = {
    name: params.info.name,
    runnerVersion: params.info.runner_version,
    os: params.info.os,
    arch: params.info.arch,
    tokenHash: sha256Hex(runnerToken),
    lastConnectedAt: params.now,
  };

  const paired = await db.transaction(async (tx) => {
    const [pairing] = await tx
      .update(runnerPairingTokens)
      .set({ usedAt: params.now })
      .where(
        and(
          eq(runnerPairingTokens.tokenHash, sha256Hex(params.token)),
          isNull(runnerPairingTokens.usedAt),
          isNull(runnerPairingTokens.revokedAt),
          or(isNull(runnerPairingTokens.expiresAt), gt(runnerPairingTokens.expiresAt, params.now)),
        ),
      )
      .returning();
    if (!pairing) return null;
    const [runner] = await tx
      .insert(runners)
      .values({
        ...runnerValues,
        teamId: pairing.teamId,
        kind: pairing.kind,
        memberId: pairing.memberId,
        // 登出或 session 過期時，Server 依此撤銷這台 Local Runner（ARCHITECTURE §16）。
        pairedSessionId: pairing.kind === "local" ? pairing.createdBySessionId : null,
      })
      .returning(RUNNER_COLUMNS);
    if (!runner) throw new Error("建立 Runner 失敗");
    await tx
      .update(runnerPairingTokens)
      .set({ usedByRunnerId: runner.id })
      .where(eq(runnerPairingTokens.id, pairing.id));
    return runner;
  });
  if (paired) return { ok: true, runner: paired, runnerToken };

  if (params.devPairingToken === null || !constantTimeEqual(params.token, params.devPairingToken)) {
    return { ok: false, message: "Pairing token 不正確、已使用或已過期" };
  }
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .orderBy(asc(teams.createdAt), asc(teams.id))
    .limit(1);
  if (!team) {
    return { ok: false, message: "還沒有任何 Team，請先以 bootstrap owner 登入 Web" };
  }
  const [runner] = await db
    .insert(runners)
    .values({ ...runnerValues, teamId: team.id, kind: "team" })
    .returning(RUNNER_COLUMNS);
  if (!runner) throw new Error("建立 Runner 失敗");
  return { ok: true, runner, runnerToken, viaDevToken: true };
}

/** 以 Runner token 重新連線，並更新 Runner 回報的資訊。 */
export async function reconnectRunner(
  db: Database,
  params: { runnerId: string; token: string; info: RunnerInfo; now: Date },
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
      lastConnectedAt: params.now,
    })
    .where(eq(runners.id, params.runnerId))
    .returning(RUNNER_COLUMNS);
  return updated ? { ok: true, runner: updated } : { ok: false };
}

/** 以 Runner token 找出 Runner（blob 上傳等 HTTP 端點使用）。 */
export async function findRunnerByToken(
  db: Database,
  token: string,
): Promise<AuthenticatedRunner | null> {
  const [runner] = await db
    .select(RUNNER_COLUMNS)
    .from(runners)
    .where(and(eq(runners.tokenHash, sha256Hex(token)), isNull(runners.revokedAt)))
    .limit(1);
  return runner ?? null;
}

/** 記錄 Heartbeat：以 Server 收到的時間更新最後 Heartbeat 時間。 */
export async function recordHeartbeat(db: Database, runnerId: string, at: Date): Promise<void> {
  await db.update(runners).set({ lastHeartbeatAt: at }).where(eq(runners.id, runnerId));
}

/**
 * 記錄 Runner 回報的 AgentAvailability：整份取代前一次的內容。
 * 每個 Agent 一筆，並行上限取自它使用的 Credential；Credential 本身不會出現在這裡（ADR-0007）。
 */
export async function recordAgentAvailability(
  db: Database,
  runnerId: string,
  availability: AgentAvailability,
): Promise<void> {
  const credentials = new Map(availability.credentials.map((c) => [c.label, c]));
  const seen = new Set<string>();
  const rows = availability.agents.flatMap((agent) => {
    const credential = agent.credential ?? "";
    const key = `${agent.id}\u0000${credential}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const info = agent.credential ? credentials.get(agent.credential) : undefined;
    return [
      {
        runnerId,
        agent: agent.id,
        credential,
        maxConcurrency: Math.max(1, info?.max_concurrent_runs ?? DEFAULT_MAX_CONCURRENT_RUNS),
        available: agent.available,
        details: {
          version: agent.version,
          unavailableReason: agent.unavailable_reason,
          capabilities: agent.capabilities,
          models: agent.models,
          permissionGaps: agent.permission_gaps,
          activeRuns: info?.active_runs ?? null,
        },
      },
    ];
  });
  await db.transaction(async (tx) => {
    await tx.delete(agentAvailabilities).where(eq(agentAvailabilities.runnerId, runnerId));
    if (rows.length > 0) await tx.insert(agentAvailabilities).values(rows);
  });
}
