# Tray host for the Trae Meta background service.
#
# This file is intentionally pure ASCII. Windows PowerShell 5.1 decodes .ps1
# files as ANSI unless they carry a UTF-8 BOM, and a BOM breaks other tooling,
# so all display strings are read from a UTF-8 JSON file instead.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tray.ps1 -ConfigPath <utf8.json>

param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

# Pin this process's notification identity to the AUMID the installer
# registers under HKCU\SOFTWARE\Classes\AppUserModelId. Windows renders tray
# balloon tips through the notification platform, which resolves the toast's
# icon from that identity; without it the platform attributes the toast
# heuristically, and a freshly installed icon can leak into other apps'
# notifications (and vice versa). Best effort by design: on any failure the
# balloon still carries its own icon exactly as before. The call must happen
# before the NotifyIcon below creates this process's first window.
$signature = @'
[DllImport("shell32.dll")]
public static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string AppID);
'@
try {
  Add-Type -MemberDefinition $signature -Namespace TraeMeta -Name NativeShell -ErrorAction Stop | Out-Null
  [void][TraeMeta.NativeShell]::SetCurrentProcessExplicitAppUserModelID('TraeMeta.Tray')
} catch {
  # Identity pinning is an improvement, not a requirement.
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\TraeMetaTray')
if (-not $mutex.WaitOne(0)) {
  Write-Output 'another tray host is already running'
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "tray config not found: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

$script:running = $true
$notify = New-Object System.Windows.Forms.NotifyIcon
$icon = $null

if ($config.iconPath -and (Test-Path -LiteralPath $config.iconPath)) {
  $icon = New-Object System.Drawing.Icon($config.iconPath)
  $notify.Icon = $icon
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}

$notify.Text = [string]$config.title
$notify.Visible = $true

function Start-ServiceCommand {
  param([string]$Command, [string]$Window)

  # serviceArgs is a JSON array so the host works both for source checkout and
  # for the bundled executable, where the entry is an internal argv switch.
  $arguments = @($config.serviceArgs) + @($Command)
  if ($Window -eq 'normal') {
    Start-Process -FilePath $config.nodePath -ArgumentList $arguments -WorkingDirectory $config.workingDirectory
  } else {
    Start-Process -FilePath $config.nodePath -ArgumentList $arguments -WorkingDirectory $config.workingDirectory -WindowStyle Hidden
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
foreach ($item in $config.items) {
  $entry = New-Object System.Windows.Forms.ToolStripMenuItem
  $entry.Text = [string]$item.label
  $clickCommand = [string]$item.command
  $clickWindow = [string]$item.window
  if ($clickCommand -eq 'exit') {
    $entry.add_Click({ $script:running = $false }.GetNewClosure())
  } else {
    $entry.add_Click({
      Start-ServiceCommand -Command $clickCommand -Window $clickWindow
    }.GetNewClosure())
  }
  [void]$menu.Items.Add($entry)
}

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({
  Start-ServiceCommand -Command $config.primaryCommand -Window 'normal'
}.GetNewClosure())

$notify.add_MouseClick({
  param($sender, $eventArgs)
}.GetNewClosure())

$notify.ShowBalloonTip(3000, [string]$config.title, [string]$config.balloonText, [System.Windows.Forms.ToolTipIcon]::Info)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({})
$timer.Start()

try {
  while ($script:running) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 200
  }
} finally {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  if ($icon) { $icon.Dispose() }
  $menu.Dispose()
  [void]$mutex.ReleaseMutex()
  $mutex.Dispose()
}

exit 0
