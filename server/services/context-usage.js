import { open } from 'node:fs/promises'

// Read only the recent rollout tail; large histories must not delay opening a thread.
const MAX_TAIL_BYTES = 2 * 1024 * 1024

export async function readContextUsage(path) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return null
  let file
  try {
    file = await open(path, 'r')
    const { size } = await file.stat()
    const start = Math.max(0, size - MAX_TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n')
    if (start > 0) lines.shift()
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue
      let entry
      try { entry = JSON.parse(lines[i]) } catch { continue }
      const info = entry.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info : null
      if (!info?.last_token_usage) continue
      const counters = (value) => ({
        totalTokens: value?.total_tokens ?? null,
        inputTokens: value?.input_tokens ?? null,
        cachedInputTokens: value?.cached_input_tokens ?? null,
        outputTokens: value?.output_tokens ?? null,
        reasoningOutputTokens: value?.reasoning_output_tokens ?? null,
      })
      return {
        last: counters(info.last_token_usage),
        total: counters(info.total_token_usage),
        modelContextWindow: info.model_context_window ?? null,
      }
    }
  } catch {
    // Ephemeral, missing or unreadable rollouts have no usage snapshot.
  } finally {
    await file?.close().catch(() => {})
  }
  return null
}
