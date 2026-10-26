"use client";

import * as React from "react";
import {
  AnimatePresence,
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  type Transition,
} from "motion/react"; // 使用 framer-motion 時改為 "framer-motion"，API 相同
import {
  Check,
  ExternalLink,
  FileText,
  Pause,
  Pencil,
  Play,
  Search,
  Sparkles,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";

/* ───────────────────────── types ───────────────────────── */

export type AgentRunStatus = "working" | "needs-input" | "paused" | "done" | "failed" | "stopped";
export type AgentStepStatus = "pending" | "active" | "done" | "failed";

export interface AgentStep {
  id: string;
  label: string;
  icon?: React.ReactNode;
  durationMs?: number;
  status: AgentStepStatus;
}

export interface AgentStatusProps {
  status: AgentRunStatus;
  agent?: { name: string; mark?: React.ReactNode };
  activity?: {
    label: string;
    icon?: React.ReactNode;
    progress?: { value: number; total: number };
  };
  steps: AgentStep[];
  startedAt?: number;
  currentStep?: number; // 1-based
  totalSteps?: number;
  /** needs-input 時要核准的動作，例如 "run npm test -- billing" */
  approval?: string;
  /** done 時的摘要；durationMs 省略時使用計時器的值 */
  summary?: { durationMs?: number; filesChanged?: number };
  /** failed 時的訊息 */
  error?: string;
  /** 歷史列表最多顯示幾筆，預設 4 */
  maxVisibleSteps?: number;
  className?: string;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  onApprove?: () => void;
  onDeny?: () => void;
  onOpenRun?: () => void;
}

/* ───────────────────────── helpers ───────────────────────── */

const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

const TEXT_SPRING: Transition = { type: "spring", stiffness: 560, damping: 40, mass: 0.6 }; // ≈180ms
const CARD_SPRING: Transition = { type: "spring", stiffness: 320, damping: 30, mass: 0.8 };
const FILL_SPRING: Transition = { type: "spring", stiffness: 180, damping: 28 };
const INSTANT: Transition = { duration: 0 };

const MIN_W = 380;
const MAX_W = 420;
const CHROME_W = 152; // padding + mark + gaps + timer

export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatDuration(ms: number) {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** 依 status 決定計時；paused / 終止狀態會凍結，Resume 後扣除暫停時間。 */
function useElapsed(startedAt: number | undefined, running: boolean) {
  const [now, setNow] = React.useState(() => Date.now());
  const pausedAt = React.useRef<number | null>(null);
  const pausedTotal = React.useRef(0);

  React.useEffect(() => {
    if (running) {
      if (pausedAt.current !== null) {
        pausedTotal.current += Date.now() - pausedAt.current;
        pausedAt.current = null;
      }
      setNow(Date.now());
      const id = window.setInterval(() => setNow(Date.now()), 250);
      return () => window.clearInterval(id);
    }
    if (pausedAt.current === null) pausedAt.current = Date.now();
    setNow(Date.now());
    return undefined;
  }, [running]);

  React.useEffect(() => {
    pausedAt.current = running ? null : Date.now();
    pausedTotal.current = 0;
    // startedAt 改變代表新的 Run
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  if (!startedAt) return 0;
  const end = pausedAt.current ?? now;
  return Math.max(0, end - startedAt - pausedTotal.current);
}

/** 量測文字寬度，讓卡片寬度跟著目前動作文字 spring 變化。 */
function useTextWidth() {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    setWidth(el.offsetWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/* ───────────────────────── pieces ───────────────────────── */

function Shimmer({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (!active) return <>{children}</>;
  return (
    <motion.span
      className="bg-clip-text text-transparent [background-size:250%_100%]"
      style={{
        backgroundImage:
          "linear-gradient(90deg, rgb(161 161 170) 0%, rgb(161 161 170) 35%, rgb(250 250 250) 50%, rgb(161 161 170) 65%, rgb(161 161 170) 100%)",
      }}
      initial={{ backgroundPosition: "150% 0" }}
      animate={{ backgroundPosition: "-50% 0" }}
      transition={{ duration: 1.8, ease: "linear", repeat: Infinity }}
    >
      {children}
    </motion.span>
  );
}

function AgentMark({
  status,
  mark,
  reduce,
}: {
  status: AgentRunStatus;
  mark?: React.ReactNode;
  reduce: boolean;
}) {
  const spinning = status === "working" && !reduce;
  const showRing = status === "working" || status === "needs-input" || status === "paused";
  const rotate = useMotionValue(0);

  // 無限旋轉；停止時保留目前角度，Resume 從原角度繼續
  useAnimationFrame((_, delta) => {
    if (spinning) rotate.set((rotate.get() + delta * 0.26) % 360);
  });

  const ringColor =
    status === "needs-input" ? "border-t-amber-400" : status === "paused" ? "border-t-zinc-500" : "border-t-sky-400";

  const core =
    status === "done"
      ? "bg-emerald-500 text-white"
      : status === "failed"
        ? "bg-red-500/15 text-red-400"
        : status === "stopped"
          ? "bg-white/[0.06] text-zinc-400"
          : "bg-white/[0.07] text-zinc-200";

  const glyph =
    status === "done" ? (
      <Check className="size-4" strokeWidth={2.75} />
    ) : status === "failed" ? (
      <X className="size-4" strokeWidth={2.5} />
    ) : status === "stopped" ? (
      <Square className="size-3" fill="currentColor" strokeWidth={0} />
    ) : (
      (mark ?? <Sparkles className="size-4" strokeWidth={2} />)
    );

  const glyphKey = status === "done" || status === "failed" || status === "stopped" ? status : "mark";

  return (
    <div className="relative size-9 shrink-0">
      <AnimatePresence>
        {showRing && (
          <motion.div
            key="ring"
            className="absolute inset-0"
            initial={{ scale: 1.2, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.55, opacity: 0 }}
            transition={reduce ? INSTANT : { type: "spring", stiffness: 380, damping: 26 }}
          >
            <motion.div
              style={{ rotate }}
              className={cn("absolute inset-0 rounded-full border-[1.5px] border-white/10", ringColor)}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <motion.div
        className={cn(
          "absolute inset-[5px] grid place-items-center overflow-hidden rounded-full transition-colors duration-300",
          core,
        )}
        animate={status === "done" && !reduce ? { scale: [0.85, 1.08, 1] } : { scale: 1 }}
        transition={{ duration: 0.42, ease: [0.2, 0.9, 0.3, 1] }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={glyphKey}
            className="grid place-items-center"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4, rotate: -40 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
            transition={reduce ? INSTANT : { type: "spring", stiffness: 520, damping: 26 }}
          >
            {glyph}
          </motion.span>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function SegmentedProgress({
  total,
  current,
  status,
  fraction,
  reduce,
}: {
  total: number;
  current: number;
  status: AgentRunStatus;
  fraction: number;
  reduce: boolean;
}) {
  return (
    <div className="flex gap-1" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={current}>
      {Array.from({ length: total }, (_, i) => {
        const index = i + 1;
        const done = status === "done" || index < current;
        const active = !done && index === current;
        const fill = done ? 1 : active ? Math.max(0.08, fraction) : 0;
        const color =
          status === "done"
            ? "bg-sky-500"
            : active && status === "failed"
              ? "bg-red-400"
              : active && status === "needs-input"
                ? "bg-amber-400"
                : active && (status === "paused" || status === "stopped")
                  ? "bg-zinc-500"
                  : "bg-sky-500";
        return (
          <div key={i} className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
            <motion.div
              className={cn("absolute inset-y-0 left-0 rounded-full", color)}
              initial={false}
              animate={{ width: `${fill * 100}%` }}
              transition={reduce ? INSTANT : FILL_SPRING}
            />
            {active && status === "working" && !reduce && (
              <motion.div
                className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent"
                initial={{ x: "-100%" }}
                animate={{ x: "300%" }}
                transition={{ duration: 1.3, ease: "easeInOut", repeat: Infinity }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

const STEP_ICON_CLASS = "size-3.5";
export const stepIcons = {
  read: <FileText className={STEP_ICON_CLASS} />,
  search: <Search className={STEP_ICON_CLASS} />,
  edit: <Pencil className={STEP_ICON_CLASS} />,
  run: <SquareTerminal className={STEP_ICON_CLASS} />,
};

function StepList({
  steps,
  max,
  status,
  reduce,
}: {
  steps: AgentStep[];
  max: number;
  status: AgentRunStatus;
  reduce: boolean;
}) {
  const visible = steps.filter((s) => s.status !== "pending").slice(-max);
  const t = reduce ? INSTANT : TEXT_SPRING;
  return (
    <ul className="relative flex flex-col">
      <AnimatePresence initial={false} mode="popLayout">
        {visible.map((step) => {
          const active = step.status === "active";
          return (
            <motion.li
              key={step.id}
              layout={!reduce}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={t}
              className={cn(
                "-mx-2 flex h-7 items-center gap-2.5 rounded-md px-2 text-[12.5px]",
                active ? "bg-white/[0.045] text-zinc-100" : "text-zinc-400",
              )}
            >
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center",
                  step.status === "failed" ? "text-red-400" : active ? "text-sky-400" : "text-zinc-500",
                )}
              >
                {step.icon ?? <Check className={STEP_ICON_CLASS} />}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <Shimmer active={active && status === "working" && !reduce}>{step.label}</Shimmer>
              </span>
              <span className="shrink-0 text-[11.5px] text-zinc-500 tabular-nums">
                {step.durationMs != null ? formatDuration(step.durationMs) : active ? "…" : ""}
              </span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

const btn =
  "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-400/60";
const btnSecondary = cn(btn, "bg-white/[0.06] text-zinc-200 hover:bg-white/[0.1]");
const btnGhost = cn(btn, "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100");
const btnPrimary = cn(btn, "bg-sky-500 text-white hover:bg-sky-400");

/* ───────────────────────── main ───────────────────────── */

export function AgentStatus({
  status,
  agent,
  activity,
  steps,
  startedAt,
  currentStep,
  totalSteps,
  approval,
  summary,
  error,
  maxVisibleSteps = 4,
  className,
  onPause,
  onResume,
  onStop,
  onApprove,
  onDeny,
  onOpenRun,
}: AgentStatusProps) {
  const reduce = !!useReducedMotion();
  const elapsed = useElapsed(startedAt, status === "working" || status === "needs-input");
  const total = totalSteps ?? Math.max(steps.length, 1);
  const current =
    currentStep ?? Math.max(1, steps.findIndex((s) => s.status === "active") + 1 || steps.filter((s) => s.status === "done").length);
  const fraction = activity?.progress ? activity.progress.value / Math.max(1, activity.progress.total) : 0.55;

  const doneIn = formatDuration(summary?.durationMs ?? elapsed).replace(/\.0s$/, "s");
  const headline: { key: string; text: string; secondary?: string } =
    status === "needs-input"
      ? { key: `ni:${approval ?? activity?.label}`, text: `Needs your approval to ${approval ?? lowerFirst(activity?.label ?? "continue")}` }
      : status === "done"
        ? {
            key: "done",
            text: `Done in ${doneIn}`,
            secondary: summary?.filesChanged != null ? `${summary.filesChanged} files changed` : undefined,
          }
        : status === "failed"
          ? { key: "failed", text: error ?? "Run failed" }
          : status === "stopped"
            ? { key: "stopped", text: "Stopped" }
            : { key: `a:${activity?.label ?? ""}`, text: activity?.label ?? "Starting…" };

  const [measureRef, textWidth] = useTextWidth();
  const cardWidth = Math.min(MAX_W, Math.max(MIN_W, textWidth + CHROME_W));

  const headlineColor =
    status === "done"
      ? "text-emerald-400"
      : status === "failed"
        ? "text-red-400"
        : status === "needs-input"
          ? "text-amber-300"
          : status === "paused" || status === "stopped"
            ? "text-zinc-400"
            : "text-zinc-100";

  const actionsKey =
    status === "working" || status === "paused"
      ? "run"
      : status === "needs-input"
        ? "approve"
        : status === "failed" || status === "stopped"
          ? "end"
          : null;

  return (
    <motion.div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/[0.08] bg-zinc-900/70 p-4 text-zinc-100",
        "shadow-[0_12px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl",
        className,
      )}
      initial={false}
      animate={{ width: cardWidth }}
      transition={reduce ? INSTANT : CARD_SPRING}
    >
      {/* 隱藏的量測元素：與標題同字級 */}
      <span ref={measureRef} aria-hidden className="pointer-events-none invisible absolute whitespace-nowrap text-[13.5px] font-medium">
        {headline.text}
        {headline.secondary ? `  ${headline.secondary}` : ""}
      </span>

      {/* 1. 目前動作列 */}
      <div className="flex items-center gap-3">
        <AgentMark status={status} mark={agent?.mark} reduce={reduce} />
        <div className="relative h-5 min-w-0 flex-1 overflow-hidden" role="status" aria-live="polite">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={headline.key}
              className={cn("absolute inset-0 truncate whitespace-nowrap text-[13.5px] font-medium leading-5", headlineColor)}
              initial={reduce ? { opacity: 0 } : { y: "100%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { y: "-100%", opacity: 0 }}
              transition={reduce ? INSTANT : TEXT_SPRING}
            >
              <Shimmer active={status === "working" && !reduce}>{headline.text}</Shimmer>
              {headline.secondary && <span className="ml-2.5 font-normal text-zinc-500">{headline.secondary}</span>}
            </motion.div>
          </AnimatePresence>
        </div>
        <span className="shrink-0 text-[12.5px] text-zinc-400 tabular-nums">{formatElapsed(summary?.durationMs ?? elapsed)}</span>
      </div>

      {/* 2. 模型與步驟 */}
      <div className="mt-3 flex items-center justify-between text-[12px] text-zinc-500">
        <span className="truncate">{agent?.name ?? "Agent"}</span>
        <span className="shrink-0 tabular-nums">
          Step {Math.min(current, total)} of {total}
        </span>
      </div>

      {/* 3. 分段進度條 */}
      <div className="mt-2">
        <SegmentedProgress total={total} current={current} status={status} fraction={fraction} reduce={reduce} />
      </div>

      {/* 4. 歷史步驟 */}
      <div className="mt-3">
        <StepList steps={steps} max={maxVisibleSteps} status={status} reduce={reduce} />
      </div>

      {/* 5. 操作 */}
      <AnimatePresence mode="popLayout" initial={false}>
        {actionsKey && (
          <motion.div
            key={actionsKey}
            className="mt-3 flex items-center gap-1.5 border-t border-white/[0.06] pt-3"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={reduce ? INSTANT : TEXT_SPRING}
          >
            {actionsKey === "run" && (
              <>
                {status === "paused" ? (
                  <button type="button" className={btnSecondary} onClick={onResume}>
                    <Play className="size-3.5" /> Resume
                  </button>
                ) : (
                  <button type="button" className={btnSecondary} onClick={onPause}>
                    <Pause className="size-3.5" /> Pause
                  </button>
                )}
                <button type="button" className={btnGhost} onClick={onStop}>
                  <Square className="size-3" fill="currentColor" strokeWidth={0} /> Stop
                </button>
              </>
            )}
            {actionsKey === "approve" && (
              <>
                <button type="button" className={btnPrimary} onClick={onApprove}>
                  Approve
                </button>
                <button type="button" className={btnGhost} onClick={onDeny}>
                  Deny
                </button>
              </>
            )}
            <button type="button" className={cn(btnGhost, "ml-auto")} onClick={onOpenRun}>
              Open run <ExternalLink className="size-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default AgentStatus;
