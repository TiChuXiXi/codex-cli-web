import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { ConsolePage } from './page/ConsolePage'
import { fallbackTranslate } from './i18n'
import { installStyles } from './styles'
import { api } from './api'
import { CodexIcon } from './components/CodexIcon'
import './standalone.css'
import type { WebSession } from '../../shared/contracts'

installStyles()
function App() {
  const [session,setSession]=React.useState<WebSession|null>(null)
  const [token,setToken]=React.useState('')
  const [error,setError]=React.useState('')
  const [busy,setBusy]=React.useState(false)
  const [connectionError,setConnectionError]=React.useState(false)
  const check=React.useCallback(async()=>{
    try{
      const response=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store'})
      if(!response.ok)throw new Error('无法读取登录状态')
      setSession(await response.json())
      setConnectionError(false)
      setError(current=>current==='无法连接服务，请检查服务状态后重试。'?'':current)
    }catch{setConnectionError(true);setError('无法连接服务，请检查服务状态后重试。');setSession({authenticated:false})}
  },[])
  React.useEffect(()=>{
    void check()
    const expired=()=>{setSession({authenticated:false});setError('登录已失效，请重新输入访问凭证。')}
    const focus=()=>{void check()}
    window.addEventListener('codex-web:unauthorized',expired)
    window.addEventListener('focus',focus)
    const interval=setInterval(focus,30000)
    return()=>{window.removeEventListener('codex-web:unauthorized',expired);window.removeEventListener('focus',focus);clearInterval(interval)}
  },[check])
  const login=async(event:React.FormEvent)=>{
    event.preventDefault();setBusy(true);setError('')
    try{
      const response=await fetch('/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-codex-request':'1'},body:JSON.stringify({token})})
      const value=await response.json()
      if(!response.ok)throw new Error(value.error ?? '登录失败，请重试')
      setToken('');setSession(value)
    }catch(error){setError(error instanceof Error?error.message:'登录失败，请重试')}
    finally{setBusy(false)}
  }
  const logout=async()=>{
    try {
      const response=await fetch('/auth/logout',{method:'POST',headers:{'x-codex-request':'1'}})
      if(!response.ok)throw new Error('退出失败，请重试')
      setSession({authenticated:false})
    }catch(error){window.alert(error instanceof Error?error.message:'退出失败')}
  }
  if(session?.authenticated)return <ConsolePage api={api} t={fallbackTranslate} onExit={session.authMode==='network'?undefined:()=>{void logout()}}/>
  return <main className="codex-login"><form onSubmit={login} className="codex-login-form">
    <CodexIcon/><h1>Codex CLI</h1>
    <p>{session===null?'正在连接工作台…':'输入此服务的访问凭证，打开工作台。'}</p>
    <label htmlFor="access-token">访问凭证</label>
    <input id="access-token" type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="current-password" required autoFocus disabled={busy||session===null}/>
    <button type="submit" disabled={busy||session===null||!token.trim()}>{busy?'正在登录…':'登录工作台'}</button>
    {error&&<p role="alert" className="codex-login-error">{error}</p>}
    <p className="codex-login-help">访问凭证由此服务的启动者提供，与 Codex 账号分开。</p>
    {connectionError&&<button type="button" onClick={()=>void check()}>重试连接</button>}
  </form></main>
}
createRoot(document.getElementById('root')!).render(<App/>)
