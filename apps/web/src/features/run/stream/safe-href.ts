/** 只接受 http／https 的網址；其他 scheme 回傳 null（網址來自 Agent，避免 javascript: 之類）。 */
export function safeHref(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
