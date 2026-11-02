param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
$null = [Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$taskInput = [Console]::In.ReadToEnd()
if ($Mode -eq 'protect') {
    $taskBytes = [Text.Encoding]::UTF8.GetBytes($taskInput)
    $taskEncrypted = [Security.Cryptography.ProtectedData]::Protect($taskBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($taskEncrypted))
} else {
    $taskEncrypted = [Convert]::FromBase64String($taskInput.Trim())
    $taskBytes = [Security.Cryptography.ProtectedData]::Unprotect($taskEncrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($taskBytes))
}
