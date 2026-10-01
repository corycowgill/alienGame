# Decimate heavy props in Blender, then re-optimize into assets/models/props.
#   powershell -File tools/decimate-props.ps1 name:faces name:faces ...
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Items)
$root = "C:\Users\coryc\alienGame"
foreach ($it in $Items) {
  $name, $faces = $it.Split(':')
  $raw = "$root\art\raw_glb\props\$name.glb"
  if (-not (Test-Path $raw)) { Write-Output "skip $name (no raw)"; continue }
  $lo = "$root\art\raw_glb\props\${name}_lo.glb"
  $log = "$root\tools\reports\dec-$name.log"
  if (Test-Path $log) { Remove-Item $log }
  Start-Process "$env:LOCALAPPDATA\Microsoft\WindowsApps\blender-launcher.exe" -ArgumentList @('-b','--python',"$root\tools\blender\decimate.py",'--',$raw,$lo,'--faces',$faces,'--log',$log) -Wait
  if (Test-Path $lo) {
    node "$root\tools\optimize-glb.mjs" $lo "$root\assets\models\props\$name.glb" --res 1024 | Select-Object -Last 1
  } else { Write-Output "FAILED $name"; Get-Content $log | Select-Object -Last 2 }
}
Write-Output "ALL DONE"
