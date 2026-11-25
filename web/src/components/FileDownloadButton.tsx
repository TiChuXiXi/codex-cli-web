import {apiUrl} from '../api'
import * as React from 'react'
import type {Api} from '../rpc'
import {Icon} from './Icon'

export async function downloadWorkspaceFileById(api:Api,workspaceId:string,path:string) {
  const info=await api<{name:string}>('workspace/downloadInfo',{workspaceId,path})
  const link=document.createElement('a')
  link.href=apiUrl('workspace/download',new URLSearchParams({workspaceId,path}))
  link.download=info.name
  document.body.appendChild(link);link.click();link.remove()
  return info.name
}

export async function downloadWorkspaceFile(api:Api,cwd:string,path:string) {
  const workspace=await api<{workspaceId:string}>('workspace/open',{cwd})
  return downloadWorkspaceFileById(api,workspace.workspaceId,path)
}
export function FileDownloadButton({api,cwd,path,children,className=''}:{
 api:Api,cwd:string,path:string,children?:React.ReactNode,className?:string
}){
 const [busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
 return <span className="dsh-codex-download"><button type="button" className={className||'dsh-codex-download-button'} title={'下载 '+path} aria-label={'下载 '+path.split('/').at(-1)} disabled={busy} onClick={async()=>{
   setBusy(true);setError('')
   try{await downloadWorkspaceFile(api,cwd,path)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
 }}>{children||<Icon name={busy?'loader':'download'} size={15}/>}</button>{error&&<span role="alert" className="dsh-codex-download-error">{error}</span>}</span>
}
