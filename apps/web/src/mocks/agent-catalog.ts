// mock 的模型目錄（`GET /api/agent-catalog`，契約的 AgentCatalogResponse）：與 dispatch-options 的 Agent 與
// model id 一致，涵蓋可調整、固定、不支援三種推理強度，以及未登入的 Agent。

import type { AgentCatalogEntry } from "@orbis/api-contract";

const ADJUSTABLE = { kind: "adjustable" } as const;

export const MOCK_AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    agentId: "claude-code",
    tool: "Claude Code",
    vendor: "Anthropic",
    cliId: "claude",
    signedIn: true,
    loginHint: { kind: "runner", command: "claude /login" },
    models: [
      {
        id: "claude-opus-5-5",
        name: "Opus 5.5",
        tag: "best",
        effort: ADJUSTABLE,
        source: "profile",
      },
      {
        id: "claude-sonnet-5-5",
        name: "Sonnet 5.5",
        tag: "balanced",
        effort: ADJUSTABLE,
        source: "profile",
      },
      {
        id: "claude-haiku-5-5",
        name: "Haiku 5.5",
        tag: "fast",
        effort: { kind: "fixed", level: "fast" },
        source: "profile",
      },
    ],
  },
  {
    agentId: "codex",
    tool: "Codex",
    vendor: "OpenAI",
    cliId: "codex",
    signedIn: true,
    loginHint: { kind: "runner", command: "codex login" },
    models: [
      {
        id: "gpt-5-codex",
        name: "GPT-5 Codex",
        tag: "coding",
        effort: ADJUSTABLE,
        source: "profile",
      },
      { id: "gpt-5", name: "GPT-5", tag: "best", effort: ADJUSTABLE, source: "profile" },
      { id: "gpt-5-mini", name: "GPT-5 Mini", tag: "fast", effort: ADJUSTABLE, source: "profile" },
    ],
  },
  {
    agentId: "antigravity",
    tool: "Antigravity",
    vendor: "Google",
    cliId: "agy",
    signedIn: false,
    loginHint: { kind: "cli", command: "agy auth login" },
    models: [
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        tag: "best",
        effort: ADJUSTABLE,
        source: "session",
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        tag: "fast",
        effort: ADJUSTABLE,
        source: "session",
      },
    ],
  },
  {
    agentId: "grok-build",
    tool: "Grok Build",
    vendor: "xAI",
    cliId: "grok",
    signedIn: null,
    loginHint: null,
    models: [
      {
        id: "grok-4",
        name: "Grok 4",
        tag: "best",
        effort: { kind: "unsupported" },
        source: "profile",
      },
      {
        id: "grok-code-fast-1",
        name: "Grok Code Fast 1",
        tag: "coding",
        effort: { kind: "unsupported" },
        source: "profile",
      },
    ],
  },
];
