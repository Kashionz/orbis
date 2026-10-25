// Desktop 的 Preview 留言 e2e（apps/desktop/e2e/preview-comment.spec.ts）用的測試頁：直接掛 PreviewPanel，
// 另外放一個「退回」按鈕，照 C 軌 Review 頁會使用的介面：讀 Preview 留言的草稿，放進 Review Gate 退回的
// previewComments 送出。spec 以 esbuild 打包、fake server 提供；Web UI 本身不會載入這個檔案。

import { API_ROUTES, apiPath } from "@orbis/api-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PreviewPanel } from "./PreviewPanel";
import { clearPreviewDrafts, loadPreviewDrafts } from "./preview-drafts";

const params = new URLSearchParams(location.search);
const runId = params.get("run") ?? "";
const gateId = params.get("gate") ?? "";

function Harness() {
  const [result, setResult] = useState("");
  async function reject() {
    const response = await fetch(apiPath(API_ROUTES.gateDecision, { gateId }), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "reject",
        comment: null,
        reviewComments: [],
        previewComments: loadPreviewDrafts(runId),
      }),
    });
    if (response.ok) clearPreviewDrafts(runId);
    setResult(`HTTP ${response.status}`);
  }
  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <button type="button" onClick={() => void reject()}>
        退回
      </button>
      <output id="result">{result}</output>
      {/* PreviewPanel 在工作區是直向 flex 的子元素：這裡照樣給它撐滿的空間 */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <PreviewPanel runId={runId} canComment canRestart />
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
}
