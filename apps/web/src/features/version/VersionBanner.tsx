import { useQuery } from "@tanstack/react-query";
import { healthQueryOptions } from "./api";
import { versionNotice } from "./compat";

/**
 * Server 與 Web 的版本不相容時，在頁面頂端顯示要怎麼做（ARCHITECTURE §16「版本相容」）：
 * Web 比 Server 舊就重新整理，Server 比 Web 舊就更新 Server。版本相同、或還查不到時不顯示。
 */
export function VersionBanner() {
  const { data } = useQuery(healthQueryOptions);
  if (!data) return null;
  const notice = versionNotice(data.versions);
  if (!notice) return null;
  return (
    <div
      role="alert"
      className="version-banner"
      data-testid="version-banner"
      data-kind={notice.kind}
    >
      <span>{notice.message}</span>
      {notice.kind === "reload" && (
        <button type="button" onClick={() => window.location.reload()}>
          重新整理
        </button>
      )}
    </div>
  );
}
