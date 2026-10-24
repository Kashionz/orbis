import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import "./Button.css";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "danger-ghost"
  | "subtle";
export type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** sm 24px、md 28px（預設）、lg 36px。 */
  size?: ButtonSize;
  icon?: ReactNode;
  /** 右側的快捷鍵提示等。 */
  trailing?: ReactNode;
};

/** 一般按鈕。primary 是實心淺色（深色主題）、secondary 是灰底、ghost 只有 hover 底色。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, trailing, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={["o-btn", className].filter(Boolean).join(" ")}
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {icon && <span className="o-btn-icon">{icon}</span>}
      {children}
      {trailing}
    </button>
  );
});

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  /** 無障礙名稱，同時是 Tooltip。 */
  label: string;
  icon: ReactNode;
  /** 24、26、28（預設）或 32。 */
  size?: 24 | 26 | 28 | 32;
  /** Tooltip 不同於名稱時（例如補充快捷鍵）。 */
  tooltip?: string | null;
  danger?: boolean;
  pressed?: boolean;
};

/** 只有圖示的按鈕：一定有 aria-label 與 Tooltip。 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 28, tooltip, danger = false, pressed, className, type, ...rest },
  ref,
) {
  const tip = tooltip === undefined ? label : tooltip;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={tip ?? undefined}
      data-danger={danger}
      className={["o-icon-btn", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
      {...rest}
    >
      {icon}
    </button>
  );
});
