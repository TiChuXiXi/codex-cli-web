import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HubError } from '../codex/hub.js'
import { MAX_UPLOAD_BYTES } from '../../shared/limits.js'

/** Persist raw bytes with bounded stream buffers. Partial files never become attachments. */
export async function saveUploadStream({ cwd, name, size, stream, signal }) {
  if (typeof cwd !== 'string' || cwd.trim() === '' || !Number.isSafeInteger(size) || size <= 0) {
    throw new HubError('codex-cli/bad-request', '请选择非空文件及有效的工作区')
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new HubError('codex-cli/file-too-large', '文件超过单文件 500 MiB 上限', { limit: MAX_UPLOAD_BYTES, size })
  }
  const root = await realpath(cwd)
  if (!(await stat(root)).isDirectory()) throw new HubError('codex-cli/not-a-directory', '工作区不是文件夹')
  const directory = join(root, '.dsh-uploads', 'codex-cli')
  await mkdir(directory, { recursive: true })
  const actual = await realpath(directory)
  if (!actual.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new HubError('codex-cli/bad-request', '上传目录超出工作区')
  }
  const safe = String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file'
  const id = randomUUID()
  const temporary = join(actual, '.upload-' + id + '.part')
  const destination = join(actual, Date.now() + '-' + id + '-' + safe)
  let received = 0
  let published = false
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length
      if (received > size || received > MAX_UPLOAD_BYTES) {
        callback(new HubError('codex-cli/file-too-large', '上传数据超过声明的文件大小或 500 MiB 上限'))
      } else callback(null, chunk)
    },
  })
  try {
    await pipeline(stream, counter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
    if (received !== size) throw new HubError('codex-cli/upload-incomplete', '文件上传不完整，请重试')
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError')
    // Check the directory again before making the upload visible.
    if (await realpath(directory) !== actual) throw new HubError('codex-cli/bad-request', '上传目录已变更，请重试')
    await rename(temporary, destination)
    published = true
    return { path: destination, name: safe, size: received }
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => {})
  }
}
