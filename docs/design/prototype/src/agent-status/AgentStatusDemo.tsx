"use client";

import * as React from "react";
import { AgentStatus, stepIcons, type AgentRunStatus, type AgentStep } from "./AgentStatus";

type Kind = keyof typeof stepIcons;
interface ScriptStep {
  id: string;
  kind: Kind;
  label: string;
  ms: number;
  approval?: string;
}

const SCRIPT: ScriptStep[] = [
  { id: "s1", kind: "read", label: "Reading 12 files", ms: 1900 },
  { id: "s2", kind: "search", label: "Searching for prorateInvoice", ms: 1200 },
  { id: "s3", kind: "edit", label: "Editing src/billing/invoice.ts", ms: 3400 },
  { id: "s4", kind: "run", label: "Running npm test -- billing", ms: 2600, approval: "run npm test -- billing" },
  { id: "s5", kind: "edit", label: "Editing src/billing/invoice.test.ts", ms: 2100 },
  { id: "s6", kind: "run", label: "Running npm test", ms: 1800 },
];

/** 模擬一次 Run：working → needs-input → working → done。 */
export function AgentStatusDemo() {
  const [status, setStatus] = React.useState<AgentRunStatus>("working");
  const [index, setIndex] = React.useState(0);
  const [stepElapsed, setStepElapsed] = React.useState(0);
  const [durations, setDurations] = React.useState<Record<string, number>>({});
  const [approved, setApproved] = React.useState<Record<string, boolean>>({});
  const [startedAt, setStartedAt] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (status !== "working") return;
    const id = window.setInterval(() => {
      setStepElapsed((t) => {
        const step = SCRIPT[index];
        if (!step) return t;
        const next = t + 100;
        if (step.approval && !approved[step.id] && next >= 300) {
          setStatus("needs-input");
          return next;
        }
        if (next >= step.ms) {
          setDurations((d) => ({ ...d, [step.id]: step.ms }));
          if (index + 1 >= SCRIPT.length) setStatus("done");
          else setIndex(index + 1);
          return 0;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [status, index, approved]);

  const current = SCRIPT[Math.min(index, SCRIPT.length - 1)];
  const steps: AgentStep[] = SCRIPT.map((s, i) => ({
    id: s.id,
    label: s.label,
    icon: stepIcons[s.kind],
    durationMs: durations[s.id],
    status: durations[s.id] != null ? "done" : i === index && status !== "done" ? "active" : "pending",
  }));

  const restart = () => {
    setStatus("working");
    setIndex(0);
    setStepElapsed(0);
    setDurations({});
    setApproved({});
    setStartedAt(Date.now());
  };

  return (
    <div className="flex flex-col items-center gap-6">
      <AgentStatus
        status={status}
        agent={{ name: "Claude Sonnet 5.5" }}
        activity={{ label: current.label, icon: stepIcons[current.kind], progress: { value: stepElapsed, total: current.ms } }}
        steps={steps}
        startedAt={startedAt}
        currentStep={Math.min(index + 1, SCRIPT.length)}
        totalSteps={SCRIPT.length}
        approval={current.approval}
        summary={status === "done" ? { filesChanged: 6 } : undefined}
        onPause={() => setStatus("paused")}
        onResume={() => setStatus("working")}
        onStop={() => setStatus("stopped")}
        onApprove={() => {
          setApproved((a) => ({ ...a, [current.id]: true }));
          setStatus("working");
        }}
        onDeny={() => setStatus("stopped")}
        onOpenRun={() => window.alert("Open run")}
      />
      <button type="button" onClick={restart} className="text-[12.5px] text-zinc-400 hover:text-zinc-100">
        Replay
      </button>
    </div>
  );
}

export default AgentStatusDemo;
