export const defaultPresentation = Object.freeze({
  displayName: '中枢', selfName: '我', personality: '专业、温和、做事利落。',
  style: '自然交流，直接回答，少用内部术语。', brevity: '简洁',
  wechatStyle: '短句；先说结果或需要我决定的事项。命令、目录和选项按实际内容保留。',
  typing: true, processingSeconds: 3, stageSeconds: 15,
})

const permissions = {
  psmAccess: { legacy: '允许 Router 阅读此项目的会话历史？', action: '读取这个项目的会话历史' },
  project: { legacy: '允许 Router 使用此项目并继续当前任务？', action: '使用这个项目继续当前任务' },
  session: { legacy: '允许 Router 按这个会话的现有权限续接？', action: '沿用这个会话的现有权限继续任务' },
}

export function clarificationLabel(item, selfName = defaultPresentation.selfName) {
  const prompt = permissions[item.kind]
  // Older pending cards only stored the built-in title. Preserve custom questions verbatim.
  if (prompt && (item.permissionQuestion || (!item.semanticChoice && item.label === prompt.legacy))) {
    return '可以让' + selfName + prompt.action + '吗？'
  }
  return item.label
}

export const presets = {
  professional: { label: '专业干练', description: '清晰、可靠、克制', warmth: 'balanced', liveliness: 'calm', directness: 'natural' },
  friendly: { label: '自然亲切', description: '温和随和，像熟悉的同事', warmth: 'warm', liveliness: 'relaxed', directness: 'natural' },
  lively: { label: '轻松灵动', description: '轻快自然，有一点俏皮', warmth: 'balanced', liveliness: 'lively', directness: 'direct' },
}

// Each option pairs its visible label with the rule used in the turn context.
export const dimensions = {
  warmth: {label:'亲和程度', options:{
    restrained:['克制','直接陈述事实，少用寒暄。'], balanced:['温和','礼貌回应，措辞平和。'], warm:['亲切','适当回应用户处境，用协作口吻。']}},
  liveliness: {label:'活泼程度', options:{
    calm:['沉稳','使用平实陈述句。'], relaxed:['轻松','采用自然口语衔接。'], lively:['灵动','使用轻快短句，适度俏皮。']}},
  directness: {label:'表达结构', options:{
    direct:['结论先行','先说结论，再给依据。'], natural:['自然叙述','按事情发生的顺序组织内容。'], detailed:['分步说明','把相同信息分成步骤，保持所选篇幅。']}},
}

export const policies = {
  verbosity:{label:'回复篇幅', options:{concise:['简洁','给结果及必要动作。'],standard:['标准','补充关键背景。'],detailed:['详细','展开相关背景、依据和后续事项。']}},
  technicalDetail:{label:'技术细节',options:{on_demand:['按需展示','操作需要或用户询问时给出技术依据。'],moderate:['适度展示','附上关键技术依据。'],technical_first:['优先展示','优先呈现相关的技术证据。']}},
  dispatchFeedback:{label:'任务交付反馈',options:{minimal:['极简','说明目标及真实交付状态。'],standard:['标准','补充已知的等待原因或交付含义。']}},
  completionStyle:{label:'完成结果',options:{result_first:['结论优先','先报告实际结果。'],result_and_verification:['结论加验证','同时列出已有验证及重要缺口。']}},
  notificationLevel:{label:'主动通知',options:{key_events:['关键事件','主动提示决策、终态、错误和风险。'],important_stages:['全部重要阶段','也主动提示查找、排队和开始执行。']}},
  wechatLongContent:{label:'微信长内容',options:{summary_first:['摘要优先','先发摘要，长文可在工作台查看。'],full_segmented:['分段完整','分段发送长文，超过发送上限时提示查看工作台。']}},
}

/** @param {keyof typeof presets} key
 * @returns {Pick<import('./contracts').RouterProfile['personality'],'preset'|'warmth'|'liveliness'|'directness'>}
 */
export function presetValues(key) {
  const {warmth,liveliness,directness} = presets[key]
  return {preset:key,warmth,liveliness,directness}
}

/** @returns {import('./contracts').RouterProfile} */
export function defaultProfile() {
  return {identity:{name:'中枢',selfReference:'我'},personality:{...presetValues('professional'),customExpression:''},
    presentation:{verbosity:'concise',technicalDetail:'on_demand',dispatchFeedback:'standard',
      completionStyle:'result_and_verification',notificationLevel:'key_events',wechatLongContent:'summary_first'}}
}
const brevities = {简洁:'concise',适中:'standard',详细:'detailed'}
const freeFields = {personality:320,style:240,wechatStyle:320}
const plain = value => !!value && typeof value==='object' && !Array.isArray(value)
function fail(message) { throw new TypeError(message) }
function shape(value, keys) {
  if (!plain(value) || Object.keys(value).some(k=>!keys.includes(k))) fail('设置包含未知字段或格式错误')
}
function string(value,limit,optional=false) {
  if (typeof value!=='string' || (!optional && !value.trim()) || value.length>limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('名称或表达偏好为空、过长或包含控制字符')
  return value.trim()
}
function choice(options,value) {
  if (typeof value!=='string' || !Object.hasOwn(options,value)) fail('不支持的表达选项')
  return value
}
export function validateProfile(input) {
  const profile=defaultProfile()
  shape(input,Object.keys(profile))
  for (const section of Object.keys(profile)) shape(input[section],Object.keys(profile[section]))
  for (const key of Object.keys(profile.identity)) {
    profile.identity[key]=string(input.identity[key],32)
    if(/[\r\n\t\u2028\u2029]/u.test(profile.identity[key])) fail('名称和自称须为单行')
  }
  profile.personality.preset=choice(presets,input.personality.preset)
  profile.personality.customExpression=string(input.personality.customExpression,320,true)
  for (const [key,field] of Object.entries(dimensions)) profile.personality[key]=choice(field.options,input.personality[key])
  for (const [key,field] of Object.entries(policies)) profile.presentation[key]=choice(field.options,input.presentation[key])
  return profile
}
function processing(value) {
  shape(value,['typing','processingSeconds','stageSeconds'])
  const {typing,processingSeconds,stageSeconds}=value
  if (typeof typing!=='boolean' || !Number.isInteger(processingSeconds) || processingSeconds<1 || processingSeconds>60 ||
      !Number.isInteger(stageSeconds) || stageSeconds<processingSeconds || stageSeconds>600) fail('请检查微信反馈时间')
  return {typing,processingSeconds,stageSeconds}
}
function legacyText(input) {
  shape(input,Object.keys(freeFields))
  return Object.fromEntries(Object.entries(input).map(([k,v])=>[k,string(v,freeFields[k])]))
}
export function profileSettings(record={}) {
  if (record.profileVersion!==undefined && record.profileVersion!==1) fail('无法读取此版本的表达设置')
  if (record.profileVersion===1) return {profileVersion:1,profile:validateProfile(record.profile),
    wechatProcessing:processing(record.wechatProcessing),legacyExpression:legacyText(record.legacyExpression ?? {})}
  const flat={...defaultPresentation,...record.presentation}, profile=defaultProfile()
  shape(flat,Object.keys(defaultPresentation))
  profile.identity={name:flat.displayName,selfReference:flat.selfName}
  profile.presentation.verbosity=brevities[choice(brevities,flat.brevity)]
  return {profileVersion:1,profile:validateProfile(profile),wechatProcessing:processing({typing:flat.typing,
    processingSeconds:flat.processingSeconds,stageSeconds:flat.stageSeconds}),
    legacyExpression:legacyText(Object.fromEntries(Object.keys(freeFields).filter(k=>flat[k]!==defaultPresentation[k]).map(k=>[k,flat[k]])))}
}
export function legacyPresentation({profile,wechatProcessing,legacyExpression}) {
  return {...defaultPresentation,...legacyExpression,...wechatProcessing,displayName:profile.identity.name,selfName:profile.identity.selfReference,
    brevity:Object.keys(brevities).find(k=>brevities[k]===profile.presentation.verbosity)}
}
export function updateProfileSettings(current,input) {
  const next=profileSettings({...current,...Object.fromEntries(['profileVersion','profile','wechatProcessing','legacyExpression']
    .filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]))})
  if (input.presentation===undefined) return next
  const before=legacyPresentation(current)
  shape(input.presentation,Object.keys(before))
  const patched={...before,...input.presentation}
  const migrated=profileSettings({presentation:patched})
  const assignments={displayName:['profile','identity','name'],selfName:['profile','identity','selfReference'],
    brevity:['profile','presentation','verbosity']}
  for (const k of Object.keys(input.presentation)) {
    if (patched[k]===before[k]) continue
    const [section,...path]=assignments[k] ?? (Object.hasOwn(freeFields,k)?['legacyExpression',k]:['wechatProcessing',k])
    const key=path.pop()
    const parent=obj=>path.reduce((v,p)=>v[p],obj[section])
    const dest=parent(next),val=parent(migrated)[key]
    if(dest[key]!==parent(current)[key] && dest[key]!==val) fail('新旧表达配置不一致')
    if(val===undefined) delete dest[key]
    else dest[key]=val
  }
  return profileSettings(next)
}
