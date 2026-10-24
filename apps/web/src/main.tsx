import "@fontsource-variable/inter/opsz.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./components/Toast";
import { TooltipLayer } from "./components/Tooltip";
import { I18nProvider } from "./i18n";
import { useThemeEffect } from "./lib/preferences";
import { createAppRouter } from "./router";

function ThemeEffect() {
  useThemeEffect();
  return null;
}

async function main() {
  // `vite --mode mock`：先啟動 MSW 假後端，之後的請求才會被攔截
  if (import.meta.env.MODE === "mock") {
    const { startMockBackend } = await import("./mocks/browser");
    await startMockBackend();
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 1_000 } },
  });
  const router = createAppRouter(queryClient);

  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("找不到 #root");

  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <ThemeEffect />
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </QueryClientProvider>
        <TooltipLayer />
      </I18nProvider>
    </StrictMode>,
  );
}

void main();
