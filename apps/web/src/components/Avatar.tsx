// 成員頭像：有 GitHub 頭像時顯示圖片，否則顯示首字母，底色由名稱決定（三種 token 色輪替）。

import type { CSSProperties, ReactNode } from "react";
import "./Avatar.css";

const AVATAR_TONES = ["var(--o3a3e46)", "var(--o4a3e52)", "var(--o3b4d45)"] as const;

/** 同一個名稱永遠得到同一個底色。 */
export function avatarTone(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0];
}

export function initialOf(name: string): string {
  const first = [...name.trim().replace(/^@/, "")][0];
  return first ? first.toUpperCase() : "?";
}

export interface AvatarPerson {
  /** 顯示名稱或 GitHub login。 */
  name: string;
  avatarUrl?: string | null;
}

interface AvatarProps {
  person: AvatarPerson | null;
  size?: number;
  /** 右下角的狀態點（例如 Runner 在線）。 */
  status?: "online" | "offline" | null;
  /** 外圈（疊在其他頭像上時與底色隔開）。 */
  ring?: boolean;
  /** 選取時的 accent 外圈。 */
  selected?: boolean;
  /** 沒有人時顯示的內容（預設虛線空圈）。 */
  placeholder?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Avatar({
  person,
  size = 24,
  status = null,
  ring = false,
  selected = false,
  placeholder,
  className,
  style,
}: AvatarProps) {
  const fontSize = Math.max(9, Math.round(size * 0.42));
  const classes = ["o-avatar", className].filter(Boolean).join(" ");
  const box: CSSProperties = { width: size, height: size, fontSize, ...style };
  if (!person) {
    return (
      <span className={classes} data-empty="true" style={box} aria-hidden="true">
        {placeholder}
      </span>
    );
  }
  return (
    <span
      className={classes}
      data-ring={ring}
      data-selected={selected}
      style={{ ...box, background: person.avatarUrl ? undefined : avatarTone(person.name) }}
      aria-hidden="true"
    >
      {person.avatarUrl ? (
        <img src={person.avatarUrl} alt="" width={size} height={size} />
      ) : (
        initialOf(person.name)
      )}
      {status && <span className="o-avatar-status" data-status={status} />}
    </span>
  );
}

interface AvatarStackProps {
  people: AvatarPerson[];
  size?: number;
  /** 最多顯示幾個，其餘顯示 +N。 */
  max?: number;
  /** 重疊的距離（px）。 */
  overlap?: number;
  className?: string;
}

export function AvatarStack({
  people,
  size = 22,
  max = 3,
  overlap = 6,
  className,
}: AvatarStackProps) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className={["o-avatar-stack", className].filter(Boolean).join(" ")}>
      {shown.map((person, index) => (
        <Avatar
          // biome-ignore lint/suspicious/noArrayIndexKey: 同名的人可能出現兩次，順序固定
          key={`${person.name}-${index}`}
          person={person}
          size={size}
          ring
          style={{ marginLeft: index === 0 ? 0 : -overlap, zIndex: shown.length - index }}
        />
      ))}
      {rest > 0 && (
        <span
          className="o-avatar o-avatar-more"
          data-ring="true"
          style={{ width: size, height: size, marginLeft: -overlap }}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}
