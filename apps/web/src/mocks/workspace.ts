// 工作區的 MSW handler：執行中傳訊息、執行中切換設定、換 Agent、互動式終端機、本機合併重試、看板摘要、
// 模型目錄、本機 Repo 連接到 GitHub。路徑、輸入與回應同 @orbis/api-contract。

import {
  API_ROUTES,
  ConnectRepoToGithubInput,
  CreateRunPromptInput,
  CreateTerminalInput,
  SwitchAgentInput,
  TERMINAL_MAX_PER_RUN,
  TerminalClientMessage,
  type TerminalCreated,
  type TerminalServerMessage,
  UpdateRunSettingsInput,
} from "@orbis/api-contract";
import { http, ws } from "msw";
import { MOCK_AGENT_CATALOG } from "./agent-catalog";
import { type MockBackend, MockError } from "./backend";
import { handle, parse } from "./handlers";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(text: string): string {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(data: string): string {
  const binary = atob(data);
  return decoder.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** mock 終端機的提示字元。 */
const PROMPT = "PS C:\\orbis\\worktree> ";

export function createWorkspaceHandlers(backend: MockBackend) {
  /** 開著的終端機：terminalId → runId。 */
  const terminals = new Map<string, string>();
  let terminalCounter = 0;

  const origin = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  const terminalLink = ws.link(`${origin}/api/terminals/*`);
  const terminalHandler = terminalLink.addEventListener("connection", ({ client }) => {
    const terminalId = decodeURIComponent(client.url.pathname.split("/")[3] ?? "");
    const send = (message: TerminalServerMessage) => client.send(JSON.stringify(message));
    if (!terminals.has(terminalId)) {
      send({ type: "error", code: "not_found", message: "找不到這個終端機" });
      client.close();
      return;
    }
    // 模擬 shell：輸入回顯，按 Enter 換行並顯示提示字元；`exit` 結束
    let line = "";
    send({ type: "output", data: toBase64(PROMPT) });
    client.addEventListener("message", (message) => {
      const parsed = TerminalClientMessage.safeParse(JSON.parse(String(message.data)));
      if (!parsed.success || parsed.data.type !== "input") return;
      for (const char of fromBase64(parsed.data.data)) {
        if (char === "\r") {
          const command = line.trim();
          line = "";
          if (command === "exit") {
            send({ type: "output", data: toBase64("\r\n") });
            send({ type: "exited", code: 0, reason: "exited" });
            terminals.delete(terminalId);
            client.close();
            return;
          }
          send({
            type: "output",
            data: toBase64(`\r\n${command === "" ? "" : `${command}\r\n`}${PROMPT}`),
          });
        } else if (char === "\u007f") {
          if (line.length > 0) {
            line = line.slice(0, -1);
            send({ type: "output", data: toBase64("\b \b") });
          }
        } else if (char >= " ") {
          line += char;
          send({ type: "output", data: toBase64(char) });
        }
      }
    });
    client.addEventListener("close", () => terminals.delete(terminalId));
  });

  return [
    terminalHandler,
    http.post(
      API_ROUTES.runPrompts,
      handle(
        async (request, p) =>
          backend.submitPrompt(p.runId ?? "", await parse(request, CreateRunPromptInput)),
        202,
      ),
    ),
    http.delete(
      API_ROUTES.runPrompt,
      handle((_, p) => {
        backend.withdrawPrompt(p.runId ?? "", p.controlId ?? "");
      }),
    ),
    http.get(
      API_ROUTES.runSettings,
      handle((_, p) => backend.runSettings(p.runId ?? "")),
    ),
    http.patch(
      API_ROUTES.runSettings,
      handle(
        async (request, p) =>
          backend.updateRunSettings(p.runId ?? "", await parse(request, UpdateRunSettingsInput)),
        202,
      ),
    ),
    http.post(
      API_ROUTES.runSwitchAgent,
      handle(
        async (request, p) =>
          backend.switchAgent(p.runId ?? "", await parse(request, SwitchAgentInput)),
        202,
      ),
    ),
    http.post(
      API_ROUTES.runTerminals,
      handle(async (request, p): Promise<TerminalCreated> => {
        const runId = p.runId ?? "";
        await parse(request, CreateTerminalInput);
        backend.requireTerminal(runId);
        const open = [...terminals.values()].filter((id) => id === runId).length;
        if (open >= TERMINAL_MAX_PER_RUN) {
          throw new MockError(409, "terminal_limit", "這個 Run 已經開了太多終端機");
        }
        terminalCounter += 1;
        const terminalId = `terminal-${terminalCounter}`;
        terminals.set(terminalId, runId);
        return { terminalId, wsUrl: `/api/terminals/${terminalId}/ws` };
      }, 201),
    ),
    http.post(
      API_ROUTES.runMergeLocal,
      handle((_, p) => backend.retryLocalMerge(p.runId ?? ""), 202),
    ),
    http.get(
      API_ROUTES.projectBoardSummary,
      handle((_, p) => backend.boardSummary(p.projectId ?? "")),
    ),
    http.get(
      API_ROUTES.agentCatalog,
      handle(() => MOCK_AGENT_CATALOG),
    ),
    http.post(
      API_ROUTES.repoConnectGithub,
      handle(async (request, p) =>
        backend.connectRepoToGithub(p.repoId ?? "", await parse(request, ConnectRepoToGithubInput)),
      ),
    ),
  ];
}
