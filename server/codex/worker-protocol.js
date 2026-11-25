import verifiedProtocols from './verified-worker-protocols.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'

export async function runningBinaryDigest(rpc) {
  const { process: server } = await rpc.request('server/diagnostics', {}, { timeoutMs: 3000 })
  if (!Number.isSafeInteger(server?.id) || server.id < 1) throw new Error('缺少本地运行进程身份')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream('/proc/' + server.id + '/exe')) hash.update(chunk)
  return hash.digest('hex')
}

export function baselineProtocol(version, transport) {
  const steer = version === '0.170.0' || (version === '0.171.0' && ['stdio','daemon'].includes(transport))
  const queue = version === '0.169.1' || steer
  return { queue, steer, source: queue ? 'baseline' : 'unverified' }
}

export async function workerProtocol(rpc, version, transport, reportPath) {
  const unavailable = { queue: false, steer: false, source: 'unverified' }
  if (!version || process.platform !== 'linux') return reportPath ? unavailable : baselineProtocol(version, transport)
  try {
    const records = reportPath ? [JSON.parse(await readFile(reportPath, 'utf8')).workerProtocol] : verifiedProtocols
    const record = records.find(item => item?.format === 1 && item.version === version &&
      item.transport === transport && item.platform === process.platform && item.arch === process.arch)
    if (!record) return reportPath ? unavailable : baselineProtocol(version, transport)
    if (!/^[a-f0-9]{64}$/.test(record.sha256) || record.sha256 !== await runningBinaryDigest(rpc)) return unavailable
    return { queue: record.queue === true, steer: record.steer === true, source: 'fixture' }
  } catch {
    return unavailable
  }
}
