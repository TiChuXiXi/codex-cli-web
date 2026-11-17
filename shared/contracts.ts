export type RpcResult<T = unknown> = {ok: true; value: T} | {ok: false; error: {code: string; message: string; details?: unknown}}
export interface RpcRequest {type: 'client-request'; rpcId: string; method: string; payload: Record<string, unknown>}
export interface RpcResponse<T = unknown> {type: 'server-response'; rpcId: string; result: RpcResult<T>}
export interface WebSession {authenticated: boolean; authMode?: 'token' | 'network'; expiresAt?: number}
