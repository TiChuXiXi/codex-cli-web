import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const preamble = `
$ErrorActionPreference = 'Stop'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
function Assert-DirectoryChain($dir) {
  for ($parent = $dir; $null -ne $parent; $parent = $parent.Parent) {
    if ($parent.Exists -and ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 2 }
  }
}
function Assert-Access($item, $forbidden) {
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 2 }
  $acl = $item.GetAccessControl()
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { exit 2 }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and
        ($rule.FileSystemRights -band $forbidden)) { exit 2 }
  }
}
`
async function check(path, script, failure) {
  const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    await run(shell, ['-NoProfile', '-NonInteractive', '-Command', preamble + script], {
      env: { SystemRoot: process.env.SystemRoot, ZCODEX_CHECK_PATH: path }, windowsHide: true, timeout: 15000,
    })
  } catch { throw new Error(failure) }
}

export function checkWindowsLauncher(path) {
  return check(path, `
$file = [IO.FileInfo]::new($env:ZCODEX_CHECK_PATH)
$writes = [Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
Assert-DirectoryChain $file.Directory
Assert-Access $file $writes
Assert-Access $file.Directory $writes
`, '无法验证 Windows Router 启动器及安装目录的所有者和写入权限')
}

export function checkWindowsPrivateFile(path) {
  return check(path, `
$file = [IO.FileInfo]::new($env:ZCODEX_CHECK_PATH)
Assert-DirectoryChain $file.Directory
Assert-Access $file ([Security.AccessControl.FileSystemRights]::FullControl)
`, '无法验证私有文件的所有者和访问权限')
}

export function prepareWindowsRouterDirectory(path) {
  return check(path, `
$dir = [IO.DirectoryInfo]::new($env:ZCODEX_CHECK_PATH)
Assert-DirectoryChain $dir
if (!$dir.Exists) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $trusted) {
    $principal = [Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  $dir.Create($acl)
  $dir.Refresh()
}
Assert-Access $dir ([Security.AccessControl.FileSystemRights]::FullControl)
`, 'Router 状态目录必须是当前用户的私有真实目录')
}

