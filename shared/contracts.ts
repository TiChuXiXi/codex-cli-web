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

export interface AccessSettings {
  authMode: 'token' | 'network'
  allowedClients: string[]
  clientIp: string | null
  revision: string
  editable: boolean
  lockedReason: string | null
  firewallManaged: boolean
}
