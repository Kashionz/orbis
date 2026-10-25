// 存在瀏覽器 localStorage 的個人偏好。key 一律以產品代號為前綴（例如 `orbis-theme`），
// 讀寫都包在 try/catch 中：無痕模式或封鎖網站資料時 localStorage 可能丟例外。

import { NAMES } from "@orbis/api-contract/names";
import { useSyncExternalStore } from "react";

/** 由名稱組出 localStorage 的 key，例如 `storageKey("theme")` → `orbis-theme`。 */
export function storageKey(name: string): string {
  return `${NAMES.productSlug}-${name}`;
}

export function readStorage(name: string): string | null {
  try {
    return localStorage.getItem(storageKey(name));
  } catch {
    return null;
  }
}

export function writeStorage(name: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(storageKey(name));
    else localStorage.setItem(storageKey(name), value);
  } catch {
    // 存不了就只在這次瀏覽有效
  }
}

export interface PersistentState<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

/**
 * 存在 localStorage 的一個值。`parse` 回傳 undefined 表示存的值無效，改用預設值。
 * 同一個分頁內以訂閱通知更新；其他分頁改動時經由 `storage` 事件同步。
 */
export function persistentState<T>(
  name: string,
  fallback: T,
  parse: (raw: string) => T | undefined,
  serialize: (value: T) => string = String,
): PersistentState<T> {
  const listeners = new Set<() => void>();
  let cached: { raw: string | null; value: T } | null = null;

  function get(): T {
    const raw = readStorage(name);
    if (cached && cached.raw === raw) return cached.value;
    const value = raw === null ? fallback : (parse(raw) ?? fallback);
    cached = { raw, value };
    return value;
  }

  function set(value: T) {
    writeStorage(name, serialize(value));
    cached = { raw: readStorage(name), value };
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey(name)) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  return { get, set, subscribe };
}

/** 在元件中讀取並訂閱一個 PersistentState。 */
export function usePersistentState<T>(state: PersistentState<T>): [T, (value: T) => void] {
  const value = useSyncExternalStore(state.subscribe, state.get, state.get);
  return [value, state.set];
}

export function parseEnum<T extends string>(values: readonly T[]) {
  return (raw: string): T | undefined =>
    (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

export function parseNumberIn(min: number, max: number) {
  return (raw: string): number | undefined => {
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
  };
}

export function parseBoolean(raw: string): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}
