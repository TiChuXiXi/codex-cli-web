import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalService } from '../server/services/terminal.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(t) {
  const service = new TerminalService()
  t.after(() => service.dispose())
  const opened = await service.open({ cwd: process.cwd(), cols: 80, rows: 24 })
  let cursor = 0, output = ''
  const read = async () => {
    const result = await service.read({ sessionId: opened.sessionId, cursor })
    cursor = result.cursor
    output += result.data
    return result
  }
  const until = async (pattern) => {
    const end = Date.now() + 8000
    while (!pattern.test(output)) {
      assert.ok(Date.now() < end, 'missing output: ' + pattern + '\n' + output.slice(-2000))
      await read()
    }
    return output
  }
  const write = data => service.write({ sessionId: opened.sessionId, data })
  write("PS1='PTY> '; printf '\\033[2J'; echo READY_MARKER\r")
  await until(/READY_MARKER\r\n/)
  return { service, ...opened, read, until, write, output: () => output, cursor: () => cursor }
}

test('real PTY keeps cwd/env, accepts hidden input, Ctrl+C, resize and shell exit', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  f.write("cd /tmp\r")
  f.write("printf 'CWD=%s\\n' \"$PWD\"; export DSH_TERMINAL_TEST=persisted\r")
  await f.until(/CWD=\/tmp\r\n/)
  f.write("printf 'ENV=%s\\n' \"$DSH_TERMINAL_TEST\"; test -t 0 && echo REAL_TTY\r")
  await f.until(/ENV=persisted\r\nREAL_TTY\r\n/)
  f.write("read -rs -p 'Password: ' secret; printf '\\nSECRET_LEN=%s\\n' \"${#secret}\"\r")
  await f.until(/Password: $/)
  f.write("do-not-echo-this\r")
  await f.until(/SECRET_LEN=16\r\n/)
  assert.ok(!f.output().includes('do-not-echo-this'))
  f.service.resize({ sessionId: f.sessionId, cols: 103, rows: 37 })
  f.write("stty size\r")
  await f.until(/37 103\r\n/)
  f.write("sleep 60\r")
  await delay(100)
  f.write("\x03")
  f.write("echo INTERRUPTED_OK\r")
  await f.until(/INTERRUPTED_OK\r\n/)
  f.write("exit 7\r")
  let result
  do { result = await f.read() } while (!result.exited)
  assert.equal(result.exitCode, 7)
  assert.throws(() => f.write('x'), /已退出/)
})

test('sessions are isolated, pending reads cancel, close and dispose release sessions', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const second = await f.service.open({ cwd: process.cwd() })
  f.write("cd /tmp; export DSH_TERMINAL_PRIVATE=one\r")
  f.service.write({ sessionId: second.sessionId, data: "printf 'SECOND=%s:%s\\n' \"$PWD\" \"${DSH_TERMINAL_PRIVATE-unset}\"\r" })
  let output = '', cursor = 0
  while (!output.includes(':unset\r\n')) {
    const result = await f.service.read({ sessionId: second.sessionId, cursor })
    output += result.data
    cursor = result.cursor
  }
  assert.ok(output.includes('SECOND=' + process.cwd() + ':unset'))
  const controller = new AbortController()
  const pending = f.service.read({ sessionId: second.sessionId, cursor }, controller.signal)
  controller.abort()
  await assert.rejects(pending, /读取已取消/)
  const waiting = f.service.read({ sessionId: second.sessionId, cursor })
  f.service.close(second.sessionId)
  assert.equal((await waiting).exited, true)
  assert.equal(f.service.count, 1)
  assert.deepEqual(f.service.close(second.sessionId), { closed: true })
  await assert.rejects(f.service.read({ sessionId: second.sessionId }), /过期/)
  f.service.dispose()
  assert.equal(f.service.count, 0)
  await assert.rejects(f.service.open({ cwd: process.cwd() }), /服务已关闭/)
})

test('PTY validation rejects invalid directories, dimensions, cursors and oversized input', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.open({ cwd: '.' }), /绝对路径/)
  await assert.rejects(f.service.open({ cwd: process.cwd(), cols: 0 }), /尺寸/)
  assert.throws(() => f.service.resize({ sessionId: f.sessionId, cols: 999, rows: 24 }), /尺寸/)
  assert.throws(() => f.write('x'.repeat(65537)), /输入过长/)
  await assert.rejects(f.service.read({ sessionId: f.sessionId, cursor: Number.MAX_SAFE_INTEGER }), /输出位置/)
})

test('large PTY output is bounded and resumes after client consumption', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  f.write("head -c 1500000 /dev/zero | tr '\\0' x; printf '\\nFLOOD_DONE\\n'\r")
  await delay(150)
  await f.until(/\r\nFLOOD_DONE\r\n/)
  assert.ok(f.output().length >= 1500000)
  const replay = await f.service.read({ sessionId: f.sessionId, cursor: 0 })
  assert.equal(replay.truncated, true)
  assert.ok(replay.data.length <= 1024 * 1024)
})

test('closing a PTY hangs up the shell and its foreground process', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  f.write("echo SHELL_PID=$$; sleep 60 & echo CHILD_PID=$!; wait\r")
  await f.until(/CHILD_PID=\d+\r\n/)
  const shell = Number(f.output().match(/SHELL_PID=(\d+)\r\n/)[1])
  const child = Number(f.output().match(/CHILD_PID=(\d+)\r\n/)[1])
  f.service.close(f.sessionId)
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  for (let tries = 0; tries < 100 && (alive(shell) || alive(child)); tries++) await delay(20)
  assert.equal(alive(shell), false)
  assert.equal(alive(child), false)
})
