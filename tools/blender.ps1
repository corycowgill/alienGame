# Run a headless Blender python script via the Store launcher and print its log.
#   powershell -File tools/blender.ps1 <script.py> <log> <args...>
param([string]$Script, [string]$Log, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
if (Test-Path $Log) { Remove-Item $Log }
$argList = @('-b','--python',$Script,'--') + $Rest + @('--log',$Log)
Start-Process "$env:LOCALAPPDATA\Microsoft\WindowsApps\blender-launcher.exe" -ArgumentList $argList -Wait
Start-Sleep 1
if (Test-Path $Log) { Get-Content $Log } else { Write-Output "NO LOG WRITTEN" }
