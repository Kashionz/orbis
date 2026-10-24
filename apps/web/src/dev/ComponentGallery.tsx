// 共用元件的展示頁（只在 mock 模式註冊於 /__dev/components）。e2e/ui-components.spec.ts 以這頁
// 測試各元件的互動；不是產品功能，文字不走 i18n。

import { Monitor } from "lucide-react";
import { useState } from "react";
import { AgentLogo } from "../components/AgentLogo";
import { Avatar, AvatarStack } from "../components/Avatar";
import { Button, IconButton } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { FluidList, fluidItem } from "../components/FluidList";
import { Kbd, shortcutLabel } from "../components/Kbd";
import { type MenuGroup, Popover, useMenu } from "../components/Popover";
import { Segmented } from "../components/Segmented";
import { Splitter } from "../components/Splitter";
import { StatusDot } from "../components/StatusDot";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import { Tooltip } from "../components/Tooltip";
import { parseNumberIn, persistentState, usePersistentState } from "../lib/storage";

const galleryWidth = persistentState<number>("gallery-w", 240, parseNumberIn(160, 400));

const MODEL_GROUPS: MenuGroup<string>[] = [
  {
    title: "Claude Code",
    titleSub: "Anthropic",
    logo: <AgentLogo agent="claude-code" />,
    items: [
      { value: "opus", label: "Opus 5.5", tag: "最強" },
      { value: "sonnet", label: "Sonnet 5.5", tag: "平衡" },
      { value: "haiku", label: "Haiku 5.5", tag: "快速", fixed: "固定" },
    ],
  },
  {
    title: "Grok Build",
    titleSub: "xAI",
    logo: <AgentLogo agent="grok-build" />,
    items: [
      {
        value: "grok-4",
        label: "Grok 4",
        disabled: true,
        disabledReason: "此模型不支援調整推理強度",
      },
      {
        value: "grok-code",
        label: "Grok Code Fast 1",
        sub: "一行很長很長很長很長很長很長很長很長很長很長很長很長很長很長的子說明",
      },
    ],
  },
];

export function ComponentGallery() {
  const toast = useToast();
  const [model, setModel] = useState("sonnet");
  const menu = useMenu();
  const bottomMenu = useMenu();
  const dialogMenu = useMenu();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [segment, setSegment] = useState<"all" | "needs" | "mine">("all");
  const [on, setOn] = useState(false);
  const [width, setWidth] = usePersistentState(galleryWidth);
  const [picked, setPicked] = useState("");

  const groups = MODEL_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, checked: item.value === model })),
  }));

  return (
    <main
      style={{
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 24,
        height: "100vh",
        overflow: "auto",
      }}
    >
      <section aria-label="popover" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Button ref={menu.anchorRef} {...menu.triggerProps}>
          模型 {model}
        </Button>
        <Popover
          {...menu.popoverProps}
          label="模型"
          groups={groups}
          onSelect={setModel}
          extraWidth={20}
        />
        <output data-testid="picked-model">{model}</output>
      </section>

      <section aria-label="tooltip" style={{ display: "flex", gap: 12 }}>
        <Tooltip text="完整路徑 D:\\work\\repo\\ORB-42" mono>
          <button type="button">有 Tooltip 的按鈕</button>
        </Tooltip>
        <button type="button" title="原生 title 也會換成 Tooltip">
          原生 title
        </button>
        <IconButton label="中止執行" icon={<Monitor size={14} />} />
      </section>

      <section
        aria-label="splitter"
        style={{ display: "flex", height: 80, border: "1px solid var(--o26292e)" }}
      >
        <div
          data-testid="split-pane"
          style={{ width, position: "relative", background: "var(--oside)" }}
        >
          <Splitter
            edge="right"
            label="調整寬度"
            value={width}
            min={160}
            max={400}
            defaultValue={240}
            step={16}
            rightIncreases
            onChange={(value) => setWidth(Math.round(value))}
            valueFromPointer={(clientX, startValue, startX) => startValue + clientX - startX}
          />
        </div>
        <output data-testid="split-width" style={{ padding: 8 }}>
          {width}
        </output>
      </section>

      <section aria-label="fluid" style={{ width: 240 }}>
        <FluidList>
          {["第一項", "第二項", "第三項"].map((label) => (
            <button
              key={label}
              type="button"
              {...fluidItem}
              onClick={() => setPicked(label)}
              style={{
                display: "block",
                width: "100%",
                height: 28,
                border: 0,
                background: "transparent",
                color: "inherit",
                textAlign: "left",
              }}
            >
              {label}
            </button>
          ))}
        </FluidList>
        <output data-testid="fluid-picked">{picked}</output>
      </section>

      <section aria-label="segmented" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Segmented
          label="篩選"
          value={segment}
          onChange={setSegment}
          options={[
            { value: "all", label: "全部" },
            { value: "needs", label: "待我處理", count: 3 },
            { value: "mine", label: "指派給我" },
          ]}
        />
        <Switch label="自動展開工具步驟" checked={on} onChange={setOn} />
        <Switch
          label="停用的開關"
          checked={false}
          onChange={() => {}}
          disabled
          tooltip="尚未開放"
        />
      </section>

      <section aria-label="avatars" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Avatar person={{ name: "kashionz" }} status="online" />
        <Avatar person={null} />
        <AvatarStack
          people={[
            { name: "kashionz" },
            { name: "mei-lin" },
            { name: "chen-yu" },
            { name: "alice" },
          ]}
        />
        <AgentLogo agent="claude-code" size={16} />
        <AgentLogo agent="codex" size={16} />
        <AgentLogo agent="antigravity" size={16} />
        <AgentLogo agent="grok-build" size={16} />
        <AgentLogo agent="unknown-agent" size={16} />
        <AgentLogo agent="claude-code" circle />
        <Kbd>{shortcutLabel("K")}</Kbd>
        <StatusDot color="var(--o7fb0fa)" live label="執行中" />
      </section>

      <section aria-label="dialog" style={{ display: "flex", gap: 12 }}>
        <Button variant="primary" onClick={() => setDialogOpen(true)}>
          開啟對話框
        </Button>
        <Button variant="ghost" onClick={() => toast.show("已複製")}>
          顯示提示
        </Button>
        <Dialog title="測試對話框" open={dialogOpen} onClose={() => setDialogOpen(false)}>
          <input aria-label="對話框欄位" />
          <Button ref={dialogMenu.anchorRef} {...dialogMenu.triggerProps}>
            對話框中的選單
          </Button>
          <Popover
            {...dialogMenu.popoverProps}
            label="對話框選單"
            groups={[
              {
                items: [
                  { value: "a", label: "選項 A" },
                  { value: "b", label: "選項 B" },
                ],
              },
            ]}
            onSelect={() => {}}
          />
        </Dialog>
      </section>

      <section aria-label="bottom" style={{ marginTop: "auto", paddingTop: 400 }}>
        <Button ref={bottomMenu.anchorRef} {...bottomMenu.triggerProps}>
          底部的選單
        </Button>
        <Popover
          {...bottomMenu.popoverProps}
          label="底部選單"
          groups={groups}
          onSelect={setModel}
        />
      </section>
    </main>
  );
}
