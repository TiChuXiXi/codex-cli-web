import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkRouterLauncher, launcherEnvironment } from '../server/router/launcher.js'
import { prepareWindowsRouterDirectory } from '../server/router/windows-access.js'

test('Router launcher permissions follow the native filesystem and reject a writable registered binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'router-launcher-test-'))
  try {
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user','/fo','csv','/nh'], { encoding: 'utf8' }).match(/S-1-\d+(?:-\d+)+/)[0]
      execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'])
      const exe = join(directory, 'fixture.exe')
      await copyFile(join(process.env.SystemRoot, 'System32', 'whoami.exe'), exe)
      await checkRouterLauncher(exe, { register: true })
      execFileSync('icacls.exe', [exe, '/grant', '*S-1-1-0:(W)'])
      await assert.rejects(checkRouterLauncher(exe), /写入权限/)
      const state = join(directory, 'router')
      await prepareWindowsRouterDirectory(state)
      await prepareWindowsRouterDirectory(state)
      execFileSync('icacls.exe', [state, '/grant', '*S-1-1-0:(RX)'])
      await assert.rejects(prepareWindowsRouterDirectory(state), /私有真实目录/)
    } else {
      const path = join(directory, 'launcher')
      await writeFile(path, '#!/bin/sh\n', { mode: 0o700 })
      await checkRouterLauncher(path, { register: true })
      await chmod(path, 0o777)
      await assert.rejects(checkRouterLauncher(path, { register: true }), /不可写/)
      await chmod(path, 0o600)
      await assert.rejects(checkRouterLauncher(path), /可执行/)
    }
    const env = launcherEnvironment(directory, directory)
    assert.equal(env.HOME, directory)
    assert.equal(env.CODEX_ROUTER_CONFIG_DIR, directory)
    assert.ok(!('CODEX_HOME' in env) && !('OPENAI_API_KEY' in env))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

