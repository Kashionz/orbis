import { useId } from "react";

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** 欄位的問題（表單驗證）；有值時標成 aria-invalid。 */
  error?: string | undefined;
  /** 欄位下方的說明。 */
  hint?: string;
  multiline?: boolean;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
}

/** 有標籤、說明與驗證錯誤的文字欄位。說明與錯誤不放在 label 裡，欄位的名稱只有 `label`。 */
export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  multiline,
  ...rest
}: TextFieldProps) {
  const id = useId();
  const describedBy =
    [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;
  const props = {
    id,
    value,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    ...rest,
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea rows={4} {...props} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input {...props} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint && (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}
