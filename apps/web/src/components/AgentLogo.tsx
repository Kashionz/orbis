// Agent 的 logo（lobehub/lobe-icons）。codex 與 grok-build 是淺色填色，淺色主題反相（base.css）。

import { Bot } from "lucide-react";
import antigravity from "../assets/agents/antigravity.svg";
import claudeCode from "../assets/agents/claude-code.svg";
import codex from "../assets/agents/codex.svg";
import grokBuild from "../assets/agents/grok-build.svg";

const LOGOS: Record<string, { src: string; invertInLight: boolean }> = {
  "claude-code": { src: claudeCode, invertInLight: false },
  codex: { src: codex, invertInLight: true },
  antigravity: { src: antigravity, invertInLight: false },
  "grok-build": { src: grokBuild, invertInLight: true },
};

interface AgentLogoProps {
  /** Agent Profile 的 id，例如 `claude-code`。 */
  agent: string;
  size?: number;
  /** 放在圓形底上（事件串流的代理標頭，24px 圓、logo 14px）。 */
  circle?: boolean;
}

export function AgentLogo({ agent, size = 14, circle = false }: AgentLogoProps) {
  const logo = LOGOS[agent];
  const image = logo ? (
    <img
      className="o-agent-logo"
      data-invert-light={logo.invertInLight}
      src={logo.src}
      alt=""
      width={size}
      height={size}
      style={{ display: "block", width: size, height: size, flex: "none" }}
    />
  ) : (
    <Bot size={size} aria-hidden="true" style={{ flex: "none", color: "var(--o8b9098)" }} />
  );
  if (!circle) return image;
  return (
    <span
      style={{
        width: size + 10,
        height: size + 10,
        borderRadius: "50%",
        background: "var(--o1c1e22)",
        display: "grid",
        placeItems: "center",
        flex: "none",
      }}
    >
      {image}
    </span>
  );
}

/** 有專屬 logo 的 Agent。 */
export function hasAgentLogo(agent: string): boolean {
  return agent in LOGOS;
}
