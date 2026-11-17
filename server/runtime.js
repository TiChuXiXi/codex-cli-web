import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
export function createRuntime() {
  const instanceId=randomUUID(),startedAt=new Date().toISOString()
  const hash=createHash('sha256')
  for(const path of ['./bootstrap.js','./api/routes.js','./codex/hub.js','./services/terminal.js','./services/git.js','./services/followups.js','./services/events.js'])hash.update(readFileSync(new URL(path,import.meta.url)))
  const buildId=hash.digest('hex').slice(0,16)
  return ()=>({hostRevision:'standalone-1',hostBuildId:buildId,hostInstanceId:instanceId,startedAt,hostPid:process.pid,activeInstances:1})
}
