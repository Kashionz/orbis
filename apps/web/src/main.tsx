import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppRouter } from "./router";
import "./styles.css";

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
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void main();
