import "./Switch.css";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 無障礙名稱（通常是同一列的標題）。 */
  label: string;
  disabled?: boolean;
  /** 停用時的說明。 */
  tooltip?: string;
}

/** 30×18 的開關，開啟時 accent 色。 */
export function Switch({ checked, onChange, label, disabled = false, tooltip }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-tip={tooltip}
      className="o-switch"
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="o-switch-knob" />
    </button>
  );
}
