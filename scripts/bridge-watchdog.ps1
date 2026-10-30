<#
  bridge-watchdog.ps1 —— 桥的守护进程：17300 没在监听就把 wx-bridge 拉起来

为什么需要它（2026-10-28 事故）：
  桥是独立 Node 进程，一旦退出（终端被关、父进程被杀、启动参数错导致注入失败后放弃），
  DSH 插件只会无限重连（累计 16→24 次），**不会**自己把桥拉起来。
  结果就是"机器人静默失联"，只能人工发现再去起桥。

用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bridge-watchdog.ps1        # 常驻
  powershell ... -File scripts\bridge-watchdog.ps1 -Once                                # 只检查一次（适合计划任务）
  powershell ... -File scripts\bridge-watchdog.ps1 -IntervalSec 20                       # 自定义巡检间隔

可选环境变量（和 start-bot.ps1 一致）：
  WECHAT_EXE / WECHAT_BOT_DATA / WECHAT_BOT_PORT / WECHAT_HOOK_PORT / WECHAT_CB_PORT /
  WECHAT_BOT_TRANSPORT / WECHAT_BOT_NODE
#>
[CmdletBinding()]
param(
  [int]$IntervalSec = 20,
  [switch]$Once
)

$ErrorActionPreference = 'Continue'

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$BridgeDir = Join-Path $RepoRoot 'wx-bridge'
$DataDir   = if ($env:WECHAT_BOT_DATA) { $env:WECHAT_BOT_DATA } else { Join-Path $RepoRoot 'data' }
$BotPort   = if ($env:WECHAT_BOT_PORT)  { [int]$env:WECHAT_BOT_PORT }  else { 17300 }
$HookPort  = if ($env:WECHAT_HOOK_PORT) { [int]$env:WECHAT_HOOK_PORT } else { 30001 }
$CbPort    = if ($env:WECHAT_CB_PORT)   { [int]$env:WECHAT_CB_PORT }   else { 18998 }

$WxExe = $env:WECHAT_EXE
if (-not $WxExe) {
  $autoExe = 'D:\wxhook\wx4110\Weixin.exe'
  if (Test-Path $autoExe) { $WxExe = $autoExe }
}

# transport 必须和客户端的 hook 方式匹配：有 version.dll = 代理式（wechat-hook），否则才是注入式
$Transport = if ($env:WECHAT_BOT_TRANSPORT) { $env:WECHAT_BOT_TRANSPORT }
             elseif ($WxExe -and (Test-Path (Join-Path (Split-Path -Parent $WxExe) 'version.dll'))) { 'wechat-hook' }
             else { 'wxhelper' }

# node.exe：显式变量 > PATH > WorkBuddy 自带的运行时（本机没有独立装 Node）
function Resolve-NodeExe {
  if ($env:WECHAT_BOT_NODE -and (Test-Path $env:WECHAT_BOT_NODE)) { return $env:WECHAT_BOT_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in 'C:\Program Files\nodejs\node.exe', "$env:LOCALAPPDATA\Programs\nodejs\node.exe") {
    if (Test-Path $p) { return $p }
  }
  # WorkBuddy 的私有 Node（注意 .workbuddy 是隐藏目录，必须 -Force 才枚举得到）
  $verRoots = @("$env:USERPROFILE\.workbuddy\binaries\node\versions", "$env:APPDATA\.workbuddy\binaries\node\versions")
  foreach ($root in $verRoots) {
    if (-not (Test-Path $root)) { continue }
    $hit = Get-ChildItem $root -Directory -Force -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending |
           ForEach-Object { Join-Path $_.FullName 'node.exe' } |
           Where-Object { Test-Path $_ } |
           Select-Object -First 1
    if ($hit) { return $hit }
  }
  return $null
}

$NodeExe = Resolve-NodeExe
if (-not $NodeExe) {
  Write-Host "[watchdog] 找不到 node.exe —— 请 setx WECHAT_BOT_NODE ""C:\path\to\node.exe"""
  exit 2
}

$LogDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$WatchLog = Join-Path $LogDir 'bridge-watchdog.log'
function WLog([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $m
  Write-Host $line
  Add-Content -Path $WatchLog -Value $line -Encoding UTF8
}

function Test-BridgeUp { [bool](Get-NetTCPConnection -LocalPort $BotPort -State Listen -ErrorAction SilentlyContinue) }

function Start-Bridge {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $LogDir "bridge-console-$stamp.log"
  $nodeArgs = @(
    'server.mjs'
    "--transport=$Transport"
    "--api-port=$HookPort"
    "--cb-port=$CbPort"
    "--data-dir=$DataDir"
  )
  if ($WxExe) { $nodeArgs += "--wechat=$WxExe" }
  WLog "启动桥：$NodeExe $($nodeArgs -join ' ')（stdout → $out）"
  # detached：watchdog 退出或被关掉都不影响桥本身
  Start-Process -FilePath $NodeExe -ArgumentList $nodeArgs -WorkingDirectory $BridgeDir `
    -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError "$out.err" | Out-Null
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt 30) {
    if (Test-BridgeUp) { WLog "桥已监听 $BotPort（用时 $([int]((Get-Date) - $t0).TotalSeconds)s）"; return $true }
    Start-Sleep -Milliseconds 700
  }
  WLog "桥启动后 30s 仍没监听 $BotPort —— 看 $out / $out.err"
  return $false
}

WLog "watchdog 启动：interval=${IntervalSec}s bridge=$BridgeDir data=$DataDir transport=$Transport wechat=$(if ($WxExe) { $WxExe } else { '(未设置)' })"

# 启动速率限制：防止"起了就崩"死循环刷屏
$startHistory = New-Object System.Collections.ArrayList
$maxStartsPerHour = 10
$lastState = $null

while ($true) {
  $up = Test-BridgeUp
  if ($up) {
    if ($lastState -ne 'up') { WLog "桥在线（$BotPort 已监听）" }
    $lastState = 'up'
  } else {
    $now = Get-Date
    while ($startHistory.Count -gt 0 -and ($now - $startHistory[0]).TotalMinutes -gt 60) { $startHistory.RemoveAt(0) }
    if ($startHistory.Count -ge $maxStartsPerHour) {
      if ($lastState -ne 'throttled') { WLog "桥不在，但 1 小时内已启动 $($startHistory.Count) 次（> $maxStartsPerHour）→ 暂停重启，先查日志" }
      $lastState = 'throttled'
    } else {
      WLog "桥不在（$BotPort 未监听）→ 拉起"
      [void]$startHistory.Add($now)
      [void](Start-Bridge)
      $lastState = 'started'
    }
  }
  if ($Once) {
    if (Test-BridgeUp) { exit 0 } else { exit 1 }
  }
  Start-Sleep -Seconds $IntervalSec
}
