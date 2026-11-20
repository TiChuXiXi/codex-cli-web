import { terminalFact, deliveryFact, renderExpression, wechatParts } from '../shared/router-expression.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { profileSettings, defaultProfile, presets, presetValues, dimensions, policies, validateProfile, updateProfileSettings } from '../shared/router-presentation.js'
import { buildExpressionContext } from '../shared/router-identity.js'
test('each actual dial compiles its rule, independently of preset origin',()=>{
  const config=profileSettings()
  for(const key of Object.keys(presets)) validateProfile({...config.profile,personality:{...config.profile.personality,...presetValues(key)}})
  for(const [group,fields] of [['personality',dimensions],['presentation',policies]]) {
    for(const [key,field] of Object.entries(fields)) {
      for(const [value,[,rule]] of Object.entries(field.options)) {
        config.profile[group][key]=value
        assert.ok(buildExpressionContext(config,'wechat','chat').includes(rule))
      }
      config.profile[group][key]='invalid'
      assert.throws(()=>validateProfile(config.profile))
      config.profile=defaultProfile()
    }
  }
  const before=buildExpressionContext(config,'web','chat')
  config.profile.personality.preset='lively'
  assert.equal(buildExpressionContext(config,'web','chat'),before)
})
test('legacy text is preserved by channel across revisioned updates',()=>{
  const config=profileSettings({presentation:{style:'说方言',wechatStyle:'少用术语',brevity:'适中'}})
  assert.equal(config.profile.presentation.verbosity,'standard')
  assert.ok(buildExpressionContext(config,'wechat','task').includes('少用术语'))
  assert.ok(!buildExpressionContext(config,'receipt','task',true).includes('少用术语'))
  config.profile.presentation.completionStyle='result_first'
  const next=updateProfileSettings(config,{presentation:{selfName:'小桥'}})
  assert.equal(next.profile.identity.selfReference,'小桥')
  assert.equal(next.profile.presentation.completionStyle,'result_first')
  assert.deepEqual(next.legacyExpression,config.legacyExpression)
  assert.throws(()=>profileSettings({profileVersion:9}))
  for(const value of [null,'x'.repeat(321),'a\u0000b']) {
    const profile=defaultProfile()
    profile.personality.customExpression=value
    assert.throws(()=>validateProfile(profile))
  }
})

test('sensitive notifications preserve decisions, evidence and errors across every preset',()=>{
  const profile=defaultProfile()
  const facts=[
    {kind:'approval',target:'项目 A',detail:'写入 /fixture/report\n1 允许本次\n2 拒绝'},
    terminalFact('项目 A',{status:'failed',error:'无法写入 /fixture/report'}),
    terminalFact('项目 A',{status:'interrupted'}),
    deliveryFact('项目 A','unknown'),
  ]
  for(const fact of facts) {
    const expected=renderExpression(fact,profile)
    for(const preset of Object.keys(presets)) {
      profile.personality={...profile.personality,...presetValues(preset)}
      profile.presentation.verbosity='concise'
      profile.presentation.dispatchFeedback='minimal'
      assert.equal(renderExpression(fact,profile,'wechat'),expected)
    }
  }
})
test('chat structure reorders the same information; verbosity changes the amount',()=>{
  const config=defaultProfile(), fact={kind:'chat'}
  const sentences=text=>text.split(/[。？\n]/u).filter(Boolean).sort()
  const natural=sentences(renderExpression(fact,config))
  for(const value of Object.keys(dimensions.directness.options)) {
    config.personality.directness=value
    assert.deepEqual(sentences(renderExpression(fact,config)),natural)
  }
  config.presentation.verbosity='detailed'
  assert.ok(sentences(renderExpression(fact,config)).length>natural.length)
  const body='长报告🙂'.repeat(1800)
  assert.equal(wechatParts(body,'summary_first').length,1)
  assert.equal(wechatParts(body,'full_segmented').length,3)
  assert.ok(wechatParts(body,'full_segmented').every(s=>Array.from(s).length<=1200))
})
