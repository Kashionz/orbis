// Postgres 錯誤的判斷。drizzle 會把 pg 的錯誤包在 cause 中，兩層都要看。

/** 違反唯一鍵（SQLSTATE 23505）。 */
export function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause;
  return (error as { code?: string }).code === "23505" || cause?.code === "23505";
}
