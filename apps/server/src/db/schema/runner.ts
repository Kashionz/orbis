// Runner、Pairing token、AgentAvailability（ARCHITECTURE §4、§6.1、§15、ADR-0001、ADR-0007）。

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sessions } from "./auth";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import { runnerKindEnum } from "./enums";
import { members, teams } from "./team";

/**
 * Runner：執行 Run 的 daemon。Local Runner 綁定 Member（member_id 不為 null），
 * Team Runner 綁定 Team（member_id 為 null）。兩者都記錄所屬的 team_id。
 * Runner token 只存 SHA-256。
 */
export const runners = pgTable(
  "runners",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => members.id, { onDelete: "cascade" }),
    kind: runnerKindEnum("kind").notNull(),
    /** Runner 在 Hello 中回報的資訊，每次連線時更新。 */
    name: text("name").notNull(),
    runnerVersion: text("runner_version").notNull(),
    os: text("os").notNull(),
    arch: text("arch").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    lastConnectedAt: timestamptz("last_connected_at"),
    lastHeartbeatAt: timestamptz("last_heartbeat_at"),
    /** 撤銷後不能再以 Runner token 連線。 */
    revokedAt: timestamptz("revoked_at"),
    /**
     * 完成 Pairing 時，Pairing token 的建立者所用的 session（從 Pairing token 複製）。
     * 登出或清除過期 session 時，Server 先撤銷這個 session 配對的 Local Runner，再刪除 session
     * （ARCHITECTURE §16）。Team Runner 為 null。
     */
    pairedSessionId: uuid("paired_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("runners_team_id_idx").on(t.teamId),
    index("runners_paired_session_id_idx").on(t.pairedSessionId),
    index("runners_member_id_idx").on(t.memberId),
    check("runners_kind_binding", sql`(${t.kind} = 'local') = (${t.memberId} IS NOT NULL)`),
  ],
);

/**
 * Pairing token：把 Runner 綁定到 Member（Local Runner）或 Team（Team Runner）用的一次性憑證。
 * Team Runner 的 token 由 Admin 在 UI 產生；Local Runner 的 token 由 Electron 登入後自動取得。
 * 只存 SHA-256。
 */
export const runnerPairingTokens = pgTable(
  "runner_pairing_tokens",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    memberId: uuid("member_id").references(() => members.id, { onDelete: "cascade" }),
    kind: runnerKindEnum("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /** 建立這個 token 的 session；Pairing 時複製到 runners.paired_session_id。 */
    createdBySessionId: uuid("created_by_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamptz("expires_at"),
    /** 用這個 token 完成 Pairing 的 Runner。 */
    usedByRunnerId: uuid("used_by_runner_id").references(() => runners.id, {
      onDelete: "set null",
    }),
    usedAt: timestamptz("used_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "runner_pairing_tokens_kind_binding",
      sql`(${t.kind} = 'local') = (${t.memberId} IS NOT NULL)`,
    ),
  ],
);

/**
 * AgentAvailability：Runner 回報這台主機能跑哪些 Agent，以及各 Credential 的並行上限。
 * Credential 本身不上傳（ADR-0007），這裡只有 Runner 自訂的 Credential 名稱。
 */
export const agentAvailabilities = pgTable(
  "agent_availabilities",
  {
    id: id(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    /** Agent 的識別名稱，例如 `claude-code`。 */
    agent: text("agent").notNull(),
    /** Runner 上的 Credential 名稱，例如 `default`。 */
    credential: text("credential").notNull(),
    maxConcurrency: integer("max_concurrency").notNull(),
    available: boolean("available").notNull().default(true),
    /** Runner 回報的其他資訊（版本、可用 model、無法使用的原因等），格式保留彈性。 */
    details: jsonb("details"),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("agent_availabilities_runner_id_agent_credential_unique").on(
      t.runnerId,
      t.agent,
      t.credential,
    ),
    check("agent_availabilities_max_concurrency_positive", sql`${t.maxConcurrency} >= 1`),
  ],
);
