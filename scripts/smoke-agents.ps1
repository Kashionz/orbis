<#
.SYNOPSIS
  真實 Agent 煙霧測試：Claude Code、Codex、Antigravity、Grok Build 各跑一個小 Task，結果寫成摘要檔。

.DESCRIPTION
  只在使用者自己的電腦上跑（手動，或 Windows 工作排程器每晚），不在 GitHub Actions 上跑，Agent 的憑證不離開這台電腦。
  每個 Agent：
    1. 在暫存目錄建立一個只有 README.md 的 git repo（main 分支）。
    2. 啟動 dev_dispatch（扮演最小的 Server，隨機 port）：派 Task → 權限請求一律回覆 allow_once →
       第一次 Review Gate 退回並送出修正 → 第二次核准 → push_branch。
    3. 啟動 orbis-runner（獨立的 Runner home，不碰你平常的 ~/.orbis）。
    4. 結束後把 result.json、Event 摘要與 log 收進這次的輸出目錄。
  全部跑完後寫 summary.md 與 summary.json；任何一個 Agent 沒有 completed 就以非 0 結束。
  用法與排程設定見 docs/SMOKE-TEST.md。

.PARAMETER Agents
  要跑的 Agent，預設四個都跑。

.PARAMETER OutRoot
  輸出根目錄。Runner home 固定在 <OutRoot>\home（跨次沿用：Antigravity 的登入標記與 Runner 代管安裝的
  ACP adapter 不必每次重來）；每次執行的 repo、Worktree、log 在 <OutRoot>\runs\<時間戳>。

.PARAMETER Repo
  Orbis 的 repo 根目錄（找或建置執行檔用）。預設是這個腳本所在的 repo。

.PARAMETER BinDir
  預先建置好的 orbis-runner.exe 與 dev_dispatch.exe；沒有時從 $Repo 用 cargo build（CARGO_BUILD_JOBS=2）。

.PARAMETER TimeoutSec
  每個 Agent 的時間上限（秒）。

.PARAMETER KeepDays
  保留幾天內的 runs，更舊的自動刪除。

.PARAMETER SkipLogin
  Antigravity 還沒登入時直接記為 skipped，不開瀏覽器（排程執行時用）。沒有這個參數時會執行
  orbis-runner login antigravity，請在開啟的瀏覽器中完成。

.PARAMETER FakeScript
  只給開發者自測腳本流程：所有 Agent 都換成 Fake Agent 跑這份劇本，不呼叫真實模型。

.EXAMPLE
  pwsh -NoProfile -File scripts\smoke-agents.ps1
.EXAMPLE
  pwsh -NoProfile -File scripts\smoke-agents.ps1 -Agents claude-code,grok -TimeoutSec 900
.EXAMPLE
  pwsh -NoProfile -File scripts\smoke-agents.ps1 -FakeScript crates\fake-agent\scripts\m1.yaml
#>
[CmdletBinding()]
param(
  # 可以用逗號分隔（`-Agents claude-code,grok`；用 -File 啟動時陣列會以一個字串傳入）。
  [string[]]$Agents = @("claude-code", "codex", "antigravity", "grok"),
  [string]$OutRoot = (Join-Path $env:TEMP "orbis-smoke"),
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$BinDir = "",
  [int]$TimeoutSec = 1800,
  [int]$KeepDays = 7,
  [switch]$SkipLogin,
  [string]$FakeScript = "",
  # 覆寫 Review Gate 退回時送出的修正 prompt（自測劇本需要特定的文字時用）。
  [string]$Followup = ""
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$knownAgents = @("claude-code", "codex", "antigravity", "grok")
$Agents = @($Agents | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
foreach ($agent in $Agents) {
  if ($knownAgents -notcontains $agent) { throw "不認得的 Agent：$agent（可用：$($knownAgents -join '、')）" }
}
$env:CARGO_BUILD_JOBS = "2"
$exe = if ($IsWindows -or $env:OS -eq "Windows_NT") { ".exe" } else { "" }

function Resolve-Bin([string]$dir, [string]$name) {
  $path = Join-Path $dir "$name$exe"
  if (Test-Path $path) { return (Resolve-Path $path).Path }
  return $null
}

# ---- 執行檔 -------------------------------------------------------------
$runnerExe = $null; $dispatchExe = $null
if ($BinDir -ne "") {
  # cargo 的輸出目錄把 example 放在 examples\ 底下；也接受兩個執行檔放在同一個目錄。
  $runnerExe = Resolve-Bin $BinDir "orbis-runner"
  $dispatchExe = Resolve-Bin $BinDir "dev_dispatch"
  if (-not $dispatchExe) { $dispatchExe = Resolve-Bin (Join-Path $BinDir "examples") "dev_dispatch" }
}
if (-not $runnerExe -or -not $dispatchExe) {
  Write-Host "== 建置 orbis-runner 與 dev_dispatch（第一次會比較久）"
  Push-Location $Repo
  try {
    cargo build -q -p orbis-runner --bin orbis-runner --example dev_dispatch
    if ($LASTEXITCODE -ne 0) { throw "cargo build 失敗（結束碼 $LASTEXITCODE）" }
    if ($FakeScript -ne "") {
      cargo build -q -p orbis-fake-agent
      if ($LASTEXITCODE -ne 0) { throw "cargo build orbis-fake-agent 失敗（結束碼 $LASTEXITCODE）" }
    }
  } finally { Pop-Location }
  $runnerExe = Resolve-Bin (Join-Path $Repo "target\debug") "orbis-runner"
  $dispatchExe = Resolve-Bin (Join-Path $Repo "target\debug\examples") "dev_dispatch"
}
if (-not $runnerExe -or -not $dispatchExe) { throw "找不到 orbis-runner 或 dev_dispatch 的執行檔" }
$fakeExe = if ($FakeScript -ne "") { Resolve-Bin (Join-Path $Repo "target\debug") "orbis-fake-agent" } else { $null }

# 名稱常數（產品名稱、環境變數前綴等）一律從 Runner 取得，不寫死。
$names = (& $runnerExe --print-names) | ConvertFrom-Json
$logEnv = "$($names.envPrefix)LOG"
# 不讓使用者環境中的 Runner 設定影響這次執行（尤其是狀態目錄，否則會碰到平常的 Runner）。
foreach ($var in @($names.runnerEnv.home, $names.runnerEnv.stateDir, $names.runnerEnv.serverUrl, $names.runnerEnv.pairingToken)) {
  if (Test-Path "Env:$var") { Remove-Item "Env:$var" }
}

# ---- 目錄 ---------------------------------------------------------------
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$homeDir = Join-Path $OutRoot "home"
$runsDir = Join-Path $OutRoot "runs"
$runDir = Join-Path $runsDir $stamp
New-Item -ItemType Directory -Force $homeDir, $runDir | Out-Null
# 上次執行留下的 Worktree 紀錄與 port 分配已經沒有意義（Worktree 都在舊的 runs 目錄中）；
# 登入標記、Runner 代管安裝的 adapter 與 credentials 保留。
foreach ($stale in @("ports.json", "run-worktrees.json")) {
  Remove-Item -Force (Join-Path $homeDir $names.runnerStateDir $stale) -ErrorAction SilentlyContinue
}

# 刪掉太舊的 runs。
Get-ChildItem $runsDir -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
  ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

# runner.toml：每個 Agent 啟動 Runner 前重寫，Worktree 根目錄指到該 Agent 自己的目錄（Runner 自己的
# clone 放在 Worktree 根目錄下，不同 Agent 的 repo 不可以共用）；自測時把 Agent 換成 Fake Agent。
function Toml-Str([string]$s) { "'" + ($s -replace "'", "''") + "'" }
function Write-RunnerToml([string]$agent, [string]$wtRoot) {
  $toml = "worktree_root = $(Toml-Str $wtRoot)`n"
  if ($FakeScript -ne "") {
    $script = (Resolve-Path $FakeScript).Path
    $toml += "[agents.$agent]`ncommand = $(Toml-Str $fakeExe)`nargs = ['--script', $(Toml-Str $script)]`n"
  }
  Set-Content -Path (Join-Path $homeDir $names.runnerConfigFile) -Value $toml -Encoding utf8
}

# ---- Antigravity 的登入 --------------------------------------------------
$results = @()
$agentsToRun = @()
foreach ($agent in $Agents) {
  if ($agent -eq "antigravity" -and $FakeScript -eq "") {
    $marker = Join-Path $homeDir $names.runnerStateDir "agents" "antigravity.login"
    if (-not (Test-Path $marker)) {
      if ($SkipLogin) {
        Write-Host "== antigravity 尚未登入（$marker 不存在），-SkipLogin：跳過" -ForegroundColor Yellow
        $results += [ordered]@{ agent = $agent; outcome = "skipped"; last_error = "尚未登入：請先執行 orbis-runner --home `"$homeDir`" login antigravity"; duration_secs = 0 }
        continue
      }
      Write-Host "== 登入 Antigravity：請在開啟的瀏覽器中完成（最多 10 分鐘）"
      & $runnerExe --home $homeDir login antigravity
      if ($LASTEXITCODE -ne 0) {
        $results += [ordered]@{ agent = $agent; outcome = "login_failed"; last_error = "orbis-runner login antigravity 結束碼 $LASTEXITCODE"; duration_secs = 0 }
        continue
      }
    }
  }
  $agentsToRun += $agent
}

# ---- 每個 Agent 跑一個 Task ---------------------------------------------
function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Stop-Tree([System.Diagnostics.Process]$proc) {
  if ($proc -and -not $proc.HasExited) {
    if ($exe -eq ".exe") { taskkill /T /F /PID $proc.Id 2>&1 | Out-Null } else { $proc.Kill($true) }
  }
}

foreach ($agent in $agentsToRun) {
  $dir = Join-Path $runDir $agent
  $repoDir = Join-Path $dir "repo"
  New-Item -ItemType Directory -Force $repoDir | Out-Null
  git -C $repoDir init -q -b main
  Set-Content -Path (Join-Path $repoDir "README.md") -Value "# $($names.productName) smoke test ($agent)" -Encoding utf8
  git -C $repoDir add README.md
  git -C $repoDir -c user.name=smoke-test -c user.email=smoke-test@example.invalid commit -q -m "init"

  Write-RunnerToml $agent (Join-Path $dir "wt")
  $summary = Join-Path $dir "summary.md"
  $json = Join-Path $dir "result.json"
  $dispatchLog = Join-Path $dir "dev-dispatch.log"
  $runnerLog = Join-Path $dir "runner.log"
  $port = Get-FreePort
  Write-Host "== $agent：dev_dispatch 在 port $port，輸出 $dir"
  $started = Get-Date
  $dispatchArgs = @("--port", $port, "--repo", "`"$repoDir`"", "--agent", $agent, "--summary", "`"$summary`"", "--summary-json", "`"$json`"", "--timeout-secs", $TimeoutSec)
  if ($Followup -ne "") { $dispatchArgs += @("--followup", "`"$Followup`"") }
  $server = Start-Process -FilePath $dispatchExe -PassThru -NoNewWindow `
    -ArgumentList $dispatchArgs `
    -RedirectStandardError $dispatchLog
  Start-Sleep -Seconds 1
  $previousLog = [Environment]::GetEnvironmentVariable($logEnv)
  [Environment]::SetEnvironmentVariable($logEnv, "info,orbis_runner=debug")
  try {
    $runner = Start-Process -FilePath $runnerExe -PassThru -NoNewWindow `
      -ArgumentList @("--server", "http://127.0.0.1:$port", "--pairing-token", "dev", "--home", "`"$homeDir`"") `
      -RedirectStandardError $runnerLog
  } finally {
    [Environment]::SetEnvironmentVariable($logEnv, $previousLog)
  }

  $null = $server.WaitForExit(($TimeoutSec + 60) * 1000)
  if (-not $server.HasExited) {
    Write-Host "!! $agent：dev_dispatch 逾時沒有結束，強制停止" -ForegroundColor Red
    Stop-Tree $server
  }
  Start-Sleep -Seconds 2
  Stop-Tree $runner

  $result = $null
  if (Test-Path $json) {
    try { $result = Get-Content $json -Raw | ConvertFrom-Json } catch { $result = $null }
  }
  if (-not $result) {
    $result = [pscustomobject]@{ agent = $agent; outcome = "no_result"; last_error = "dev_dispatch 沒有寫出 result.json，請看 dev-dispatch.log 與 runner.log"; duration_secs = [int]((Get-Date) - $started).TotalSeconds; pushed_commit = $null; pushed_branch = $null }
  }
  $results += [ordered]@{
    agent = $agent
    outcome = $result.outcome
    pushed_branch = $result.pushed_branch
    pushed_commit = $result.pushed_commit
    last_error = $result.last_error
    duration_secs = $result.duration_secs
    dir = $dir
  }
  $color = if ($result.outcome -eq "completed") { "Green" } else { "Red" }
  Write-Host "   $agent → $($result.outcome)（$($result.duration_secs) 秒）" -ForegroundColor $color
}

# ---- 摘要 ---------------------------------------------------------------
$passed = @($results | Where-Object { $_.outcome -eq "completed" }).Count
$total = $results.Count
$lines = @(
  "# $($names.productName) 真實 Agent 煙霧測試 $stamp",
  "",
  "通過 $passed／$total。輸出目錄：``$runDir``",
  "",
  "| Agent | 結果 | 耗時（秒） | push 的 commit | 說明 |",
  "|---|---|---|---|---|"
)
foreach ($r in $results) {
  $commit = if ($r.pushed_commit) { $r.pushed_commit.Substring(0, 7) } else { "" }
  $note = if ($r.last_error) { ($r.last_error -replace "\r?\n", " ") } else { "" }
  $lines += "| $($r.agent) | $($r.outcome) | $($r.duration_secs) | $commit | $note |"
}
$lines += ""
$lines += "每個 Agent 的目錄中有 summary.md（Event 摘要）、result.json、dev-dispatch.log、runner.log。"
Set-Content -Path (Join-Path $runDir "summary.md") -Value ($lines -join "`n") -Encoding utf8
[ordered]@{ stamp = $stamp; passed = $passed; total = $total; results = $results } |
  ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $runDir "summary.json") -Encoding utf8
# 最新一次的位置，排程時方便查看。
Set-Content -Path (Join-Path $OutRoot "latest.txt") -Value $runDir -Encoding utf8

Write-Host ""
Write-Host "== 結果：通過 $passed／$total，摘要在 $(Join-Path $runDir 'summary.md')"
if ($passed -ne $total) { exit 1 }
exit 0
