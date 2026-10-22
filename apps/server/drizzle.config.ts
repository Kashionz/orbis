import { defineConfig } from "drizzle-kit";

// `db:check` 會把 out 指到暫存目錄，確認 schema 不會再產生新的 migration。
const out = process.env.DRIZZLE_MIGRATIONS_OUT ?? "./src/db/migrations";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out,
  casing: "snake_case",
});
