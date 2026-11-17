import { randomId } from './randomId'
import type { Api, Envelope } from './rpc'
import type { RpcResponse } from '../../shared/contracts'
export function apiUrl(endpoint: string, query?: URLSearchParams): string {
  const url=new URL('/codex-cli/'+endpoint,window.location.origin)
  if(query)url.search=query.toString()
  return url.toString()
}
export function sessionExpired() { window.dispatchEvent(new Event('codex-web:unauthorized')) }
export const api: Api = async <T=unknown>(endpoint:string,payload:unknown={},options?:{signal?:AbortSignal}) => {
  const rpcId=randomId()
  const response=await fetch(apiUrl(endpoint),{
    signal:options?.signal,method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-codex-request':'1'},
    body:JSON.stringify({type:'client-request',rpcId,method:endpoint,payload}),
  })
  if(response.status===401)sessionExpired()
  if(!response.ok)throw Object.assign(new Error(response.status===401?'登录已失效，请重新登录':'请求失败（'+response.status+'）'),{code:'http/'+response.status})
  const message=await response.json() as RpcResponse<T>
  if(message.type!=='server-response'||message.rpcId!==rpcId||!message.result)throw new Error('服务返回了无效响应')
  const result=message.result as Envelope
  if(result.ok!==true) {
    const error=result.error
    throw Object.assign(new Error(error?.message ?? '请求失败'),{code:error?.code,details:error?.details})
  }
  return result.value as T
}
