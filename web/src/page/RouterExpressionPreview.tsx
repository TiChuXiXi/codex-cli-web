import * as React from 'react'
import { deliveryFact, renderExpression, terminalFact, wechatParts } from '../../../shared/router-expression.js'
import type { RouterProfile } from '../../../shared/contracts'

const project='发布检查'
const scenarios=[
  ['普通聊天',{kind:'chat'}],
  ['任务已排队',deliveryFact(project,'queued')],
  ['任务已交付',deliveryFact(project,'delivered',{ackAt:1})],
  ['需要审批',{kind:'approval',target:project,detail:'请求在项目目录写入检查报告。\n1 允许本次\n2 拒绝'}],
  ['Worker 完成',{...terminalFact(project,{status:'completed',finalReply:'检查报告已生成。'}),verification:'验证：示例报告的检查项均通过。',background:'报告覆盖本次发布涉及的配置项。'}],
  ['任务失败',terminalFact(project,{status:'failed',error:'目录不可写，报告未生成。'})],
] as const
export function RouterExpressionPreview({profile}:{profile:RouterProfile}) {
  const [channel,setChannel]=React.useState('web')
  const [index,setIndex]=React.useState(0)
  const [longReport,setLongReport]=React.useState(false)
  const fact=scenarios[index][1]
  const checks=['配置加载','路径核对','数据格式','连接恢复','结果记录']
  const report=Array.from({length:36},(_,i)=>'检查 '+(i+1)+' · '+checks[i%checks.length]+'：已在独立测试目录完成核验，结果与预期一致。').join('\n')
  const content=renderExpression(index===4 && longReport?{...fact,result:'检查报告已生成。\n'+report}:fact,profile,channel)
  const parts=channel==='wechat'?wechatParts(content,profile.presentation.wechatLongContent):[content]
  return <aside className="rip-preview" aria-label="表达预览"><h3>表达预览</h3>
    <p>即时示例，实际对话的措辞会随上下文变化。</p>
    <div className="rip-switch" aria-label="预览渠道">{['web','wechat'].map(c=><button type="button" key={c} aria-pressed={channel===c} onClick={()=>setChannel(c)}>{c==='web'?'Web':'微信'}</button>)}</div>
    <div className="rip-scenes">{scenarios.map(([name],i)=><button type="button" key={name} aria-pressed={i===index} onClick={()=>setIndex(i)}>{name}</button>)}</div>
    {index===4 && <label className="rip-long"><input type="checkbox" checked={longReport} onChange={e=>setLongReport(e.target.checked)}/>查看长报告示例</label>}
    <div className="rip-sample" aria-live="polite"><strong>{profile.identity.name}</strong>{parts.map((part,i)=><p key={i}>{parts.length>1 && '（'+(i+1)+'/'+parts.length+'）\n'}{part}</p>)}</div>
    {index===1 && <small>{profile.presentation.notificationLevel==='key_events'?'当次派发会反馈，排队阶段不会额外推送。':'排队阶段可以主动通知。'}</small>}
  </aside>
}
