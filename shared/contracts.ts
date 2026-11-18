export type RpcResult<T = unknown> = {ok: true; value: T} | {ok: false; error: {code: string; message: string; details?: unknown}}
export interface RpcRequest {type: 'client-request'; rpcId: string; method: string; payload: Record<string, unknown>}
export interface RpcResponse<T = unknown> {type: 'server-response'; rpcId: string; result: RpcResult<T>}
export interface WebSession {authenticated: boolean; authMode?: 'token' | 'network'; expiresAt?: number}

export interface SubagentReadRequest {
  parentThreadId: string
  agentThreadId: string
  cursor?: string
  metadataOnly?: boolean
}

export interface RouterTask {
  id: string
  projectId: string
  project: string
  threadId: string | null
  turnId: string | null
  status: string
  createdAt: number
  updatedAt: number
  summary: string | null
  error: string | null
}

export interface RouterClarification {
  id: string
  revision: number
  kind: 'project' | 'session' | 'create' | 'interrupt'
  label: string
  original?: string
  candidates: { id: string; name: string; project?: string; summary?: string; updatedAt?: number; reasons?: string[] }[]
}

export interface RouterSnapshot {
  enabled: boolean
  phase: 'idle' | 'disabled' | 'connecting' | 'ready' | 'unavailable'
  error: string | null
  model: string | null
  busy: boolean
  messages: { id: string; role: 'user' | 'assistant'; text: string; status: string }[]
  clarifications: RouterClarification[]
  tasks: RouterTask[]
  latestEventId: number
}

export interface AccessSettings {
  authMode: 'token' | 'network'
  allowedClients: string[]
  clientIp: string | null
  revision: string
  editable: boolean
  lockedReason: string | null
  firewallManaged: boolean
}
