import { errorMessage } from "../api/client";

/** 顯示操作失敗的原因；沒有錯誤時不顯示。 */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="error-text" role="alert">
      {errorMessage(error)}
    </p>
  );
}
