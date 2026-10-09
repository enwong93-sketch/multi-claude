# Login helper for an extra runtime.
#
# Claude's sign-in link (claude://...) is registered for the Store app, so Windows opens it in the *primary* runtime, never in
# the extra one that is waiting for the login. While this script runs it watches for the short-lived Claude.exe process that
# Windows starts for such a link, reads the link from that process' command line and hands it to the extra runtime
# (--user-data-dir=<Profile>). Everything stays on this machine. The link is a one-time sign-in token: it is never printed
# or written to disk, only its scheme/host/path and length are logged. The script ends by itself after -Minutes.
param(
  [Parameter(Mandatory)][string]$Profile,
  [Parameter(Mandatory)][string]$Exe,
  [string]$Log,
  [int]$Minutes = 10
)
$ErrorActionPreference = 'SilentlyContinue'
$seen = @{}; $end = (Get-Date).AddMinutes($Minutes)
function Write-Log($m) { if ($Log) { Add-Content -LiteralPath $Log -Value "$((Get-Date).ToString('s')) $m" } }
Write-Log "capture watcher started for $Minutes min"
while ((Get-Date) -lt $end) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='Claude.exe' AND CommandLine LIKE '%claude://%'"
  foreach ($p in $procs) {
    if ($seen.ContainsKey($p.ProcessId)) { continue }; $seen[$p.ProcessId] = 1
    if ($p.CommandLine -match 'user-data-dir') { continue }   # our own forward
    if ($p.CommandLine -match '(claude://[^\s"]+)') {
      $url = $matches[1]
      Write-Log ("captured pid=$($p.ProcessId) " + ($url -replace '\?.*$', '') + " (len $($url.Length)) -> forwarding")
      Start-Process -FilePath $Exe -ArgumentList "--user-data-dir=`"$Profile`"", "`"$url`""
    }
  }
  Start-Sleep -Milliseconds 30
}
Write-Log 'capture watcher ended'
