import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {transform} from 'esbuild'

const source = await readFile(new URL('../web/src/page/ToolGroup.tsx', import.meta.url), 'utf8')
// Exercise real grouping without loading the host-provided React runtime.
const grouping = source.slice(source.indexOf('const ACTIVITY_TYPES'), source.indexOf('export function ToolGroup'))
const {code} = await transform(grouping, {loader:'tsx',format:'esm'})
const {groupActivity} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
test('textless async questions remain visible and split adjacent tool groups', () => {
  const question = {id:'q',type:'agentMessage',text:'',questions:[{title:'Which approach?',options:['A','B']}]}
  const entries = groupActivity([{id:'one',type:'mcpToolCall'}, question, {id:'two',type:'mcpToolCall'}])
  assert.equal(entries.length,3)
  assert.equal(entries[1].item,question)
  assert.equal(groupActivity([{...question,questions:null}]).length,0)
})

const utils = await transform(await readFile(new URL('../web/src/utils.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'})
const {applyDetailEvent} = await import('data:text/javascript;base64,' + Buffer.from(utils.code).toString('base64'))
test('question metadata survives streamed item completion and ignores other threads', () => {
  const initial = {thread:{id:'a'},turns:[{id:'turn',status:'inProgress',items:[{id:'q',type:'agentMessage',text:'',streaming:true}]}]}
  const questions = [{title:'Choose',options:['A','B']}]
  const event = {type:'item/upsert',threadId:'a',turnId:'turn',payload:{completed:true,item:{id:'q',type:'agentMessage',text:'',questions}}}
  const detail = applyDetailEvent(initial,event)
  assert.deepEqual(detail.turns[0].items[0].questions,questions)
  assert.equal(applyDetailEvent(initial,{...event,threadId:'b'}),initial)
})
