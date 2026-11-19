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
  worker?: {model:string; effort:string; executionMode:'default'|'plan'; permission?:string}
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
  receiptStatus?: 'pending' | 'claimed' | 'delivered' | 'unknown' | 'failed' | null
}

export interface RouterClarification {
  id: string
  revision: number
  kind: 'project' | 'session' | 'create' | 'interrupt' | 'projectRoot' | 'workerPermission' | 'psmMemory' | 'psmAccess'
  label: string
  original?: string
  candidates: { id: string; name: string; project?: string; summary?: string; updatedAt?: number; reasons?: string[] }[]
}

export interface EffortOption {
  reasoningEffort: string
  description?: string | null
}

export interface ModelOption {
  id: string
  displayName: string
  description?: string | null
  defaultReasoningEffort?: string | null
  supportedReasoningEfforts?: EffortOption[]
}

export interface RouterSnapshot {
  primaryThreadId?: string
  previousThreads?: string[]
  enabled: boolean
  phase: 'idle' | 'disabled' | 'connecting' | 'ready' | 'unavailable'
  error: string | null
  model: string | null
  busy: boolean
  effort: string | null
  models: ModelOption[]
  usingDefaultModel: boolean
  queuedCount?: number
  receiptLimited?: boolean
  messages: {
    id: string; role: 'user' | 'assistant'; label?: string; text: string; status: string
    dispatchId?: string; interactionMethod?: string
    questions?: { title: string; options?: string[] | null }[]
  }[]
  interactions: {
    requestId: string | number; instanceId: string; method: string; params: Record<string, unknown>
    createdAt: number; dispatchId: string; worker: string; instruction: string
  }[]
  clarifications: RouterClarification[]
  tasks: RouterTask[]
  latestEventId: number
}

export interface WeChatStatus {
  phase: 'unbound' | 'waiting_scan' | 'waiting_confirmation' | 'waiting_pin' | 'connected' | 'reconnecting' | 'disconnected' | 'expired' | 'error'
  hasBinding: boolean
  owner: string | null
  qr: string | null
  loginId: string | null
  canNotify: boolean
  results: boolean
  decisions: boolean
  lastReceived: number | null
  lastSent: number | null
  pending: number
  unknown: number
  failed: number
  error: string | null
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
