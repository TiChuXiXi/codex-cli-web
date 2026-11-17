import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { createClientFilter } from './client-access.js'
import { join } from 'node:path'
const COOKIE='codex_web_session'
const digest=value=>createHash('sha256').update(String(value)).digest()
export async function readAccessToken(config) {
  if(config.accessToken) return config.accessToken
  await mkdir(config.stateDir,{recursive:true,mode:0o700})
  const path=join(config.stateDir,'access-token')
  try {
    await writeFile(path,randomBytes(32).toString('base64url')+'\n',{flag:'wx',mode:0o600})
  } catch(error) {if(error.code!=='EEXIST') throw error}
  await chmod(path,0o600)
  const token=(await readFile(path,'utf8')).trim()
  if(token.length<16) throw new Error('访问凭证文件无效，请重新设置')
  return token
}
export function json(response,status,value) {
  const body=JSON.stringify(value)
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':Buffer.byteLength(body)})
  response.end(body)
}
async function readLogin(request) {
  if(request.headers['content-type']?.split(';')[0]!=='application/json') throw new Error('请使用 JSON 请求')
  let size=0,body=''
  for await(const chunk of request) {size+=chunk.length;if(size>4096) throw new Error('登录请求过大');body+=chunk.toString()}
  const value=JSON.parse(body)
  return typeof value?.token==='string'?value.token:''
}
export function createAuth(config,token) {
  const sessions=new Map(),attempts=new Map()
  const networkMode=config.authMode==='network'
  const clientAllowed=createClientFilter(config.allowedClients ?? [])
  const hash=digest(token)
  let origin=''
  function revoke(id) {
    const session=sessions.get(id)
    sessions.delete(id)
    for(const response of session?.responses ?? []) response.destroy()
  }
  const timer=setInterval(()=>{
    for(const [id,s]of sessions) if(s.expiresAt<=Date.now()) revoke(id)
    for(const [ip,a]of attempts) if(a.until<=Date.now()) attempts.delete(ip)
  },1000)
  timer.unref()
  function sessionOf(request) {
    const cookie=request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)
    if(!cookie)return null
    const session=sessions.get(cookie)
    if(!session || session.expiresAt<=Date.now()) {revoke(cookie);return null}
    return {id:cookie,...session}
  }
  function originRejection(request) {
    if(networkMode && !clientAllowed(request.socket.remoteAddress))return 403
    if(!origin)return 403
    const host=request.headers.host
    if(typeof host!=='string' || ![new URL(origin).host,...config.allowedHosts].includes(host)) return 403
    const requestOrigin=request.headers.origin
    if(requestOrigin!==undefined && ![origin,...config.allowedOrigins].includes(requestOrigin)) return 403
    if(request.headers['sec-fetch-site']==='cross-site') return 403
    if(!['GET','HEAD'].includes(request.method) && requestOrigin===undefined && request.headers['x-codex-request']!=='1') return 403
  }
  return {
    setOrigin(value){origin=value},
    originRejection,
    requestRejection(request){return originRejection(request) ?? (networkMode || sessionOf(request)?undefined:401)},
    attach(request,response) {
      const session=sessionOf(request)
      if(!session)return
      session.responses.add(response)
      response.once('close',()=>session.responses.delete(response))
    },
    async handle(request,response,pathname) {
      const rejection=originRejection(request)
      if(rejection) return json(response,rejection,{error:'请求来源不允许'})
      if(networkMode) {
        if((pathname==='/auth/session' && request.method==='GET') || (['/auth/login','/auth/logout'].includes(pathname) && request.method==='POST'))
          return json(response,200,{authenticated:true,authMode:'network'})
        return json(response,404,{error:'认证接口不存在'})
      }
      if(pathname==='/auth/session'&&request.method==='GET') {
        const session=sessionOf(request)
        return json(response,200,{authenticated:!!session,authMode:'token',...(session?{expiresAt:session.expiresAt}:{})})
      }
      if(pathname==='/auth/logout'&&request.method==='POST') {
        const session=sessionOf(request)
        if(session) revoke(session.id)
        response.setHeader('set-cookie',COOKIE+'=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'+(origin.startsWith('https:')?'; Secure':''))
        return json(response,200,{authenticated:false})
      }
      if(pathname==='/auth/login'&&request.method==='POST') {
        const ip=request.socket.remoteAddress
        const attempt=attempts.get(ip)
        if(attempt?.count>=5 && attempt.until>Date.now()) {response.setHeader('retry-after','60');return json(response,429,{error:'尝试次数过多，请稍后重试'})}
        let supplied
        try{supplied=await readLogin(request)}catch{return json(response,400,{error:'登录请求格式无效'})}
        if(!timingSafeEqual(hash,digest(supplied))) {
          const entry=attempt && attempt.until>Date.now()?attempt:{count:0,until:Date.now()+60000}
          entry.count++;attempts.set(ip,entry)
          return json(response,401,{error:'访问凭证不正确'})
        }
        attempts.delete(ip)
        if(sessions.size>=100) revoke(sessions.keys().next().value)
        const id=randomBytes(32).toString('base64url'),expiresAt=Date.now()+config.sessionTtlMs
        sessions.set(id,{expiresAt,responses:new Set()})
        response.setHeader('set-cookie',COOKIE+'='+id+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+Math.floor(config.sessionTtlMs/1000)+(origin.startsWith('https:')?'; Secure':''))
        return json(response,200,{authenticated:true,expiresAt})
      }
      return json(response,404,{error:'认证接口不存在'})
    },
    dispose(){clearInterval(timer);for(const id of sessions.keys())revoke(id);attempts.clear()},
  }
}
