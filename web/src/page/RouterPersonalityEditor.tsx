import * as React from 'react'
import { dimensions, policies, presets, presetValues } from '../../../shared/router-presentation.js'
import { responsibilities } from '../../../shared/router-identity.js'
import { deliveryFact, renderExpression } from '../../../shared/router-expression.js'
import type { RouterExpressionSettings } from '../../../shared/contracts'

type Props=Pick<RouterExpressionSettings,'profile'|'legacyExpression'> & {onChange:(update:Partial<RouterExpressionSettings>)=>void}
function Options({label,options,value,change}:{label:string;options:Record<string,string[]>;value:string;change:(value:string)=>void}) {
  return <fieldset className="rip-option"><legend>{label}</legend><div className="rip-segments">{Object.entries(options).map(([key,[name]])=>
    <label key={key}><input type="radio" name={label} value={key} checked={key===value} onChange={()=>change(key)}/><span>{name}</span></label>)}</div><small>{options[value][1]}</small></fieldset>
}
export function RouterPersonalityEditor({profile,legacyExpression,onChange}:Props) {
  const {identity,personality,presentation}=profile
  const preset=presets[personality.preset as keyof typeof presets]
  const custom=Object.keys(dimensions).some(key=>personality[key as keyof typeof dimensions]!==preset[key as keyof typeof dimensions])
  const setPersonality=(update:Partial<typeof personality>)=>onChange({profile:{...profile,personality:{...personality,...update}}})
  return <div className="rip-editor">
    <section><h3>助手身份</h3><div className="rip-identity">{([['name','助手名称','对话中显示的名字'],['selfReference','自称','助手如何称呼自己']] as const).map(([key,label,hint])=>
      <label key={key}>{label}<input required maxLength={32} value={identity[key]} onChange={e=>onChange({profile:{...profile,identity:{...identity,[key]:e.target.value}}})}/><small>{hint}</small></label>)}</div></section>
    <fieldset><legend>人格预设</legend><div className="rip-cards">{(Object.keys(presets) as (keyof typeof presets)[]).map(key=><label key={key}>
      <input type="radio" name="人格预设" aria-label={presets[key].label} checked={personality.preset===key} onChange={()=>setPersonality(presetValues(key))}/>
      <span><strong>{presets[key].label}</strong><small>{presets[key].description}</small><em>{renderExpression(deliveryFact('发布检查','queued'),{...profile,personality:{...personality,...presetValues(key)},presentation:{...presentation,dispatchFeedback:'minimal'}})}</em></span></label>)}</div></fieldset>
    <section><h3>人格微调</h3><div className="rip-origin">{custom?'基于 '+preset.label+' · 已自定义':preset.label+' · 预设档位'}{custom && <button type="button" onClick={()=>setPersonality(presetValues(personality.preset))}>恢复当前预设</button>}</div>
      {Object.entries(dimensions).map(([key,field])=><Options key={key} {...field} value={personality[key as keyof typeof dimensions]} change={v=>setPersonality({[key]:v})}/>)}</section>
    <section><h3>表达策略</h3>{Object.entries(policies).map(([key,field])=><Options key={key} {...field} value={presentation[key as keyof typeof policies]} change={v=>onChange({profile:{...profile,presentation:{...presentation,[key]:v}}})}/>)}</section>
    <details><summary>高级表达偏好</summary><label>额外表达偏好<textarea rows={3} maxLength={320} value={personality.customExpression} onChange={e=>setPersonality({customExpression:e.target.value})}/></label>
      <small>仅用于措辞，职责、权限和任务操作由工作台控制。 {personality.customExpression.length}/320</small>
      {Object.entries(legacyExpression).map(([key,value])=><div key={key}><strong>原有{({personality:'人格描述',style:'语言风格',wechatStyle:'微信偏好'} as Record<string,string>)[key]}</strong><p>{value}</p>
        <button type="button" disabled={[personality.customExpression,value].filter(Boolean).join('\n').length>320} onClick={()=>{
          const next={...legacyExpression};delete next[key as keyof typeof next]
          onChange({legacyExpression:next,profile:{...profile,personality:{...personality,customExpression:[personality.customExpression,value].filter(Boolean).join('\n')}}})
        }}>转为通用表达偏好</button>
        <button type="button" onClick={()=>{const next={...legacyExpression};delete next[key as keyof typeof next];onChange({legacyExpression:next})}}>清除此项旧偏好</button></div>)}</details>
    <section><h3>身份职责 <small>只读</small></h3><ul>{responsibilities.map(rule=><li key={rule}>{rule}</li>)}</ul></section>
  </div>
}
