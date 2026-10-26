# Handoff: Orbis Workspace (Task / Run workspace)

## Overview
Orbis is a project-management + agent workspace for 2–10 person teams. Core flow: **Task (spec + optional acceptance criteria) → dispatch to an agent in an isolated git worktree → automatic verification (project verify commands + criteria; skipped when there are neither) → human Review Gate (inline diff comments, send back) → open PR → auto Done on merge.** Windows is a first-class platform.

The prototype covers: the Run workspace (main screen), Board, Needs You, New Task, Spec editing, Share/Invite, Settings, and the composer controls (model / reasoning effort / permission policy).

## About the Design Files
The files in this bundle are **design references built in HTML** — interactive prototypes that show intended look and behavior. They are **not production code**. Recreate them in the target codebase (the Orbis repo uses React + TypeScript under `apps/web/src`) using its established patterns, routing, data layer and component conventions. Where the prototype hard-codes data or fakes actions (toasts), wire them to real APIs.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, states and motion are final. Recreate pixel-accurately. Two language builds exist (Traditional Chinese and English); copy must not mix languages — use i18n keys.

## Global Layout
Three columns, full viewport height, `overflow:hidden`:
1. **Sidebar** — default 280px, **resizable 220–400px** (drag handle on its right edge, double-click resets, ←/→ keys ±16px, persisted to localStorage `orbis-side-w2`).
2. **Main column** — flex:1. Header 52px + content.
3. **Right panel** (workspace only) — **closed by default**; opens with the panel button in the header or actions that need it (open diff, 收尾, terminal). Width = `split` × container, **clamped 26%–62%**, default 42%. Same splitter behavior as sidebar (8px hit area, 2px grey line on hover, 2px accent line while dragging, double-click resets to 42%, arrow keys ±2%).

Base type: **Inter** (variable, opsz 14–32), 13px/20px, weights 400 / 550 / 600 only. Mono: **JetBrains Mono** 400/500 for IDs, paths, models, numbers. CJK falls back to system (Microsoft JhengHei). Use `font-variation-settings` weight shifts without layout shift (render a hidden semibold copy in the same grid cell to reserve width).

Rules from the product owner (enforce in code review):
- Never use "·" as a separator; use spacing/gap.
- No explanatory filler text; only actions and state.
- Minimal radii/shadows; never colored left-border cards.
- No eyebrow/overline labels above titles.
- No "你/you" in option descriptions.

## Screens / Views

### 1. Sidebar
- Header 52px: "Orbis" 16px/550 + team name 12px muted (editable in Settings → Account; localStorage `orbis-team`).
- Search and New conversation are the first two rows under the brand row, styled exactly like the nav rows (34px, transparent, 16px icon, 14px label, 12px mono shortcut on the right: "Ctrl K" / "Ctrl N"). Search is a button, not an input: it opens the Ctrl+K command palette.
- **Ctrl+K** opens the command palette; Esc closes it.
- Nav: 看板 / Board (count), 待我處理 / Needs you (warn-colored count). 34px rows, 14px text, 16px icons, radius 6.
- Task section: a single 進行中 / In progress group (planning, plan gate, running, verifying, review gate, PR open), sorted by last activity; Ready, Backlog and Done live on the Board. Collapsible header (34px, 13px label + 12px mono count, chevron on the right 0°→90°, 160ms). Rows 34px: status dot (pulsing when live) + 14px title (semibold when active, no layout shift) + 12px mono key.
- Conversations group: same header; rows 34px with the current agent's logo (16px, tooltip agent + model), 14px title, unread dot.
- Footer 52px: full-width profile button (avatar 24 with 8px green online dot, name, runner host mono) → opens **Profile menu** (292px popover above): avatar 32 + name + email, items 設定 (Ctrl ,), 執行器 (green dot + KASH-DESKTOP → Settings › Runners), divider, 登出.
- **Fluid hover**: one shared highlight element per list slides to the nearest item (80ms, cubic-bezier(.2,.9,.3,1)); fades on leave. Applies to all lists/segmented controls.

### 2. Run Workspace (main screen)
**Header (52px, border-bottom)**: status dot, mono key, title 14/550 (min-width 80px, ellipsis), run status label (colored), spacer, 中止執行 / Cancel run (danger hover), **share cluster** (avatar stack 22px, -6px overlap, 2px ring + 分享/Share button with icon), panel toggle. Responsive via ResizeObserver on the header: <700/620px hide avatars and Cancel label; <540/480px Share becomes icon-only; <440px title min 24px, gap 8px. All icon-only buttons keep aria-label + tooltip.

**Event stream** (max-width 760, centered, virtual-list feel, "load earlier" at top, "N new" jump pill when scrolled up):
- **Heads**: agent head = agent logo in 24px circle + agent id + model (muted); user head = avatar + name, **right-aligned** (row-reverse).
- **User message**: right-aligned bubble (bg `--o1c1e22`, radius 10, max 560px, 14px/1.7). Hover row below (28px, reserved space, opacity 0→1 80ms): relative time ("剛剛 / N 分鐘前"), Copy, Edit (puts text in composer).
- **Agent message**: markdown-ish blocks (paragraphs, bullet lists, inline code, file chips that open the Diff tab, fenced code with header + copy). No per-message action row.
- **Thought**: collapsed by default: brain icon + "思考了 X 秒 / Thought for Xs" + chevron; live state shows shimmer text. Preview text hidden until expanded.
- **Tool group** (read/search/edit/execute) collapsed to one summary line by default ("讀取 3 個檔案…"); expanded rows show kind icon, title, location, status, inline diff preview (+/−) for edits, "open diff" link.
- **Plan**: collapsed "計畫 2/5 + current step"; expand to list (✓ ◐ ○).
- **Verification group**: collapsed "驗收 3/4 通過" with ✓/✕; auto-expands if any failed.
- **Permission request**: depends on the run's permission policy. Under 全部允許 (default) it is a resolved line: shield icon (muted) + "權限請求" + title button (toggles command detail block) + "已自動允許 / Allowed automatically", never pauses the run. Under 自動 / 逐一確認 a request that needs you is pending: shield icon (warn) + label + title button + options (primary 允許一次 = accent tint bg `rgba(90,156,248,.16)`, secondary 這個 session 都允許, danger 拒絕) + policy mono. Resolved: "已回覆 <option>" + avatar 18 + name. Switching the composer to 全部允許 while a request is pending allows it automatically.
- **System events** (worktree ready, preview, diff, PR, model/effort/policy switch): 12px muted line with icon; inline code in primary text.
- **Status rows**: dot + label + message + time.
- **Tail row**: shown **only once the whole run is finished** (no pending queue, no pending permission, not live, not at plan gate), at the very bottom: Copy (last reply), relative time, "工作了 Xm Ys".

**Composer** (max-width 760, bottom):
- Row above box (11px mono muted, wraps): **worktree path button** (folder icon + `~\.orbis\wt\ORB-42`; hover bg `--o1c1e22` radius 6; full path tooltip) → menu (header = full path mono): 在檔案總管開啟, 在終端機開啟 (switches right panel to Terminal), 在 VS Code 開啟 | 複製路徑, 複製分支名稱. Then **branch** (git icon, max 180px). Right side: elapsed (tooltip = run id), context bar (36×3px, % text, warn >80%, tooltip "41.9k / 200.0k"), cost (primary color).
- Box: bg `--o1c1e22`, 1px `--o26292e`, radius 12. Optional dock (pending action: warn dot + label + detail + primary action). Textarea 14px/1.6. Chip row (28px chips, radius 3): **Model** button (logo + model name), **Reasoning effort** button (text only), **Permission policy** (shield + 全部允許/自動/逐一確認), **Runner** (monitor icon colored by connection + host mono, shrinks first), Send (arrow-up, right).

### 3. Composer menus (generic popover component)
Popover: bg `--opop`, 1px `--o26292e`, radius 10, shadow `0 12px 32px var(--osh)`, padding 6, item min-height 32 radius 6, optional group header (logo + title 12/550 + vendor 11px muted), optional per-item icon, sub-line (12px muted, **single line, ellipsis**), tag pill, check (accent). Auto-flips up/down by estimated height; max-height = available space; inner scroll.
- **Model menu**: groups named by tool with vendor sub — Claude Code / Anthropic, Codex / OpenAI, Antigravity / Google, Grok Build / xAI. Models indented under the title. Right pill tags: 最強 / 平衡 / 快速 / 程式 (en: Best / Balanced / Fast / Coding). Selected row: accent tint bg `rgba(127,176,250,.12)` + check. Switching across agents changes run.agent too and posts a system event.
- **Reasoning effort** (推理強度 / Reasoning effort): separate button next to model. Options 快速 / 標準 (default) / 深度 with one-line descriptions. Unsupported models (Grok 4, Grok Code Fast 1): greyed (opacity .5), not-allowed cursor, tooltip "此模型不支援調整推理強度". Fixed models (placeholder: Haiku 5.5 → 快速) show a 固定/Fixed pill and are not clickable.
- **Permission policy**: 全部允許 (default) / 自動 / 逐一確認 with descriptions (ZH: 所有動作都不再詢問（預設）/ 讀取與工作樹內的編輯自動允許，其他問我 / 每個動作都先詢問). Available on every runner and work location; takes effect from the next request.

### 4. Right panel tabs
Tabs 52px (fluid hover, semibold active without shift): 任務 / Task, 差異 / Diff, 預覽 / Preview, 終端機 / Terminal.
- **Task**: status, repo, assignee (avatar 20 + name), depends. Spec + "編輯" → **inline spec editor**: header with 未儲存 (warn dot) + Cancel/Save (Ctrl+Enter, Esc); auto-growing textarea (field-sizing:content, bg `--o1a1b1f`, radius 8, 96–420px); acceptance rows (status glyph, one auto-grow text per criterion, read-only kind label derived from the text: a line wrapped in backticks is 指令, anything else 代理判定; remove), "新增條件". Criteria are optional. Saving recomputes missing fields and backlog/ready status. Run history list.
- **Diff**: base → branch, +/− counts, comment count, mode label; file tabs (letter + name + comment dot); sticky file header; line grid `48px 44px 18px max-content`; click a line to comment; comment cards with avatar + name + delete.
- **Preview**: reload, state dot, URL, desktop/mobile toggle (frame 100% / 390px, width transition 160ms), Share to team.
- **Terminal**: shell segmented (PowerShell / cmd / Git Bash — prompt changes PS> / C:\> / $), worktree path, blocks: prompt + command (ellipsis) + time + copy (pinned right), output, exit code (green/red).

### 5. Board
Superseded by「看板改版」at the end of this file (list / kanban / table / calendar / timeline share one toolbar and one task store). The original v0 spec is kept below for reference.
- **List**: sticky column header; groups by status with rotating chevron + "+" on backlog/ready; rows 36px grid (wide ≥820px: `10px 60px minmax(160px,1fr) 112px 120px 72px 120px 64px`, column-gap 12; narrow drops agent + updated). Cells: needs dot, key, title (+ draft pill, blocked-by), run status (pulse when live, ellipsis), agent logo + id, acceptance mini bar (28×3px, green or red if any failed) + n/m, assignee avatar + name, updated.
- **Columns**: 248px columns, bg `--o18191d`, radius 8; cards: key, needs dot, draft pill, assignee avatar; 2-line title; meta row: agent logo + status + acceptance bar.

### 6. Needs You
Max-width 860. Grouped by type (權限請求 / 驗收超過重試上限 / 計畫關卡 / 審查關卡) with icon + count. Row: grid `minmax(0,1fr) auto`: line 1 key (56px) + title (semibold, click opens task); line 2 (indent 66px) agent logo + summary + detail code / meta; permission and verification rows add action buttons below; right column: relative time + "前往… ›". Empty: green check circle + "全部處理完了".

### 7. New Task dialog
Top-aligned (10vh), 680px, radius 12. Header 新增任務 + next key + close. Title input 18/550 borderless; spec textarea; chips: Repo (popover), Assignee (avatar popover), Depends on (task list popover). Acceptance criteria (optional, starts empty): ○ + one text input (placeholder「例如：登入後看得到儀表板，或 `pnpm test`」) + read-only kind label + remove; "新增條件". A task can be Ready without criteria. Footer: status (就緒 or 待辦 + missing tags), Cancel, Create (secondary), **Create and open** (primary, Ctrl+Enter). Disabled until title.

### 8. Share popover (right-top, 380px, radius 14)
Title 分享「task title」+ close. Card: link row (link icon + mono URL + 複製 → "已複製" 1.6s) / divider / static access line (users icon + "<team> 的成員都能檢視與操作" + sub "還不是成員的人可以用 Email 邀請加入團隊"; not a menu — there is no per-task access or role). 邀請加入團隊: email input; typing a valid email adds an @ tile (72px, selected = 2px accent ring + check badge). Footer: full-width "邀請加入團隊" (disabled grey until an email is added; shows count). Invitees join the team as Member. On submit → **Invite success card** in the same right-top position (340px, no scrim): stacked avatars 52px with green check badge, "已邀請 X", "加入「task」", list of invitees, buttons 繼續邀請 / 完成 (focused). Esc/outside click closes.

### 9. Settings dialog (820×560 max)
Left nav (200px, sidebar bg): 個人（一般、通知、帳號）、團隊（執行器、代理）、安全（稽核紀錄）. Close ✕. Rows 48px with hairline dividers.
- General: theme (深色 / 淺色 / 跟隨系統, follows OS live), language (links between builds). The right panel is closed by default and tool steps are collapsed by default; neither is a setting.
- Runners: KASH-DESKTOP (Windows 11 local) and team-runner-01 (Ubuntu team) with online dot + version; pair a new runner. The terminal shell is detected automatically. Windows long paths are handled automatically and not shown in settings (see「新對話、設定、儀表板改版」).
- Agents: Claude Code, Codex, Antigravity, Grok Build — logo, status (Antigravity: 需要重新登入 + button). No default model: the composer remembers the last model used.
- Notifications: one switch, 桌面通知 (30×18, knob 14, accent when on). In-app notifications are always on.
- Account: avatar 48, email, team name input (max 32, Enter/blur commit), members stack, sign out. No team settings dialog.

## Interactions & Behavior
- Motion tokens: hover 80ms ease-out; panels/entries fade 160ms (opacity only); dismissals 80ms; easing `cubic-bezier(.2,.9,.3,1)`; press `scale(0.97)`. Respect prefers-reduced-motion (highlight moves instantly).
- **Tooltips**: custom, replaces native title. 450ms delay, instant when another tip was shown <300ms ago; placed above (flip below if no room), 8px gap, bg `--otipbg`, text `--otipfg`, 12px/16px (mono 11px for paths), padding 6×9, radius 6, max 280px, ellipsis. Hide on pointerdown/scroll/blur.
- Keyboard: Ctrl+K search, Ctrl+, settings, Esc closes topmost layer (popover → dialog → menu), Ctrl+Enter submits New Task / Spec save, arrow keys on splitters.
- Focus ring: `2px solid --o7fb0fa`, offset 1px, only on :focus-visible.
- Theme: `data-theme` on <html>, persisted `orbis-theme` (dark | light | system).
- Loading: workspace skeleton bars; preview loading progress bar; empty states are short single lines.

## State Management (minimum)
- tasks: key, title, status (backlog|ready|planning|plan_gate|running|verifying|review_gate|pr_open|done), assignee, dependsOn/blockedBy, repo, spec[], ac[] {id, kind: command|agent (derived from the text), desc, cmd, result: pending|passed|failed}, missing[].
- runs: id, task, agent, model, depth (fast|std|deep), policy (yolo|auto|manual, default yolo), planFirst (bool), runner (local|team), branch, base, status, gate, events[] (typed: user, msg, thought, tool, plan, verify, perm, status, wt, preview, rundiff, pr, switch), queue, usage {ctx, win, cost}, startedAt/endedAt, files, comments.
- team invites: [{email, invitedBy, expiresAt}] (no per-task members, roles or general access). Roles: owner | member.
- UI: view, active task, rightTab, panelOpen, split, sideW, expanded{}, popover anchor/state, dialogs (newTask, settings, share, inviteDone), theme, team name.
- Model catalog should come from an API: {agentId, tool, vendor, cliId, models:[{id, name, tag, effort: adjustable|fixed:<level>|none}], signedIn}.

## Design Tokens
Dark is default; light overrides on `html[data-theme="light"]`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--o121316` | #121316 | #ffffff | App background / main column |
| `--oside` | #121316 | #f3f4f6 | Sidebar background |
| `--o16171a` | #16171a | #ffffff | Stream / board background |
| `--o131417` | #131417 | #fafbfe | Right panel background |
| `--opop` | #1a1b1f | #ffffff | Popover / dialog surface |
| `--o1c1e22` | #1c1e22 | #eff1f5 | Subtle fill (chips, inputs, hover) |
| `--o22242a` | #22242a | #e8eaf0 | Secondary button / pill fill |
| `--o24262b` | #24262b | #e7e9ee | Chip hover |
| `--o2b2e34` | #2b2e34 | #dfe2e8 | Secondary button hover |
| `--o1e2024` | #1e2024 | #edeff3 | Hairline divider |
| `--o26292e` | #26292e | #e4e7ec | Popover border / input border |
| `--o34373d` | #34373d | #d6d9df | Input focus border |
| `--osel` | #222429 | #e4e6ea | Selected sidebar row |
| `--oe8e9eb` | #e8e9eb | #1b1c1e | Text primary |
| `--o8b9098` | #8b9098 | #6a6f77 | Text muted |
| `--o4c5058` | #4c5058 | #a7abb3 | Dashed empty avatar |
| `--o7fb0fa` | #7fb0fa | #2f6fd6 | Accent (links, focus, selected) |
| `--o9cc3ff` | #9cc3ff | #2563c9 | Accent text on tint |
| `--o4fb86a` | #4fb86a | #2e8a48 | Success |
| `--oef6b62` | #ef6b62 | #cf3f36 | Danger |
| `--od9a845` | #d9a845 | #9a6d0c | Warning / Needs you |
| `--obtn` | #e3e4e6 | #1d1f23 | Primary button bg |
| `--obtnh` | #f4f5f7 | #383b42 | Primary button hover |
| `--obtnfg` | #16171a | #ffffff | Primary button text |
| `--otipbg` | #e8e9eb | #1d1f23 | Tooltip bg |
| `--otipfg` | #16171a | #ffffff | Tooltip text |
| `--oscrim` | rgba(0,0,0,0.55) | rgba(20,22,28,0.28) | Modal scrim |
| `--osh` | rgba(0,0,0,0.35) | rgba(0,0,0,0.12) | Shadow color |
| `--ohl` | rgba(255,255,255,0.055) | rgba(0,0,0,0.05) | Fluid hover highlight |

Other: accent tint fills `rgba(127,176,250,.08–.18)`, success tint `rgba(79,184,106,.10)`, danger tint `rgba(239,107,98,.10)`. Avatar colors: kashionz `#3a3e46`, mei-lin `#4a3e52`, chen-yu `#3b4d45` (light: `#dfe1e5`, `#e9dff0`, `#dcebe3`).

Spacing: 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32. Control heights: 24 (small), 28 (compact), 32/36 (default), 44/52 (headers). Radii: 3 (composer chips), 4 (pills), 5–6 (buttons/items), 8 (cards, inputs), 10 (popovers), 12 (composer, dialogs), 14 (share). Shadows: popover `0 12px 32px var(--osh)`, dialog `0 24px 64px var(--osh)`, tooltip `0 6px 20px var(--osh)`.

Type scale: 11 (meta/mono), 12 (secondary), 13 (body), 14 (messages, header title), 16 (page titles), 18 (new task title). Weights 400 / 550 / 600.

## Assets
- `assets/agents/claude-code.svg`, `codex.svg` (OpenAI mark, light fill — invert in light mode), `antigravity.svg`, `grok-build.svg` (light fill — invert in light mode). From lobehub/lobe-icons; Claude Code eyes filled `#141413`.
- Icons: Lucide paths inlined in the prototype (`ICONS` map) — use `lucide-react` in production.

## Files
- `Orbis Workspace ZH.dc.html` — full prototype, Traditional Chinese.
- `Orbis Workspace English.dc.html` — full prototype, English.
- `Model Picker.dc.html` — model picker + reasoning effort exploration (dark/light, all states).
- `Agent Status Card.dc.html` + `src/agent-status/*` — separate agent status card component (React + TS + Tailwind + Motion).
- `assets/agents/*` — agent logos.
- `support.js` — runtime needed to open the .dc.html files in a browser.
- `OrbisDlg.dc.html` + `orbis-dlg.js` — shared dialog component and every dialog spec (see 視窗與確認).
- `Orbis Dialogs.dc.html` — dialog gallery: every dialog in every state, zh / en.

Open the .dc.html files directly in Chrome/Edge to explore; logic lives in the `class Component` script at the bottom of each file.


---

# v0.1.0 追加（第一批：既有流程的補強）

畫面編號沿用 `v0.1.0-new-features-brief.md`。新畫面集中在共用元件 `OrbisFeatures.dc.html`（props：`lang` zh|en、`screen`、`state`、`embed` page|settings|panel|canvas、`admin`），由 ZH／EN 原型嵌入；`Orbis v0.1.0 States.dc.html` 以畫布並排每個畫面的六種狀態（一般、空的、載入中、錯誤、唯讀、窄寬度 380px）。原型內的「原型狀態」切換列可由 Tweaks 的 `stateSwitcher` 關閉。

## 共用狀態規則
- 載入中：5 列骨架（20px 圓 + 10px 條，`--o1d1f23`，1.4s 透明度脈動，reduced-motion 時靜止）。
- 錯誤：警示圖示（`--oef6b62`）+「載入失敗」+ 重試（28px 次要按鈕）。
- 空的：22px 圓形圖示 + 一行狀態文字，可附一個動作。
- 唯讀：可操作的控制項 `disabled`、opacity .45、Tooltip「只能檢視」；只限擁有者的畫面改為鎖頭 +「只有擁有者可以檢視」。
- 窄寬度：內容寬度 380px；縮排（66px／28px）歸零，表格欄寬縮小，按鈕列換行。

## 1. 權限請求
- 只在 session 的權限策略是「自動」或「逐一確認」時才會停下來問人；預設「全部允許」時只顯示一列「已自動允許」。
- 選項：允許一次（accent tint 主要）／這個 session 都允許（次要，Tooltip「這個 session 結束前，同一條指令或路徑不再詢問」）／拒絕（danger 文字）。沒有「加進專案規則」。
- 已回覆：綠勾 +「已回覆 <選項>」+ 頭像 18 + 名字 + 復原。
- 「自動」的固定規則：讀取、搜尋與工作樹內的編輯自動允許；和 `.orbis/config.toml` 的 setup、驗收指令、預覽指令完全相同的指令自動允許；其他指令、刪除、移動、連網與工作樹以外的路徑問人。沒有設定。
- 資料：`PermissionOption.kind` 新增 `allow_session`；`Run.permissionPolicy: yolo|auto|manual`（預設 `yolo`）。

## 2. 待我處理直接做驗收的決定
- 新群組「驗收超過重試上限」（alert 圖示 `--oef6b62`）。列：key、標題、時間；第二行代理 logo + 摘要 + 失敗細節 code。
- 動作：附意見再試（主要）／略過（次要）／中止（danger）。附意見就地展開 textarea（field-sizing，min 56px）+ 取消／送出並再試（內容為空時停用）。
- 權限請求列使用與 #1 相同的選項。唯讀時按鈕停用。

## 3. 任務備註的時間軸
- 任務分頁新區塊「備註」，右側 Segmented：全部／決策／自動修正。
- 每筆：20px 圓形圖示（進度 muted、決策 accent flag、自動修正 warn wrench）+ 種類 +「第 N 次」+ 時間 + 右側連結（run id 或 #PR，mono 11px，hover accent）；下一行內文 13px/1.6。節點間 1px 連線。
- 資料：`TaskNote {id, kind: progress|decision|fix, attempt?, text, at, runId?, prNumber?}`。

## 4. 工作樹的手動封存與保留期限
- 執行紀錄每列第二行顯示工作樹狀態：使用中／保留到 <日期>（warn）／已封存／已清除。
- 失敗或中止且保留中的執行：「封存工作樹」→ 就地確認「封存這個工作樹？」取消／封存。
- 失敗或中止的執行，工作樹固定保留 14 天，不提供設定。
- 資料：`Run.worktree {state: live|kept|archived|cleaned, keepUntil?}`。

## 5. 驗收條件表單
- 驗收條件是選填的，每條一行文字，沒有類型選單。整行用反引號包住的指令（例如 `` `pnpm test` ``）在工作樹執行；其他文字交給判定用的代理，有預覽時它可以開瀏覽器檢查。類型標籤（指令／代理判定）依文字自動顯示，不能點。
- 條件上方一行 muted 說明：儲存庫有驗收指令時「每次驗收都會先跑專案的驗收指令：`pnpm -w test`」；沒有時「這個專案沒有驗收指令；沒有條件時會直接進入審查」。
- 沒有「人工」條件，審查關卡不打勾。

## 6. 通知設定
- 一個 Switch「桌面通知」+ 一行說明（計畫關卡、審查關卡與停下來的執行會在桌面跳出）。App 內的通知中心一律保留。
- 不做事件 × 管道的勾選表、Email 通知、Slack、勿擾時段（用作業系統的專注模式）。
- 資料：`NotificationPrefs {desktop: boolean}`。

## 7. App 圖示
- `Orbis App Icon.dc.html`：三個方向 7a 軌道環與行星、7b 交錯的兩條軌道、7c 有缺口的 O。每個方向含 1024 母版、Windows ico 64／48／32／16（小尺寸加粗筆畫）、系統匣單色 template image（Windows 深色、macOS 淺色／深色選單列）。待選定後輸出 ico、icns 與 template PNG。
- 已輸出 `assets/app-icon/<7a|7b|7c>/`：`orbis.ico`（16–256）、`orbis.icns`（16–1024，含 @2x）、`orbis-1024.png`、`orbis-512.png`、`trayTemplate.png` 與 `trayTemplate-2x.png`（macOS template，打包時改名為 `trayTemplate@2x.png`）、`tray-light.ico` 與 `tray-dark.ico`（Windows 淺色與深色工作列）。選定方向後只保留該資料夾。

## 8. 稽核紀錄
- 設定 → 稽核紀錄（只有擁有者）。篩選：成員、動作、專案、時間（Popover 單選，選中值顯示在按鈕上）；右上匯出 CSV。
- 列：時間 mono（88px，窄 64px）｜頭像 18 + 名字 + 動作；第二行對象 mono + 專案 pill。底部「8 / 214 筆」+ 載入更多。
- 資料：`AuditEntry {id, at, actorId, category: perm|gate|run|settings|member, action, target, projectId|null}`；權限請求的回覆與自動允許都記為 `perm`。

## 9. Blob 保存期限
- 已移除，見「從簡：權限只剩 session 的模式，拿掉多餘設定」。

# v0.1.0 追加（第二批 10–12）

## 共用：狀態圖示與優先度圖示
- 狀態圖示 14px（依群組）：待辦 虛線圓、未開始 空心圓、進行中 半實心、已完成 實心 + 勾、已取消 實心 + ×。顏色由狀態自訂，限 6 個語意 token（`--o4c5058`、`--o8b9098`、`--od9a845`、`--o7fb0fa`、`--o4fb86a`、`--oef6b62`）。
- 優先度圖示 14px：緊急 紅底方塊 + 驚嘆號；高／中／低 三根長條亮起 3／2／1 根；無 三根皆淡。
- 代理階段：6px accent 圓點 + 文字（規劃、計畫關卡、執行中、驗收中、審查關卡、合併請求）；沒有時不顯示。

## 10. 狀態與代理階段兩層
- 自訂狀態已移除（見「狀態固定與長路徑」）；以下保留代理階段與看板版面的規格。
- 設定 → 狀態：五個群組（待辦、未開始、進行中、已完成、已取消），群組標題 + 任務總數 + 新增（+）。
- 列 36px：拖曳把手（同群組內拖放排序，目標列上緣 2px accent 線）、狀態圖示（點擊開 6 色色票 Popover）、名稱（點擊就地改名，Enter／Esc 結束）、預設 pill、任務數、⋯ 選單（設為預設、重新命名、刪除）。
- 刪除：預設狀態不可刪（Tooltip 說明）；有任務的狀態就地展開「N 個任務要移到」+ 其他狀態按鈕（選中為 accent 內框）+ 取消／移動並刪除。
- 看板：分組改在工具列「顯示 → 分組」選擇 狀態／代理階段（見「看板改版」）。依狀態時列上顯示代理階段 chip；依代理階段時改顯示狀態，沒有階段的任務集中在「沒有代理階段」。
- 列表與分欄的尺寸以「看板改版」為準。逾期截止日用 `--oef6b62`。
- 分欄卡片：見「看板改版」。
- 資料：`State {id, groupKey: backlog|unstarted|started|completed|cancelled, name, color, order, isDefault}`；`Task.stateId`、`Task.agentStage: planning|plan_gate|running|verifying|review_gate|pr|null`（由最新一次執行推導，唯讀）。

## 11. 任務屬性
- 任務分頁「屬性」：兩欄 grid（標籤 120px，窄 92px）。每列一顆 28px 值按鈕（hover `--o1c1e22`）開啟單選或多選 Popover（選中 accent tint + 勾）。
- 欄位：狀態、代理階段（唯讀，Tooltip「由最新一次執行決定」，執行中有脈動點）、優先度、負責人、開始日、截止日（快速選項：今天、明天、下週一、清除；完整日期選擇器於 #13 定義）。不做估計。未設定值以 muted 顯示「未設定」。
- 資料：`Task {priority: urgent|high|medium|low|none, startDate, dueDate}`。

## 12. 子任務與關係
- 子任務：標題 + 「完成數 / 總數」+ 48×3px 進度條（`--o4fb86a`）。列 32px：狀態圖示（點擊切換完成）、key、標題（完成時 muted）、代理階段、負責人（人頭像、代理 logo 或虛線空頭像）。「新增子任務」就地輸入，Enter 建立並保持輸入，Esc 結束。
- 關係：依類型分組（被封鎖、封鎖、相關、重複），列尾移除（×，hover 轉 danger）。「新增關係」就地展開：類型 Segmented + 搜尋任務 + 候選清單（最多 5 筆），點選即加入。
- 資料：`Task.parentId`；`TaskRelation {fromTaskId, toTaskId, type: blocks|related|duplicate}`（「被封鎖」是 blocks 的反向顯示）。


# v0.1.0 追加（第二批 13–23）

新畫面在 `OrbisPM.dc.html`（邏輯在 `orbis-pm.js`），props 與 `OrbisFeatures` 相同（`lang`、`screen`、`state`、`embed`），另有 `layout`、`onNew`、`onClose`。原型側欄新增：我的工作、儀表板、範本；看板改為 #13／#14 的檢視；任務分頁新增「負責人」派工設定；Ctrl+K 開指令面板。

## 13. 版面
- 版面切換：列表、分欄、表格、月曆、時間軸（帶圖示的分頁，見「看板改版」）。
- **表格**：`36px 72px minmax(220px,1fr)` + 可顯示的屬性欄（狀態 124、優先度 100、負責人 124、截止日 84）。最小寬 860px，超出時水平捲動，表頭 sticky。每格是 30px 按鈕，點擊開單選 Popover 就地修改。勾選列（accent 8% 底）後，底部浮出批次操作列（sticky，`--opop`、radius 10、陰影）：已選 N 個、狀態、優先度、負責人、標籤、封存、取消選取。
- **月曆**：週一開始，7 欄；格高 96px（窄 64px）；今天以 accent 圓底數字標示；非本月格 `--o131417`。任務 chip（優先度 + 標題，窄寬度只顯示編號）可拖曳到其他日期或右側「沒有日期」欄（200px，窄寬度移到下方）。點空白日期就地新增任務（Enter 建立，Esc 取消）。
- **時間軸**：左欄 260px（窄 150px）列出任務；右側依縮放（週 28px／月 14px／季 6px 每天）畫條，accent tint 底，完成用 success tint；拖曳條平移開始與截止日；相依以 1.25px 折線連接（前者結束到後者開始，箭頭端點 2.5px 圓）；今天 1px accent 直線。

## 14. 檢視列
- 標題即檢視名稱（下拉切換：所有任務、我的任務、本週到期）。檢視設定屬於每個人，改了就自動儲存，沒有「儲存檢視」按鈕（見「看板改版 → 檢視自動儲存」）。
- 工具列：篩選（全部符合／任一符合 + 條件勾選，按鈕顯示條件數）、顯示（分組、排序、顯示屬性、已封存，見「看板改版」）、所有專案。
- 我的工作：跨專案，依今天到期、本週、之後、沒有日期分組，列上標出專案代號。
- 資料：`ViewPref {userId, projectId, viewId, layout, filters: {match: all|any, conditions[]}, groupBy, sort: {field, dir}, columns[], showArchived}`。

## 15–16. 週期與模組
- 已移除，見「移除週期與模組」。

## 17. 收件匣
- 已移除，見「從簡：權限只剩 session 的模式，拿掉多餘設定」。

## 18. 任務類型與自訂欄位、大型任務
- 任務類型與自訂欄位已移除，見「設定精簡」。大型任務保留：有子任務的任務即為大型任務，頁面顯示子任務數、已完成與雙段進度條，派工按鈕停用。

## 19. 代理當負責人
- 負責人選擇：成員與代理並列（32px，選中 accent 內框）。選代理時展開設定：在哪裡跑、模型、推理強度、權限策略（預設全部允許）。
- 等待列：warn tint +「等待 ORB-40 完成」；條件滿足時 success tint +「條件已滿足」。右側 Switch「相依完成後自動派工」。

## 20. 儀表板
- 卡片（`--o1a1b1f`、radius 10）：依狀態群組的進度（全寬堆疊條 + 圖例）、每人的工作量（進行中 warn + 未開始 muted 雙段條）、被卡住的任務。
- 代理用量與費用（全寬，只有擁有者）：代理／成員／專案 + 7 天／30 天切換。

## 21. 封存
- 表格批次操作可封存；工具列「已封存」切換顯示（封存列 opacity .55）。完成或已取消超過 3 個月的任務自動封存，不提供設定。

## 22. 全域搜尋與指令面板
- Ctrl+K 開啟（620px、radius 12、對話框陰影、背景 scrim）。輸入框 48px；結果依任務、執行、對話、留言、Wiki 頁、技能、動作分組；↑↓ 移動選取（`--o1c1e22` 底），Enter 開啟，Esc 關閉；底部按鍵提示。

## 23. 範本
- 只保留任務範本，在新增任務對話框中管理；Prompt 範本已移除，見「設定精簡」。

## 新增 token
無。圖表只用既有語意色。

## 補完
- 新增表單（範本）：標題列「新增…」就地展開一列表單（`--o1a1b1f`、radius 10）。範本：名稱、種類（任務／Prompt）、範圍（個人／共用）。Enter 建立、Esc 取消；建立後加入對應群組。空狀態的動作也開啟同一表單。
- 大型任務：表格中標有「大型任務」pill 的任務標題可點，進入大型任務頁。
- 時間軸刻度：週＝每天一格（每週第一天顯示日期）；月＝每週一格；季＝每月一格。

# v0.1.0 追加（第三至五批 24–37）

畫面同樣由 `OrbisPM.dc.html` 呈現，邏輯在 `orbis-more.js`。新增的共用區塊（`panes`）：標題列、段落（可含連結 chip 與 `[[ ]]` wikilink）、屬性表、程式碼／差異、提示列（tint 底 + 動作）、瀏覽器畫面框、樹狀清單、Graph（SVG 節點與連線）、短清單、多行輸入、按鈕列。窗格以 flex-wrap 排列，寬度不足時右側窗格移到下方。
原型側欄新增：報告、對話、Wiki、技能；任務分頁新增「Wiki 中的提及」。

## 24. 團隊總覽
- 期間（今天、本週、本月、自訂）、專案、排序（完成、被卡住、費用）三組 Segmented。每人一列：頭像、名字、完成、進行中、被卡住（>0 時 warn pill）、PR、關卡核准與退回、費用。不做分數或排名。點列進入個人明細。

## 25. 個人明細
- AI 摘要：每句附來源 chip（任務、PR、執行）；右上「重新產生」與歷史版本 Segmented。沒有團隊執行器時改為 warn 提示「只有統計，沒有 AI 摘要」。
- 類別：完成的任務、進行中、合併請求、關卡、執行與對話（對話只顯示次數）、Wiki 編輯與留言。

## 26–27. 報告的設定與權限
- 已移除，見「從簡：權限只剩 session 的模式，拿掉多餘設定」。

## 28. 對話
- 清單：未讀藍點、工作位置 pill、最後活動時間；「新對話」Ctrl N。
- 新對話：見「新對話、設定、儀表板改版」——輸入框置中，送出後滑到對話串底部。
- 收尾：依工作位置列出可用動作（工作樹：Commit、Push 並開合併請求、本機合併、捨棄；本機資料夾：Commit、還原修改；暫存：下載檔案、捨棄）；分享給團隊（唯讀）Switch；轉成任務（代理草擬標題、規格、驗收條件 → 建立並進入審查關卡）；整理成技能。

## 29. Wiki
- 三窗格：樹（200px；收藏、資料夾可收合、可拖曳）、編輯器（屬性表、wikilink、任務 chip、多人游標以成員色標出、`[[` 自動完成清單分頁面／任務／技能、嵌入與已刪除頁面的嵌入提示、代理提出修改的提示列）、右側（反向連結、未連結的提及＋連結、大綱）。
- Graph view：整個空間／這一頁，依資料夾篩選；目前頁 accent、任務 warn、其他 muted，未符合者淡化。
- 版本紀錄：選兩版比較（差異以 success／danger tint 標示）並可還原。Wiki 不設權限，團隊成員都能檢視與編輯；不做私人頁與 Git 同步。匯出 Markdown 在標題列。

## 30. 技能
- 技能庫：團隊／我的 + 分類；列上版本 pill、含腳本 warn pill、加入專案數。
- 技能頁：說明、檔案樹 + 內容預覽、版本、加入的專案（有新版時「更新」）、最近載入的執行；編輯、加入專案、提交到儲存庫（預覽將開出的合併請求）。
- 不做核准與掃描：新版本儲存後就能使用，Team Runner 上也一樣。上傳：選擇資料夾或 zip、名稱即時驗證（小寫英文、數字、連字號，附一鍵修正）、SKILL.md 編輯。

## 31. 個人存取權杖與外部連線
- 已移除：對外 MCP 與個人存取權杖延後到 v0.1.0 之後，見「從簡：權限只剩 session 的模式，拿掉多餘設定」。

## 32–34、37. 執行環境
- 已移除，見「從簡：權限只剩 session 的模式，拿掉多餘設定」。

## 35. best-of-N
- 派工：1–4 個 Segmented，每個執行列出代理與模型。比較：並排卡片（驗收、費用、時間、變更、差異摘要、最後的回覆）＋「選這個」→ 進入審查關卡。

## 36. 即時觀看代理的瀏覽器
- 左側畫面框（網址列、即時紅點、每秒 2 張、游標位置）；右側操作紀錄（完成 ✓、進行中 accent）；結束後列出保留的截圖。

# 資訊架構調整
- 側欄導覽只保留：看板、待我處理、Wiki、技能。我的工作、收件匣、儀表板、範本、報告、對話不再是導覽項目。
- 側欄「對話」是和任務分組同一層的可收合分組，放在任務分組下方；新對話按鈕在側欄頂端（品牌列下方，Ctrl N）；列出自己的對話，依最後活動排序，未讀以 6px accent 點與 550 字重標示，圖示為目前使用的代理 logo。
- 看板標題列分頁：任務、儀表板。分頁高 40px，選中 550 字重 + 2px 底線。寬度小於 860px 或窄寬度時收合成一顆目前分頁的下拉按鈕（Popover 選單）。
- 我的工作：不另開頁，使用篩選中的「指派給我」，工具列新增「所有專案」切換（跨專案列出，列上顯示專案代號）。
- 報告：儀表板中的分頁（概覽、報告）。擁有者看得到所有人，成員只看得到自己。
- 範本：只保留任務範本，在新增任務對話框中選用與管理（見「設定精簡」）。

# 視窗與確認（第 1 輪：共用框架與專案管理）

## 共用對話框（規格在 `orbis-dlg.js`，由 `OrbisDlg.dc.html` 呈現）
- 外觀沿用新增任務：頂端對齊（10vh）、圓角 12、`--opop`、對話框陰影、scrim。寬度：建立與編輯 480／560／680；確認 420。標題 15/550 + 關閉。
- 欄位種類：文字、多行（自動長高 76–280px）、Popover 單選（可搜尋）、日期（月曆 Popover，週一開始，今天 accent，快速選項 今天／下週一／清除）、Segmented、Switch、多選 chip、可增減列（篩選條件、選項編輯）。必填標紅色 *。
- 狀態：欄位錯誤就地顯示在欄位下方（alert 圖示 + danger 文字，輸入框紅框）；必填未完成時送出停用（opacity .45）；送出中按鈕顯示旋轉圖示與「送出中」並鎖住欄位；伺服器錯誤在視窗內上方一行（danger tint）；有未儲存修改時按 Esc 或點 scrim，先出現「要捨棄未儲存的修改嗎？」（繼續編輯／捨棄）。
- 鍵盤：開啟時游標在第一個欄位；Ctrl+Enter 送出；Esc 依序關閉 Popover、捨棄確認、視窗。
- 破壞性確認（刪除、封存、拒絕）：420 寬，送出按鈕 danger tint + danger 文字，內文列出受影響的數量。
- 原型中切到「錯誤」狀態後送出，可看到伺服器錯誤。

## 本輪的視窗
- 檢視：篩選條件編輯器（符合全部／任一；每列 欄位、運算子、值，可增減；值必填）。分組、排序、顯示欄位沿用工具列 Popover。
- 批次修改：表格多選後，每個操作開啟對應選擇（狀態、優先度、負責人含代理、標籤），封存開啟確認並顯示任務數。
- 任務範本：在新增任務對話框中存成範本、編輯、刪除（見「設定精簡」）。


# 視窗與確認（第 2 輪：所有入口）

這一輪把每顆按鈕都接到對應的視窗、選單或確認，原型中都能實際點開。畫面內容與資訊架構不變，只補細節。

## 共用元件
- **`OrbisDlg.dc.html`**：所有視窗共用的呈現元件。OrbisPM、OrbisFeatures、ZH／EN 工作區都以 `<dc-import name="OrbisDlg" k x n st on-close on-flash>` 開啟；欄位狀態留在元件內，宿主只存 `{k, x, n}`。`x.after(v)` 在送出成功後由宿主更新畫面（例如加入清單、切換狀態），可接著開下一個視窗（例：新增技能 → 編輯器）。
- **`orbis-dlg.js`**：視窗規格（`D.<key>`）＋渲染器（`render`）＋畫廊目錄（`catalog`）。規格欄位：`w`（480／560／680；確認 420）、`title`、`submit` 或 `submitOf(v)`、`danger`、`init`、`fields`（陣列或 `v => 陣列`）、`validate(v) → {欄位: 訊息}`、`fix(v, 變更)`（連動欄位，例如換代理時重設模型）、`loading {text, ms}`（開啟時先顯示產生中）、`result(v)`（送出後在同一個視窗顯示結果）、`after(v)`、`done(v)`（toast 文字）、`bad`／`sample`（畫廊用的錯誤值與範例值）。
- **欄位種類**：文字、多行（自動長高 76–280px）、Popover 單選（可搜尋）、日期（月曆 Popover，週一開始，今天 accent，快速選項 今天／明天／下週一／清除）、Segmented、單選清單（含一行說明）、Switch、多選 chip、可增減列（儲存格可為輸入、Segmented 或 Popover 單選；可設最少／最多列數）、提示列（warn／danger／success／accent／muted tint）、差異（+／− 以 success／danger tint）、權杖卡（mono + 複製，1.6 秒顯示「已複製」）、鍵值表、檔案（虛線拖放區 → 選定後顯示檔名、大小、移除）、技能編輯器（左側檔案樹、右側 mono 內容、新增檔案）、權限列（成員或角色 × 可檢視／可留言／可編輯，繼承列顯示「繼承自 X」並可覆寫或改回繼承）、測試連線（按鈕旋轉 → 成功綠勾或失敗紅字）。
- **狀態**（每個視窗都有，`Orbis Dialogs.dc.html` 並排畫出）：一般、必填未完成時送出停用（opacity .45）、欄位驗證錯誤（就地顯示在欄位下方：alert 圖示 + danger 文字，輸入框紅框；必填未填在按 Ctrl+Enter 後顯示「必填」或欄位自己的訊息）、送出中（旋轉圖示 +「送出中」，欄位鎖住）、伺服器錯誤（視窗內上方一行 danger tint）、有未儲存修改時按 Esc 或點 scrim（「要捨棄未儲存的修改嗎？」繼續編輯／捨棄）。另有兩種：代理產生中（轉成任務、從執行整理成技能：shimmer 文字 + 骨架列，產生完成後游標移到第一欄）、完成後的結果（建立權杖：送出鈕改為「完成」，沒有取消）。
- **鍵盤**：開啟時游標在第一個欄位（沒有欄位時在送出鈕）；Ctrl+Enter 送出；Esc 依序關閉 Popover → 捨棄確認 → 視窗；Popover 內的搜尋框自動取得焦點。
- **原型如何看到伺服器錯誤**：OrbisPM／OrbisFeatures 的「原型狀態」切到「錯誤」後送出；工作區用 Tweaks 的 `dlgState = error`（新增任務對話框也套用）。
- **Popover 選單（OrbisPM）**：`c.menu(e, id)` 以觸發按鈕定位（下方空間不足時往上），`c.menus[id]` 每次渲染重新計算。項目：標題列、分隔線、錯誤列、一般項（圖示、單行說明、快捷鍵、勾選、danger、停用 + Tooltip）、`keep` 讓多選時不關閉。↑↓ 移動焦點，Esc 關閉。
- **工作區 Popover（`openMp`）擴充**：停用項（opacity .45 + Tooltip）、`keep` 多選不關閉（`regen` 重算勾選）、`cal` 在選單下方加月曆（`min` 之前的日期淡化且不可選）。
- **新增區塊**：OrbisPM 的樹狀清單支援就地輸入（Enter 建立、Esc 取消、失焦時有內容就建立；同名時紅框 + 錯誤列）與列尾「⋯」選單；`Chips` 區塊（28px、radius 3，與輸入框 chip 相同）。
- **畫廊**：`Orbis Dialogs.dc.html` 左側依區域列出全部視窗與寬度，右側並排畫出該視窗適用的狀態；可切換 zh／en。

## 專案管理
| 視窗 | 寬 | 欄位（* 必填） | 驗證與規則 | 入口 |
|---|---|---|---|---|
| 篩選條件 | 680 | 符合（全部／任一）、條件列（欄位 Popover、運算子、值） | 每列都要有值 | 工具列「篩選」→ 編輯條件… |
| 批次修改 | 480 | 對應欄位*（狀態、優先度、負責人含代理、標籤） | — | 表格多選後的操作列 |
| 封存任務（批次） | 420 danger | — | 顯示任務數 | 操作列「封存」 |
| 封存／還原任務 | 420 | — | 封存為 danger；執行中的 run 會先中止（warn 提示） | 任務分頁右上「⋯」 |
| 大型任務的連結 | 480 | 儲存庫規格、Wiki 頁（都可搜尋，可不連結） | — | 大型任務頁標題列「連結」 |
| 新增關係 | 480 | 種類（被封鎖、封鎖、相關、重複）、任務*（可搜尋） | 已有相同關係時錯誤 | 任務分頁 → 關係「新增關係」 |
| 指派給代理 | 560 | 代理*（需要重新登入的停用）、在哪裡跑、模型*（依代理）、推理強度（不支援的模型停用、固定的自動帶入）、權限策略（預設全部允許） | 換代理時模型重設 | 負責人選代理；任務「⋯」→ 指派給代理… |
| 相依完成後自動派工 | 560 | 同上，標題與送出鈕不同，上方提示「ORB-40 完成後…」 | 同上 | 負責人區的 Switch；任務「⋯」 |
| 派工（best-of-N） | 680 | 代理與模型列（1–4 列，Popover）、在哪裡跑、權限策略（Segmented，預設全部允許）、先出計畫（Switch，預設關閉）、技能（多選，超過 6 個 warn） | 不能有重複的代理與模型組合；第 4 列後「新增一組」停用 | 派工頁、任務「⋯」→ 派工… |
| 選定執行結果 | 420 | — | 說明其他執行的工作樹保留 14 天 | 比較畫面「選這個」 |
| 存成／編輯任務範本 | 680 | 名稱*、範圍（個人／團隊共用）、規格*；存成範本時一併存入目前的驗收條件 | 和既有範本同名 | 新增任務對話框「範本 ▾」 |
| 刪除範本 | 420 danger | — | 已建立的任務不受影響 | 新增任務對話框「範本 ▾」 |

**任務屬性**：開始日與截止日的 Popover 下方加完整月曆（截止日早於開始日的日期淡化不可選）；優先度沿用單選 Popover。**子任務**沿用就地新增列。

**新增任務對話框**新增：標題列「範本 ▾」（不使用範本、各範本附範圍與段數，以及 把目前內容存成範本…、選定範本時的 編輯…／刪除…），選定後帶入規格與驗收條件；chip 列新增優先度、開始日、截止日（Popover 含月曆）、父任務。狀態：標題未填時 Ctrl+Enter 顯示「必填」；截止日早於開始日時截止日 chip 紅框 + 錯誤列並停用建立；送出中「建立中」；伺服器錯誤在內容上方一行；有修改時 Esc、點 scrim 或按取消都會先確認。

**輸入框**：chip 列最左新增「技能 N」（Popover 多選不關閉，超過 6 個顯示 warn 點與警告列；管理技能…）。

**指令面板**：沿用 #22，沒有結果時顯示空狀態。

## 報告
| 視窗 | 寬 | 欄位 | 驗證與規則 | 入口 |
|---|---|---|---|---|
| 匯出 | Popover | Markdown、CSV、存成 Wiki 頁… | — | 報告與報告設定標題列「匯出 ▾」 |
| 存成 Wiki 頁 | 480 | 空間*、資料夾*（依空間）、頁面名稱* | 資料夾中已有同名頁面 | 匯出選單 |
| 重新產生摘要 | 420 | — | 顯示使用的執行器、模型與預估費用；目前版本保留在歷史版本 | 個人報告「重新產生」 |
| 摘要的歷史版本 | Popover | 最新、10/18、10/11（時間與產生者） | — | 「版本 ▾」 |


## 對話
- **新對話**：直接輸入第一則訊息；下方 chip 列：執行位置、代理、模型、推理強度、權限策略（預設全部允許，不限執行位置）、工作位置、技能，各自開 Popover。規則：本機資料夾只能在我的電腦跑；Haiku 5.5 推理強度固定、Grok 不支援；需要重新登入的代理停用。訊息為空時「開始」停用。
- **工作位置 Popover**：儲存庫的新工作樹（儲存庫清單）／本機資料夾（用過的資料夾 + 選擇資料夾…，直接開系統的資料夾選擇器，不需要先加入允許清單）／空白的暫存資料夾。

| 視窗 | 寬 | 欄位 | 驗證與規則 |
|---|---|---|---|
| Commit | 560 | 訊息*（mono，預填代理草稿）＋變更檔案列表 | 第一行最多 72 字元 |
| Push 並開合併請求 | 680 | 標題*、說明（mono）、建立為草稿 | 顯示來源與目標分支 |
| 本機合併 | 420 | — | 合併後工作樹封存 |
| 捨棄／還原修改 | 420 danger | — | 說明會刪除的檔案數，無法復原 |
| 轉成任務 | 680 | 先顯示「claude-code 正在草擬任務」；完成後：標題*、規格*、驗收條件（選填，可增減）、專案*、狀態 | — |
| 分享對話 | 420 | 只有自己／團隊可檢視（單選清單） | — |
| 整理成技能 | 680 | 先顯示「代理正在把這次執行整理成技能」，再進入技能編輯器 | 同技能編輯器 |

收尾頁每個動作完成後該列右側顯示「完成」並收起按鈕；暫存資料夾的「下載檔案」直接下載。

## Wiki
- **樹狀清單**：團隊標題「+」→ 新頁面／新資料夾，在目標資料夾頂端就地輸入名稱；每列「⋯」：頁面 → 重新命名（就地）、移動…、刪除…；資料夾 → 新頁面、新資料夾、重新命名、刪除…。同一資料夾內同名時紅框 +「這個資料夾已有同名的項目」。
- **頁面**：標題列「⋯」→ 新增屬性…、新增頁面檢視…、提交成儲存庫規格…、移動…、刪除…；屬性表下方「新增屬性」；「留言」切換右側留言串（可送出）；`[[` 自動完成的項目可插入。標題列：Graph、匯出。

| 視窗 | 寬 | 欄位 | 驗證與規則 |
|---|---|---|---|
| 移動 | 480 | 移到*（資料夾，可搜尋） | 已經在這個資料夾 |
| 刪除頁面 | 420 danger | — | 有反向連結時 warn 提示並列出連到這頁的頁面；30 天內可從垃圾桶還原 |
| 新增屬性 | 480 | 名稱*、型別（文字、數字、日期、成員、標籤、是否、連結） | 這頁已有同名屬性 |
| 新增頁面檢視 | 560 | 名稱*、版面（表格、看板、清單、月曆）、來源*、分組 | 已有同名檢視 |
| 還原版本 | 420 | — | 目前內容存成新版本 |
| 匯出 Markdown | 480 | 範圍、包含附件（匯出成 Markdown .zip，wikilink 轉成相對連結） | — |
| 拒絕代理的修改 | 420 danger | 原因（選填，回覆給代理） | 逐頁接受或拒絕，可復原；超過一頁待處理時有「全部接受」 |
| 提交成儲存庫規格 | 560 | 儲存庫*、路徑*（mono）＋將開出的分支、標題、檔案 | 路徑要以 .md 結尾 |

## 技能
| 視窗 | 寬 | 欄位 | 驗證與規則 |
|---|---|---|---|
| 新增技能 | 680 | 來源（上傳資料夾或 zip／從空白開始／從 GitHub 同步）；上傳：檔案*；空白：名稱*；GitHub：儲存庫*、路徑*、分支或標籤 | 名稱只能用小寫英文、數字與連字號；已有同名技能；GitHub 路徑填資料夾不含 SKILL.md。上傳與空白送出後進入編輯器 |
| 上傳新版本 | 560 | 檔案*、變更說明 | 只能上傳資料夾或 .zip |
| 技能編輯器 | 680 | 左側檔案樹（新增檔案）、右側內容 | SKILL.md 即時檢查：開頭要有 --- 包住的 name 與 description；name 規則與長度；description 不能空白、最多 1024 字。錯誤時檔案樹 SKILL.md 標紅點、內容框紅框；正確時顯示「名稱與描述符合規則」 |
| 加入專案 | 480 | 專案*（已加入的停用並標版本）、版本*（預設最新） | — |
| 更新到新版本 | 560 | 和目前版本的差異 | 進行中的執行下次啟動時載入 |
| 提交到儲存庫 | 680 | 儲存庫*、寫入路徑*＋將開出的分支、標題、檔案列表 | 路徑要以 / 結尾 |

- **技能開關選單**：派工視窗的技能多選、新對話的技能 chip、輸入框的技能 chip。

## 帳號與外部連線
| 視窗 | 寬 | 欄位 | 驗證與規則 |
|---|---|---|---|

## 執行環境與其他
| 視窗 | 寬 | 欄位 | 驗證與規則 |
|---|---|---|---|
| 封存工作樹 | 420 danger | — | 分支與執行紀錄保留 |
| 匯出稽核紀錄 | 480 | 期間、格式（CSV／JSON）、套用目前的篩選＋筆數 | — |

- **best-of-N**：派工頁列出目前的組合；「編輯」與「同時派工」開派工視窗，送出 2 組以上後進入比較畫面；「選這個」開選定確認。

# 移除週期與模組
Orbis 的目標團隊是 2–10 人，任務多由代理執行、完成節奏不規律，固定期間的週期與另一層模組分組都和既有功能重疊，因此拿掉，只留必要的分組方式。
- **拿掉的入口與畫面**：看板標題列只剩 任務、儀表板（收件匣於 2026-10-26 移除）；週期頁、結束週期、模組頁、新增與編輯週期、新增與編輯模組的視窗都移除。
- **拿掉的欄位**：任務屬性、表格欄、批次修改、新增任務 chip 中的週期與模組；`Task` 不再有 `cycleId`、`moduleIds`。
- **改成其他做法**：
  - 依時間看進度：報告的期間改為 今天、本週、本月、自訂；儀表板拿掉 Burndown，保留依狀態群組的進度、每人的工作量、被卡住的任務、代理用量。
  - 依功能區塊歸類：用**大型任務**（子任務、完成數、雙段進度條）。大型任務頁標題列新增「連結」，可連到儲存庫規格與 Wiki 頁，連結以 chip 顯示在進度條下方；需要橫向歸類時用標籤。
- Wiki 範例內容中原本的「週期切換」是帳務的計費期間，改稱「帳期」，避免和已移除的功能混淆。

# 對話畫面
點側欄「對話」分組中的一列（或對話清單的一列），開啟對話本身，不再直接進入收尾頁。
- **版面**：沿用 Run Workspace——同樣的標題列、事件流（使用者訊息、代理訊息、思考、工具群組、系統事件、尾列）、輸入框與右側面板。對話不屬於任何任務，所以不出現在任務分組與看板；側欄中目前開啟的對話以 `--osel` 標示，開啟後未讀點消失。
- **標題列**：狀態點 + 對話標題 + 執行狀態（新增「待回覆」muted：代理已回覆、等使用者的下一則訊息；送出後變「執行中」，回覆完成再回到「待回覆」）。右側：**收尾**按鈕（listChecks 圖示，開啟右側面板的收尾分頁；面板已在收尾分頁時按鈕底色 `--o1e2024`）、分享（開「分享對話」視窗：只有自己／團隊可檢視）、面板切換。只有執行中時才顯示「中止執行」。
- **右側面板**：分頁改為 收尾、差異、預覽、終端機（任務才有「任務」分頁；從對話切回任務時自動回到任務分頁）。收尾分頁內容即原本的收尾頁（轉成任務、整理成技能、變更動作列、分享），依對話的工作位置列出動作，完成狀態按對話分開記錄；不顯示原型用的工作位置切換。
- **輸入框上方一列**：工作位置路徑（工作樹 `~\.orbis\wt\conv-c1`、暫存 `~\.orbis\tmp\conv-c2`、本機資料夾 `C:\Users\kash\scripts`），只有工作樹顯示分支；路徑選單與任務相同。
- **開始新對話**：新對話頁按送出（或 Enter）後建立對話並直接開啟對話串，輸入框以動畫移到底部（見「新對話、設定、儀表板改版」）。標題取第一則訊息的第一行（超過 40 字截斷）。
- **側欄分組的收合**：對話分組和任務分組用同一套樣式與行為——標題 28px、12px muted 文字 + mono 數量、chevron 緊接在標題文字右邊（gap 6px，收合 0°、展開 90°，160ms）、整列可點並帶 `aria-expanded`；收合狀態一起記在 `sideClosed`；搜尋時分組自動展開、只列出符合的項目，沒有符合時整個分組隱藏。對話分組的「+」（新對話）位在 chevron 左側。
- **側欄排序**：對話分組依最後活動排序（新訊息、代理回覆都會更新），新建立的對話排在最上方；分組標題的數量依實際對話數。
- **範例**：c1 工作樹（claude-code Sonnet 5.5，改了 `text.ts` 並跑測試）、c2 暫存資料夾（codex，產生 `q4-billing.md`）、c3 本機資料夾（claude-code Haiku 5.5，產生 `clean-downloads.ps1` 並以 `-WhatIf` 預覽）。
- **資料**：`Conversation {id, title, location: {kind: worktree|local|scratch, path, repo?, branch?}, runId, unread, sharedWithTeam}`；對話的執行狀態多一個 `idle`（待回覆）。

# 側欄精簡與放大
- **只留「進行中」一組任務**：規劃、計畫關卡、執行中、驗收中、審查關卡、合併請求中的任務合成一組，依最後活動排序（狀態點區分）；就緒、待辦、完成只在看板。側欄從 10 塊變成 6 塊（導覽 4 + 進行中 + 對話）。
- **放大**：寬度預設 280px（可拖曳 220–400px；儲存鍵改為 `orbis-side-w2`，舊的 252px 設定不再沿用）；導覽、任務、對話列高 34px、文字 14px、圖示 16px；分組標題 13px、數量 12px；搜尋框 34px。
- **新對話按鈕**：和搜尋一起放在品牌列下方，樣式與導覽列相同（見「側欄、狀態、Wiki、技能改版」）；對話分組標題不再有「+」。
- **對話圖示**：改成這段對話目前使用的代理 logo（claude-code、codex、antigravity、grok-build），在對話中切換模型時跟著改；滑過顯示代理與模型。

# 設定精簡
- **移除任務類型與自訂欄位**：設定頁、新增類型與自訂欄位的視窗、任務屬性中的類型與自訂欄位、篩選條件中的自訂欄位、新增任務的類型 chip 都拿掉。需要分類時用標籤；大型任務改為「有子任務的任務」，不再是一種類型。`Task` 不再有 `typeId`、`customFields`。
- **移除 Prompt 範本**：輸入框的「插入 prompt 範本」與設定中的範本頁拿掉；可重用的代理指示改用技能。
- **任務範本改在新增任務對話框管理**：標題列「範本 ▾」列出範本（範圍、規格段數、驗收條件數）；「把目前內容存成範本…」開存成任務範本視窗（名稱、個人／團隊共用、規格，目前的驗收條件一起存入）；選定範本時多出「編輯…」與「刪除…」。
- **設定導覽分組**（2026-10-26 再精簡為 6 項，見「從簡：權限只剩 session 的模式，拿掉多餘設定」）：
  - 個人：一般、通知、帳號
  - 團隊：執行器、代理
  - 安全：稽核紀錄
  - 分組標題 11px muted，置於各組項目上方。

# 側欄、狀態、Wiki、技能改版

## 側欄
- 品牌列下方依序是 **搜尋**（Ctrl K）與 **新對話**（Ctrl N），兩列與導覽列同樣式，不另加外框或底色。
- 搜尋改為按鈕，按下開啟 Ctrl+K 指令面板（任務、執行、對話、留言、Wiki 頁、技能、動作）；側欄不再有輸入框。

## 狀態固定與長路徑
- **狀態固定為五個**：待辦、就緒、進行中、完成、已取消（群組 backlog／unstarted／started／completed／cancelled）。原本的待整理、已排程、審查中、重複併入對應狀態；審查、合併請求等由代理階段表示（規劃、計畫關卡、執行中、驗收中、審查關卡、合併請求，自動推導、唯讀）。
- 看板表格、月曆、時間軸、任務屬性、批次修改都使用這五個狀態；設定中的「狀態」頁與新增／編輯／刪除狀態的視窗已移除。
- **Windows 長路徑**：設定不顯示這一項，系統自動處理（路徑超過 260 字元時改用長路徑格式）。只有偵測到 Windows 關閉長路徑支援時，才在派工或執行失敗的訊息中說明開啟方式。

## Wiki（Notion 風格）
版面改為三欄：Wiki 側欄、頁面、可開關的留言欄。原本的屬性卡片、右側反向連結與大綱欄、標題列上的一排按鈕都收進頁面本身或「⋯」選單。
- **Wiki 側欄**（248px）：最上方「新頁面」，下面是可收合的 收藏、團隊空間、頁面檢視；分組標題 12px muted + chevron，右側「+」（團隊空間開 新頁面／新資料夾 選單）。列 30px、14px：資料夾有 chevron 與開合的資料夾圖示，目前頁面 `--osel` + 550；滑過列才顯示「⋯」（頁面：加入或移出收藏、重新命名、移動、刪除；資料夾：新頁面、新資料夾、重新命名、刪除）。就地新增與重新命名的規則不變。
- **頁面標題列**（48px）：麵包屑（空間 › 資料夾 › 頁面）；右側正在編輯的成員頭像（外圈為游標顏色）、留言（數量，切換留言欄）、收藏星號（收藏時 warn 色）、「⋯」（版本紀錄、Graph、新增屬性、新增頁面檢視、提交成儲存庫規格、匯出 Markdown、移動、刪除）。
- **格式工具列**（44px，置中，可換行）：文字樣式選單（內文、標題 1–3）、粗體、斜體、底線、刪除線、項目清單、編號清單、待辦清單、引言、程式碼、連結（開 `[[` 清單）、表格、圖片；切換類按鈕以 `aria-pressed` 與底色表示狀態。
- **頁面內容**（最寬 720px，置中，上下留白 48／96px）：48px 頁面圖示、32px／600 標題、編輯者與「N 個反向連結」（捲到頁尾）；屬性表為兩欄表格（1px 框線、圓角 6），最後一列「新增屬性」；內文 15px／1.75，H2 20px／600；待辦項目可勾選（完成時刪除線 + muted）；提示區塊（`--o1a1b1f`、圓角 8、圖示）；程式碼區塊；嵌入頁面為可點的框線卡片，頁面已刪除時停用；代理提出修改為 accent tint 提示 +「檢視」。多人游標以成員色 2px 直線 + 名字標籤顯示。
- **頁尾**：反向連結（可點的頁面 chip）與未連結的提及（連結按鈕）。
- **留言欄**（300px）：留言串、輸入框、送出（空白時停用）；窄寬度時不顯示側欄與留言欄。

## 技能（簡化）
- **清單頁**：標題「技能」+ 全部／我的；右上「新增技能」；搜尋框；每個技能一列（36px 圖示、名稱 14px／550、一行說明），右側「預設啟用」開關。點列進入技能頁。版本、含腳本、專案數等細節移到技能頁。
- **技能頁**（最寬 800px）：「所有技能」返回、名稱與版本；右上「已啟用」切換與「⋯」（編輯、上傳新版本、加入專案、提交到儲存庫）；說明與建立者、版本、更新日、使用的專案數；說明內容（SKILL.md 的使用時機與步驟）；檔案清單（點「檢視」展開內容）；專案（有新版時「更新」）。

# 看板改版（參考 Notion、Plane、Asana）

目標：像 Asana 的「我的任務／專案清單」一樣一眼看完，像 Plane 一樣用同一組篩選與顯示設定切換版面，視覺像 Notion 一樣安靜（少框線、少底色、滑過才出現次要按鈕）。列表、分欄、表格、月曆、時間軸共用同一份任務資料，任一版面改動後其他版面立即反映。

## 標題列與工具列
- 第一列：檢視名稱（16px／550，下拉切換檢視）；右側主要按鈕「新增任務」。
- 第二列左側：版面分頁 **列表／分欄／表格／月曆／時間軸**，每個分頁 28px、圖示 14px + 13px 文字，選中 `--o1c1e22` 底 + 主要文字色，其他 muted；`role="tab"`、`aria-selected`。
- 第二列右側：**篩選**、**顯示**、**所有專案**，30px、1px `--o26292e` 框、radius 6；有作用中的設定時按鈕上顯示 accent 數字。窄寬度時第二列換行。
- 篩選 Popover（240px）：全部符合／任一符合 Segmented + 條件勾選（指派給我、高優先度、本週到期、有代理階段、被阻擋）。
- **顯示** Popover（240px）分四段：
  - 分組：狀態（預設）／代理階段，單選打勾。
  - 排序：遞增／遞減 Segmented + 手動（預設）、優先度、截止日、更新時間。
  - 顯示屬性：狀態、優先度、負責人、截止日（勾選框），同時控制列表的欄、卡片的欄與表格的欄。
  - 已封存：勾選後顯示封存任務（列透明度 0.55）。
- Popover 開啟時按鈕為選中底色；點 Popover 外任一處或按 Esc 關閉，再按同一按鈕也會關閉。
- 「所有專案」：切換是否跨專案顯示（取代原「我的工作」頁）；開啟時其他專案的任務列標出專案代號。

## 列表（預設版面）
- 依目前分組顯示群組；群組標題列 38px：chevron（收合時旋轉 -90°）、狀態圖示、名稱 14px／550、數量 muted；滑過時右側出現「+」（新增到該群組）。**已取消** 預設收合。
- 任務列 42px、底線 1px `--o1e2024`，滑過 `--o1a1b1f`：
  - **完成圓圈**（16px，1px 框）：點擊標成完成（success 實心 + 勾）或重新開啟；完成的標題改 muted + 刪除線。不會開啟任務。
  - 優先度圖示、key（12px mono muted，窄寬度隱藏）、標題（14px，單行截斷，大型任務加「大型任務」chip）。
  - 右側依顯示屬性：代理階段 chip（accent 點 + 名稱；依代理階段分組時改為狀態圖示 + 名稱）、截止日（日曆圖示 + 日期，逾期 `--oef6b62`）、負責人（18px 頭像；代理執行中的任務顯示代理 logo；未指派為虛線圓）。
- 點擊列開啟任務（工作區的任務畫面）；大型任務開啟大型任務頁。
- **就地新增**：群組最後一列「+ 新增任務」，點擊後換成輸入框並自動聚焦，placeholder「任務名稱，按 Enter 建立」；Enter 建立並保留輸入框可連續新增，Esc 或空白時失焦取消。新任務指派給自己、狀態為該群組。依代理階段分組時「沒有代理階段」群組不提供新增。
- **拖曳改狀態**：依狀態分組時任務列可拖到其他群組，放下後狀態改為該群組並顯示提示「ORB-53 → 完成」。唯讀時不可拖曳、不顯示新增與完成圓圈的動作。

## 分欄
- 每個群組一欄：寬 288px（窄寬度 260px）、`--o18191d` 底、radius 10、padding 8，水平捲動；欄標題 32px：狀態圖示、名稱、數量，右側「+」。
- 卡片：`--o1a1b1f` 底、1px `--o1e2024` 框、radius 8、padding 10×12，滑過框線 `--o34373d`；第一行完成圓圈 + key，右上負責人；標題 14px 兩行截斷；第二行代理階段 chip；第三行優先度、截止日（依顯示屬性）。
- 欄底「+ 新增任務」與列表相同的就地新增；卡片可拖到其他欄改狀態，放下目標為整欄。

## 表格、月曆、時間軸
- 規格同 #13；表格列高改為 42px、標題 14px、儲存格 13px，與列表對齊。欄寬：狀態 128、優先度 104、負責人 136、截止日 92。

## 鍵盤與無障礙
- 版面分頁 `role="tablist"`；完成圓圈有 `aria-label`（「標成完成 ORB-42」／「重新開啟 ORB-42」）；列表的群組標題是按鈕並帶 `aria-expanded`；分欄每欄是帶 `aria-label` 的 `section`。
- 就地新增：Enter 建立、Esc 取消；Popover：Esc 關閉。

## 資料
- `ViewPref.layout: list|cols|table|cal|tl`（預設 list）、`ViewPref.groupBy: state|stage`、`ViewPref.columns[]`、`ViewPref.showArchived`、`ViewPref.allProjects`。
- 群組收合狀態依檢視記在本機（預設 `{cancelled: true}`）。

## 檢視自動儲存
- 檢視設定屬於每個人：版面、篩選、分組、排序、顯示屬性、已封存、所有專案，改了就**自動存到自己的帳號**，只有自己看得到；桌面版、網頁版、不同電腦都同步。其他成員的看板不受影響。
- 移除「未儲存」提示、「儲存檢視」、「還原」與「存成檢視」視窗。
- 檢視下拉固定三個起點：所有任務、我的任務、本週到期；每個起點各自記住你上次的設定，切換時不會互相覆蓋。
- 只跟這台電腦有關的版面細節存在本機：側欄寬度、群組收合、面板開關。
- 資料：`ViewPref {userId, projectId, viewId: all|mine|week, layout, filters: {match, conditions[]}, groupBy, sort: {field, dir}, columns[], showArchived, allProjects, updatedAt}`；第一次打開時用起點的預設值，之後每次改動以 debounce（約 500ms）寫回。

# 看板拖拉動畫與側欄精簡

## 拖拉（列表與分欄）
- **開始拖曳**：拖曳影像是卡片的複本（`--opop` 底、1px accent 55% 框、radius 8、陰影 `0 16px 40px rgba(0,0,0,.45)`；分欄再旋轉 2°，列表不旋轉），抓取點維持在滑鼠按下的位置。原本的列／卡片留在原處，透明度 0.4（120ms）。
- **經過其他群組**：目標欄或群組底色變 accent 6%、內框 1px accent 45%（120ms 過渡）；欄底出現虛線預留位（分欄 64px、列表 42px，1px dashed accent 55%，文字「移到「完成」」），以 140ms 由上往下展開。拖回原群組或離開時立即消失；收合的群組只亮底色、不顯示預留位。
- **放下**：任務移到目標群組的最後，狀態改為該群組（移到完成或已取消時清掉代理階段）；該列／卡片播放 600ms 落定動畫（從 0.97 縮放、accent 2px 外框與 16% 底色淡出到原樣），並顯示提示「ORB-53 → 完成」。放回原群組或放到不能放的位置時不做任何改變。
- 依代理階段分組或唯讀時不能拖曳。分欄卡片滑過時框線變亮並加 `0 4px 12px` 陰影。
- 系統開啟「減少動態效果」時不播放預留位與落定動畫，只保留顏色變化。

## 側欄
- 「進行中」與「對話」分組標題不再顯示數量。
- 搜尋與新對話的快捷鍵（Ctrl K／Ctrl N）預設隱藏，滑鼠移到該列或鍵盤聚焦時才淡入（80ms）。看板不顯示數量；待我處理右側的數字保留。

# 新對話、設定、儀表板改版

## 新對話
- **畫面**：側欄「新對話」（Ctrl N）開啟工作區原生的新對話畫面，側欄該列顯示選中底色。標題列 52px 只有「新對話」。中間偏上（上方留白 1 : 下方 1.4）依序為：
  - 標題「要做什麼？」24px／550，置中。
  - 工作位置列（與對話串輸入框上方的路徑列同樣式，11px mono）：工作位置按鈕（儲存庫用 git-branch 圖示、本機資料夾用資料夾、暫存用檔案 + 向下 chevron）與「新分支 orbis/conv-new」（只在儲存庫時顯示）。
  - 輸入框：**與對話串的輸入框完全相同**（`--o1c1e22`、1px `--o26292e`、radius 12、最寬 760px），placeholder「描述要做的事」，開啟時自動聚焦。下方 chip 依序：技能（數量）、模型、推理強度、權限策略、執行位置，右側圓形送出鈕（有字時亮起）。
  - 輸入框下方不放按鍵提示（Enter 開始、Shift + Enter 換行照常運作）。
- **模型選單**：和對話串、派工共用同一個選單——依代理分組，組標題是代理 logo + 品牌名（Claude Code、Codex、Antigravity、Grok Build）+ 廠商（Anthropic、OpenAI、Google、xAI），每個模型右側有標籤（最強、平衡、快速、程式），目前選擇打勾。預設為上次使用的模型。
- **其他 chip**：推理強度（快速、標準、深度；模型不支援時停用並說明，Haiku 固定為快速並顯示「固定」）、執行位置（我的電腦 KASH-DESKTOP／團隊執行器 team-runner-01；本機資料夾只能在我的電腦）。工作位置選單：儲存庫的新工作樹、本機資料夾（含「選擇資料夾…」直接開系統的資料夾選擇器）、空白的暫存資料夾。
- **送出後的過場**：建立對話後，複製一份輸入框疊在原位置，460ms `cubic-bezier(.2,.9,.3,1)` 移動並縮放到對話串底部輸入框的位置與大小（陰影同時淡出）；期間真正的輸入框透明，抵達後 120ms 淡入並移除複本。標題與工作位置列直接消失，對話串顯示第一則訊息與代理的回覆。系統開啟「減少動態效果」時直接切換。
- 選的模型、推理強度、權限策略、執行位置、工作位置與技能都帶進新對話；對話建立後輸入框回到一般的「傳訊息給代理」。

## 設定
- 每一頁標題下方加一句 13px muted 說明這頁在做什麼；每個設定列都有標籤 + 12px muted 的一句說明（標籤改成描述結果，不用內部名詞）。設定中不再顯示原型狀態列。
- 側欄分組：個人（一般、通知、帳號）、團隊（執行器、代理）、安全（稽核紀錄）。2026-10-26 拿掉桌面 App、週報、資料保存、執行器安全性、對外連線，見「從簡：權限只剩 session 的模式，拿掉多餘設定」。
- **一般**：主題、語言。右側面板預設隱藏、代理的操作步驟預設收合，都不是設定。
- **通知**：一個「桌面通知」開關。
- **帳號**：團隊名稱（說明：顯示在側欄與週報上）、成員、登出；沒有團隊設定視窗。
- **執行器**：說明執行器是什麼；執行器清單與「配對新的執行器」。終端機的 Shell 自動偵測，Windows 長路徑自動處理。
- **代理**：可以使用的代理與登入狀態；模型會記住上次的選擇，在輸入框切換。
- **稽核紀錄**：加一句說明。

## 儀表板
- 標題列：分頁 概覽／報告、期間 本週／上週／本月（顯示日期區間），右側「匯出報告」。
- **關鍵數字**（4 格，窄寬度 2 欄）：完成的任務（比上期 +4，平均每人）、合併請求（另有 N 個等待審查）、代理執行（成功率、失敗與中止次數）、代理費用（比上期、月預算）。數字 24px／550 tabular，變化用 success／danger 色。
- **成員活動**：一位成員一列（56px）——chevron、頭像、名稱與「最近：…」一行；完成、進行中、卡住（>0 時 warn）、審查、PR、代理執行（**不顯示個人費用**）；最右「每日活動」7 根小長條（週一到週日，週末灰色，滑過顯示數量）。點列展開這段期間的活動時間軸（日期、圖示：完成 success、合併 accent、核准 accent、退回 warn、派工 muted、卡住 warn），最後一行「開啟 X 的週報」。窄寬度只顯示完成、卡住。唯讀成員只看到自己。
- 下方保留：依狀態群組的進度、被卡住的任務（含卡住原因與天數）、代理用量與費用（只依代理／專案，不拆到個人）。拿掉「每人的工作量」（已併入成員活動）。

## 匯出報告
- 從儀表板「匯出報告」進入（`dashexport`）。左欄 280px 設定、右側即時預覽；窄寬度上下排列。
- **左欄**：返回儀表板；期間；格式（單選卡片：PDF 報告——排好版、適合寄出或列印；CSV 原始資料——每筆活動一列；Markdown——貼到 Wiki 或 Email）；成員（勾選，全部取消時顯示錯誤並停用下載）；內容（本期重點、關鍵數字、成員一覽、每位成員做了什麼、卡住的任務；CSV 時停用並說明「CSV 只匯出活動明細」）；主要按鈕依格式為 下載 PDF／下載 CSV／複製 Markdown。
- **報告不含任何費用**（沒有個人費用、沒有代理費用），也**不標示由 AI 撰寫**。
- **PDF 版面**：白色紙張，最寬 640px、每頁最少 905px（A4 比例），圓角 4、陰影，兩頁之間 16px。字級 12px／1.6；主色 indigo `#4f46e5`。
  - **第 1 頁**：頂端 6px 漸層色條（`#4f46e5 → #7c3aed`）；品牌列（22px 圓角方塊「O」+ Orbis，右側期間 pill `#eef2ff`）；標題「團隊週報」（本月為「團隊月報」）28px／700 + 一句說明；資訊列 4 欄（團隊、專案、期間、產生日期），上下 1px 分隔線。
  - **本期重點**：淺藍底 `#f5f7ff`、1px `#e0e7ff`、圓角 10 的區塊，3 點帶編號圓點（18px，indigo 底白字）。
  - **關鍵數字**：4 張框線卡片（完成的任務、合併請求、完成的審查、卡住的任務），數字 26px／700，下方變化 pill（成長綠底 `#dcfce7`、持平灰底、卡住琥珀底 `#fef3c7`）。
  - **成員一覽**：圓角 10 的表格，表頭 `#f9fafb`、斑馬紋；欄位 成員（22px 彩色縮寫頭像）、完成、進行中、卡住（>0 時琥珀 pill）、審查、PR、完成率（indigo 進度條 + 百分比，完成 ÷ 完成 + 進行中 + 卡住）。
  - 頁尾：「Orbis · 內部資料，請勿外流」與「第 1 頁，共 2 頁」。
  - **第 2 頁**：頁首小字「團隊週報 · 期間」；**每位成員做了什麼**——每人一張卡片（頭像、名稱、完成／進行中／卡住），活動依日期列出，每筆前面是彩色類型 pill（完成 綠、合併 indigo、核准 藍、退回 琥珀、派工 灰、卡住 紅）；**卡住的任務**——琥珀色卡片（左側 3px `#f59e0b`、淺黃底），任務編號 + 標題、卡在什麼與負責人，右側天數 pill。沒有資料時顯示「沒有卡住的任務」。
  - 只勾第 1 頁的內容時只產生 1 頁；取消勾選的區塊不出現；只選部分成員時各表格只列這些成員。
- **CSV 預覽**：等寬字表格，欄位 `date, member, action, task, title, project`，下方「共 N 列，預覽前幾列」。**Markdown 預覽**：等寬文字（標題、本期重點、成員表格：成員、完成、進行中、卡住、PR）。
- 下載後顯示提示（例如「已下載 orbis-週報-10-19.pdf」）。

## 費用與 AI 標示
- 個人費用不出現在任何地方：儀表板成員活動、代理用量的分組（拿掉「成員」）、報告分頁的成員清單（拿掉金額與「依費用」排序）。團隊層級的代理費用只留在儀表板的關鍵數字與代理用量圖。
- 個人週報頁的重點區標題改為「本週重點」，旁邊只寫更新時間，不寫由哪個代理產生；版本選單只列日期時間。

## 右側面板預設收合
- 打開任務或對話時，右側面板（任務、差異、預覽、終端機、收尾）預設收合，對話串佔滿主區域。用標題列右側的面板按鈕展開；點差異檔案、「收尾」、在終端機開啟等動作會自動展開到對應分頁。
- 設定 → 一般「任務的右側面板」預設為「隱藏」；改成「顯示」後打開任務會直接展開。元件 prop `defaultLayout` 預設改為 `stream`。

# 成員報告與個人週報改版

## 成員報告（儀表板 → 報告）
- 標題列：期間（今天、本週、本月、自訂）、專案（全部、ORB、WEB）、排序（依完成、依卡住）。
- 每位成員一張卡片，`repeat(auto-fill, minmax(260px, 1fr))`，間距 12px（窄寬度單欄）。卡片 `--o1a1b1f`、1px `--o1e2024`、圓角 12、內距 16；滑過框線 `--o34373d` 加陰影，按下縮放 0.99；整張可點，開啟該成員的週報。
  - 第一行：32px 頭像、名稱 14／600、「週報 10/19 – 10/25」；右側狀態 pill——已產生（success）、N 個卡住（warn）。
  - 數字列 4 欄：完成、進行中、卡住（>0 用 warn）、PR，數字 20px／600。
  - 完成率：標籤 + 百分比，下方 6px 進度條（完成 ÷ 完成＋進行中＋卡住）。
  - 本週重點第一點的文字，最多兩行。
  - 底部（上方 1px 分隔線）：7 天活動小長條（週末灰色）、「審查 核准 N · 退回 N」、右側 accent「查看報告 ›」。
- 不顯示任何費用。唯讀成員只看到自己的卡片，上方註明「只看得到自己的週報」；沒有資料時顯示空狀態。

## 個人週報
- **頁首**：「‹ 成員報告」返回；40px 頭像、標題「kashionz 的週報」20px／650、期間 pill、狀態 pill；下方一行「10/25 09:00 更新」。右側動作：版本（歷史版本選單，只列日期時間）、匯出（Markdown、CSV、存成 Wiki 頁）、重新產生（唯讀或沒有資料時停用）。
- **關鍵數字** 4 格：完成的任務（比上週）、進行中（其中 N 個卡住，warn）、合併請求（全部已合併）、完成的審查（核准 N，退回 N）。
- **兩欄**（主欄彈性 + 側欄 300px；窄寬度單欄）：
  - 主欄：**本週重點**（accent 6% 底、1px accent 20% 框、圓角 12；3 點帶編號，任務與合併請求編號是可點的 mono chip，點了開啟任務）；**完成的任務**、**進行中**（右側階段 pill：執行中 accent、審查關卡／卡住 warn、規劃中／待辦 muted）、**合併請求**（已合併 pill）、**審查與關卡**（核准綠勾、退回 warn 叉）——每張卡片列 38px，編號 mono 56px 寬可點，右側日期。
  - 側欄：**每日活動**（7 根長條，上方數字、下方星期，週末灰色）；**其他**（代理執行、對話「不顯示內容」、Wiki 編輯、留言）。
- 不顯示費用，也不標示重點由誰（哪個代理）產生。沒有可用的團隊執行器時，重點區顯示 warn「只有統計，沒有本週重點」。
- 從儀表板成員活動的「開啟 X 的週報」或成員報告卡片進入時，開啟該成員的週報（`rpw`）。

## 側欄分組箭頭
- 「進行中」與「對話」分組標題的收合箭頭緊接在標題文字右邊（間距 6px），不再推到最右側；整列仍可點擊收合／展開。
- 側欄「看板」右側不顯示任務數量；「待我處理」保留待處理數（warn 色）。

## 看板分頁切換
- 看板標題列的 任務／儀表板 分頁互相切換時都保持在看板內；從儀表板點「任務」回到任務清單（不會出現空白頁）。
- 停在儀表板、匯出報告或個人週報時，側欄「看板」維持選中底色。

# 從簡：權限只剩 session 的模式，拿掉多餘設定（2026-10-26）

依 Orbis repo 的 ADR-0017（權限只剩每個 session 的三種模式，預設全部允許，體驗對齊 Orca）與 ADR-0018（設定最小化）。前面各段已就地改寫；這裡集中列出這一輪的變更。

## 驗收
- 驗收條件改成選填：沒有條件也能進入就緒、能派工。條件是一行一行的文字，不選類型；用反引號包住的指令在工作樹執行，其他交給判定用的代理（有預覽時可以開瀏覽器）。
- 每次驗收都先跑 `.orbis/config.toml` 的 `[verify].commands`；專案沒有驗收指令、任務也沒有條件時，跳過驗收直接進審查，和 Orca 一樣。
- 拿掉「人工」與「瀏覽器」兩種類型；新增任務對話框不再預設帶一條指令條件。

## 權限
- **只剩每個 session 的權限策略**：全部允許（預設）、自動、逐一確認。派工面板、派工視窗、指派給代理、新對話與輸入框都有同一個選單，執行中隨時可以切換；本機資料夾與團隊執行器都能選全部允許，沒有警告。沒有專案的預設策略，新的 session 一律從全部允許開始。
- 全部允許時，權限請求只顯示一列「已自動允許」；自動與逐一確認時，需要你的請求停在對話串並出現在待我處理的「權限請求」群組，選項是允許一次、這個 session 都允許、拒絕。
- 拿掉「加進專案規則」、設定的信任核准、執行器安全性（隔離等級）與對外連線的允許清單。
- 終端機：能操作這個任務的人都能開，不分本機或團隊執行器。
- 稽核紀錄記下權限請求的回覆與自動允許，只有擁有者看得到。

## 設定
- 設定導覽只剩 6 項：一般（主題、語言）、通知（一個桌面通知開關）、帳號（團隊名稱、成員、登出）、執行器、代理（登入狀態）、稽核紀錄。
- 對外 MCP 與個人存取權杖延後到 v0.1.0 之後：拿掉存取權杖頁、建立與撤銷權杖的視窗、OAuth 授權同意頁。之後要做時先只做 OAuth 登入。
- 拿掉：桌面 App（隔離容器、允許的資料夾、接收預覽版）、週報（主管、排程）、資料保存（Blob、自動封存、工作樹保留天數）、執行器安全性、對外連線；一般的右側面板與展開步驟、執行器的 Shell、代理的預設模型、通知的事件 × 管道、Slack、勿擾時段、團隊設定視窗（時區、Blob 保存期限）。
- 寫死的行為：右側面板預設隱藏、代理步驟預設收合、Shell 自動偵測、模型記住上次的選擇、完成或已取消的任務 3 個月後自動封存、失敗或中止的工作樹保留 14 天、Blob 保存 90 天。

## 專案管理與報告
- 拿掉收件匣（提出、接受、拒絕、重複、延後需求）、估計（點數）。狀態固定五個：待辦、就緒、進行中、完成、已取消。
- 報告：拿掉主管、彙報關係、排程寄送、本人補充與主管留言；擁有者看得到所有人的報告，成員只看自己的。匯出不再寄給主管。

## 分享與角色
- 拿掉任務層級的成員、角色與一般存取：團隊成員都能檢視與操作每個任務。分享卡只剩連結、存取說明與「邀請加入團隊」（Email，加入後是成員）。預覽邀請保留。
- 角色只剩擁有者與成員。

## Wiki 與技能
- Wiki 不設權限，拿掉資料夾權限、私人頁、Git 同步與衝突處理。
- 技能拿掉核准、退回、待核准與安全掃描；新版本儲存後就能使用。

## 派工
- 派工視窗與任務的派工面板新增「先出計畫」Switch（預設關閉）：開啟時代理先寫計畫，核准後才開始修改，取代原本專案層級的計畫關卡設定。

## 拿掉的視窗
提出需求、拒絕需求、標成重複、延後需求、指定主管、每週排程寄送、新增／移除允許的本機資料夾、資料夾權限、Git 同步設定、衝突處理、退回技能、團隊設定、加進專案規則、加進允許清單、新增／移除網域、Slack 通知。`Orbis Dialogs.dc.html` 與 `Orbis v0.1.0 States.dc.html` 已同步拿掉對應的項目。

# 合併衝突交給代理解決（2026-10-26）

依 Orbis repo 規劃的 N12。多個任務平行完成時，先合併的任務可能讓其他任務的分支和 main 衝突。

## 38. 合併衝突
- **偵測**：main 有新的 push 後，系統檢查還開著的合併請求；變成衝突時自動交給原本的代理，在同一個工作樹把 main 合併進來並解決，照常驗收，通過後 push。本機儲存庫在審查通過、合併回 main 時碰到衝突，也先交給代理解決。
- **對話串**：系統事件列（12px muted，`gitMerge` 圖示）依序顯示：
  - 「和 `main` 衝突（`9c1e4f2`），代理正在解決 2 個檔案」
  - 成功：「已解決衝突，合併 commit `3f9a1c0`」→「驗收 2/2 通過」→「已 push 到合併請求」（`check`／`gitBranch` 圖示）。
  - 失敗：「代理無法解決：<原因>，已中止合併」（`alert` 圖示）。
- **待我處理**：新群組「合併衝突」排在最上面（`git`／`gitMerge` 圖示，danger 色）。每列：任務 key + 標題、代理 logo + 摘要「和 main 衝突，代理解決不了」、衝突的檔案（mono，單行省略）、時間。
  - 動作：附意見再試（主要，展開意見輸入框，同驗收超過上限）／中止（danger 文字）。
  - 處理後：「已附意見再試」／「已中止自動解決，請在合併請求上手動處理」，對話串加一列對應的系統事件。
- 原型：工作區中「合併請求已開」的 ORB-35 示範解決不了的情況；已完成的任務（第一個有已合併 PR 的）在合併前示範解決成功；`OrbisFeatures` 的待我處理畫面多一列範例。
- 資料：`Run.conflict {baseSha, files[], done}`；Needs You 的 `stopped_run.reasonCode = merge_conflict_unresolved`。

