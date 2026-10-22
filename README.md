# Orbis

給 2–10 人小團隊用的專案管理加 Agent Workspace。在 Orbis 中把 Task（Spec 加上 Acceptance Criterion）派給 Claude Code、Codex、Gemini CLI 或 Grok Build，Agent 在隔離的 git worktree 中執行。之後經過自動驗收、人工 review、開 PR，merge 後 Task 自動完成。Windows 是一等公民。

> 目前狀態：設計完成，尚未開始實作。

## 文件

| 文件 | 內容 |
|---|---|
| [GLOSSARY.md](GLOSSARY.md) | 名詞定義 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 完整設計（唯一依據） |
| [docs/adr/](docs/adr/) | 重大決策與理由 |
| [docs/PLAN.md](docs/PLAN.md) | Phase 1 分軌時程與里程碑 |
| [docs/prompts/](docs/prompts/) | 各階段給 Claude Code 的開發 prompt |
| [CLAUDE.md](CLAUDE.md) | 給 Agent 的開發規範 |
