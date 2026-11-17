import { apiUrl, sessionExpired } from './api'
import { MAX_UPLOAD_BYTES } from '../../shared/limits.js'
export { MAX_UPLOAD_BYTES }
export interface UploadedFile { path: string, name: string, size: number }
export interface UploadProgress { loaded: number, total: number, saving: boolean }

/** Send the File itself; neither the file nor a Base64 copy is loaded into JS memory. */
export function uploadFile(file: File, cwd: string, signal: AbortSignal, onProgress: (progress: UploadProgress) => void): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return }
    const xhr = new XMLHttpRequest()
    let settled = false
    let timer: number | undefined
    const failure = (code: string, message = '') => Object.assign(new Error(message), { code })
    const finish = (error?: Error, value?: UploadedFile) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve(value!)
    }
    const touch = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        finish(failure('upload-timeout'))
        xhr.abort()
      }, 120000)
    }
    const cancel = () => {
      finish(new DOMException('Upload cancelled', 'AbortError'))
      xhr.abort()
    }
    xhr.upload.onprogress = event => {
      if (settled) return
      touch()
      onProgress({ loaded: Math.min(file.size, event.loaded), total: file.size, saving: false })
    }
    xhr.upload.onload = () => {
      if (settled) return
      touch()
      onProgress({ loaded: file.size, total: file.size, saving: true })
    }
    xhr.onload = () => {
        if (xhr.status === 401) sessionExpired()
      const result = xhr.response
      if (xhr.status >= 200 && xhr.status < 300 && result?.ok === true && typeof result.value?.path === 'string') {
        finish(undefined, result.value)
      } else {
        finish(failure(result?.error?.code || 'http-' + xhr.status, result?.error?.message || ''))
      }
    }
    xhr.onerror = () => finish(failure('upload-network'))
    xhr.onabort = () => finish(new DOMException('Upload cancelled', 'AbortError'))
    const query = new URLSearchParams({ cwd, name: file.webkitRelativePath || file.name, size: String(file.size) })
    try {
      xhr.open('POST', apiUrl('upload/file', query))
      xhr.setRequestHeader('x-codex-request', '1')
      xhr.responseType = 'json'
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) { cancel(); return }
      touch()
      onProgress({ loaded: 0, total: file.size, saving: false })
      xhr.send(file)
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}

export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MiB'
}
