// 字典的型別：zh-TW 是來源，其他語言必須有完全相同的 key。
// 字串放寬成 string；需要參數或複數的項目寫成函式，其他語言要用相同的簽章。

import type { zhTW } from "./zh-TW";

export type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : T extends object
        ? { readonly [K in keyof T]: Widen<T[K]> }
        : T;

export type Messages = Widen<typeof zhTW>;
