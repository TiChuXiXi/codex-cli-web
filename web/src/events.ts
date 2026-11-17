import { createEpochGuard } from './streamEpoch'
import { apiUrl } from './api'
/**
 * 浏览器侧 SSE：文档相对路径，跟随页面的认证 Cookie。
 *
 * EventSource 断线会自动重连；重连时浏览器会带 Last-Event-ID，宿主优先用它，
 * 其次用创建时的 since 查询参数。缺口超出宿主缓冲时宿主会发 resync，调用方整页重拉。
 */

import type { CodexEvent } from './types'

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface EventStreamOptions {
  onEvent: (event: CodexEvent) => void
  onState: (state: StreamState) => void
}

/** 打开事件流；返回关闭函数。 */
export function openEventStream({ onEvent, onState }: EventStreamOptions): () => void {
  const checkEpoch = createEpochGuard()
  let closed = false
  let source: EventSource | null = null

  const connect = () => {
    if (closed) return
    const url = new URL(apiUrl('events'))
    source = new EventSource(url.toString())
    source.onopen = () => onState('open')
    source.onerror = () => onState('reconnecting')
    source.onmessage = (message) => {
      let event: CodexEvent
      try {
        event = JSON.parse(message.data)
      } catch {
        return
      }
      if (event.type === 'hello' && checkEpoch(event.payload?.instanceId, event.seq)) {
        onEvent({seq:event.seq,ts:event.ts,type:'resync',payload:{reason:'instance'}})
      }
      onEvent(event)
    }
  }

  onState('connecting')
  connect()

  return () => {
    closed = true
    source?.close()
    source = null
    onState('reconnecting')
  }
}
