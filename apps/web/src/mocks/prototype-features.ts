// 原型中有、後端還沒有的功能（lib/features.ts）在 mock 模式的完整行為。
// 路徑與資料形狀是暫定的（定義在各 feature 的 api.ts／types），不在 @orbis/api-contract 中。

import { http } from "msw";
import { AGENT_CATALOG_PATH, type AgentCatalogEntry } from "../features/agents/catalog";
import type { MockBackend } from "./backend";
import { handle } from "./handlers";

/** mock 的模型目錄：與 dispatch-options 的模型 id 一致，涵蓋可調整、固定、不支援三種推理強度。 */
export const MOCK_AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    agentId: "claude-code",
    tool: "Claude Code",
    vendor: "Anthropic",
    cliId: "claude",
    signedIn: true,
    models: [
      { id: "claude-opus-5-5", name: "Opus 5.5", tag: "best", effort: "adjustable" },
      { id: "claude-sonnet-5-5", name: "Sonnet 5.5", tag: "balanced", effort: "adjustable" },
      { id: "claude-haiku-5-5", name: "Haiku 5.5", tag: "fast", effort: "fixed:fast" },
    ],
  },
  {
    agentId: "codex",
    tool: "Codex",
    vendor: "OpenAI",
    cliId: "codex",
    signedIn: true,
    models: [
      { id: "gpt-5-codex", name: "GPT-5 Codex", tag: "coding", effort: "adjustable" },
      { id: "gpt-5", name: "GPT-5", tag: "best", effort: "adjustable" },
      { id: "gpt-5-mini", name: "GPT-5 Mini", tag: "fast", effort: "adjustable" },
    ],
  },
  {
    agentId: "antigravity",
    tool: "Antigravity",
    vendor: "Google",
    cliId: "agy",
    signedIn: false,
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tag: "best", effort: "adjustable" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tag: "fast", effort: "adjustable" },
    ],
  },
  {
    agentId: "grok-build",
    tool: "Grok Build",
    vendor: "xAI",
    cliId: "grok",
    signedIn: true,
    models: [
      { id: "grok-4", name: "Grok 4", tag: "best", effort: "none" },
      { id: "grok-code-fast-1", name: "Grok Code Fast 1", tag: "coding", effort: "none" },
    ],
  },
];

export function createPrototypeHandlers(_backend: MockBackend) {
  return [
    http.get(
      AGENT_CATALOG_PATH,
      handle(() => MOCK_AGENT_CATALOG),
    ),
  ];
}
