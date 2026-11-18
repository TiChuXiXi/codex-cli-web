import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
const cwd=process.env.MOCK_WORKSPACE || process.cwd()
const threads=new Map(),waiting=new Map(),timers=new Set()
const time=()=>Math.floor(Date.now()/1000)
const base={id:'fixture-thread',name:'验收会话',preview:'独立工作台夹具',cwd,modelProvider:'openai',model:'fixture-model',reasoningEffort:'medium',createdAt:time(),updatedAt:time(),status:{type:'idle'},turns:[]}
threads.set(base.id,base)
function output(message){process.stdout.write(JSON.stringify(message)+'\n')}
const notify=(method,params)=>output({method,params})
const reply=(id,result)=>output({id,result})
function later(fn,delay){const timer=setTimeout(()=>{timers.delete(timer);fn()},delay);timers.add(timer);return timer}
function finish(thread,turn,text,questions) {
  if(turn.status!=='inProgress')return
  const item={id:randomUUID(),type:'agentMessage',text:'',phase:'final_answer',questions}
  turn.items.push(item)
  notify('item/started',{threadId:thread.id,turnId:turn.id,item})
  later(()=>{item.text=text;notify('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:text.slice(0,8)})},30)
  later(()=>{
    notify('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:text.slice(8)})
    notify('item/completed',{threadId:thread.id,turnId:turn.id,item})
    turn.status='completed';turn.completedAt=time();thread.status={type:'idle'}
    notify('turn/completed',{threadId:thread.id,turn})
  },120)
}
function spawnFixtureAgents(parent, turn, legacy) {
  const spawn = (name, path) => {
    const child = {
      ...base, id: randomUUID(), name: null, parentThreadId: parent.id, agentNickname: name,
      source: { subAgent: { thread_spawn: { parent_thread_id: parent.id, depth: 1 } } },
      status: { type: 'active' }, turns: [],
    }
    const childTurn = {
      id: randomUUID(), status: 'inProgress', startedAt: time(),
      items: [{ id: randomUUID(), type: 'agentMessage', phase: 'commentary', text: name + ' 开始检查' }],
    }
    if (name === 'Kepler') {
      child.turns.push(...[3, 2].map(offset => ({
        id: randomUUID(), status: 'completed', startedAt: time() - offset,
        items: [{ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: name + ' 较早的记录 ' + offset }],
      })))
    }
    child.turns.push(childTurn)
    threads.set(child.id, child)
    const item = legacy
      ? { id: randomUUID(), type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: parent.id,
          receiverThreadIds: [child.id], prompt: name + ' 的委派任务', agentsStates: { [child.id]: { status: 'running' } } }
      : { id: randomUUID(), type: 'subAgentActivity', agentThreadId: child.id, agentPath: '/root/' + path, kind: 'started' }
    turn.items.push(item)
    notify('item/completed', { threadId: parent.id, turnId: turn.id, item })
    return { child, childTurn }
  }
  const first = spawn('Kepler', 'inspect')
  const second = spawn('Lorentz', 'verify')
  if (legacy) {
    second.child.ephemeral = true
    second.child.noHistory = true
    return
  }
  later(() => {
    const { child, childTurn } = first
    const item = { id: randomUUID(), type: 'commandExecution', command: 'echo kepler-fixture', status: 'inProgress', aggregatedOutput: '' }
    childTurn.items.push(item)
    const meta = { threadId: child.id, turnId: childTurn.id }
    notify('item/started', { ...meta, item })
    later(() => {
      item.aggregatedOutput = 'Kepler 命令输出'
      notify('item/commandExecution/outputDelta', { ...meta, itemId: item.id, delta: item.aggregatedOutput })
    }, 120)
    later(() => {
      item.status = 'completed'
      item.exitCode = 0
      notify('item/completed', { ...meta, item })
      finish(child, childTurn, 'Kepler 执行结果')
    }, 400)
  }, 2400)
  // This child is active on a different app-server connection. Its updates are visible by reading history.
  later(() => {
    const { child, childTurn } = second
    childTurn.items.push({ id: randomUUID(), type: 'mcpToolCall', server: 'fixture', tool: 'snapshot', status: 'completed', result: { text: 'Lorentz 工具输出' } })
    childTurn.items.push({ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Lorentz 执行结果' })
    childTurn.status = 'completed'
    childTurn.completedAt = time()
    child.status = { type: 'idle' }
  }, 3400)
  later(() => finish(parent, turn, '两个子代理均已完成。'), 5100)
}
async function handle(message) {
  if(message.id===undefined)return
  if(!message.method) {
    const entry=waiting.get(message.id)
    if(entry){waiting.delete(message.id);finish(entry.thread,entry.turn,'审批已处理。')}
    return
  }
  const {id,method,params:p={}}=message
  const thread=threads.get(p.threadId) || base
  switch(method) {
    case 'initialize':return reply(id,{userAgent:'codex/0.167.0'})
    case 'thread/list':return reply(id,{data:[...threads.values()].filter(t=>!t.ephemeral&&!t.parentThreadId&&(!p.cwd||t.cwd===p.cwd)&&(!p.searchTerm||t.name?.includes(p.searchTerm))).map(({turns,...t})=>t),nextCursor:null})
    case 'thread/read':
      if (p.includeTurns && thread.noHistory) return output({id,error:{code:-32600,message:'no rollout for ephemeral thread'}})
      return reply(id,{thread:{...thread,turns:p.includeTurns?thread.turns:undefined}})
    case 'thread/turns/list': {
      if (thread.ephemeral && thread.parentThreadId) return output({id,error:{code:-32600,message:'list_turns is not supported for an ephemeral thread'}})
      const start = Number(p.cursor ?? 0)
      const turns = [...thread.turns].reverse()
      const end = start + (p.limit ?? turns.length)
      return reply(id,{data:turns.slice(start,end),nextCursor:end<turns.length?String(end):null})
    }
    case 'thread/resume':return reply(id,{thread,model:'fixture-model',reasoningEffort:'medium',approvalPolicy:'on-request',sandbox:{type:'workspaceWrite'}})
    case 'thread/start': {
      const next={...base,id:randomUUID(),name:p.ephemeral?'hidden':null,cwd:p.cwd||cwd,ephemeral:!!p.ephemeral,turns:[]}
      threads.set(next.id,next);reply(id,{thread:next,model:'fixture-model',reasoningEffort:'medium'});notify('thread/started',{thread:next});return
    }
    case 'thread/name/set':thread.name=p.name;reply(id,{});notify('thread/name/updated',{threadId:thread.id,threadName:p.name});return
    case 'thread/fork':{const next={...thread,id:randomUUID(),turns:structuredClone(thread.turns)};threads.set(next.id,next);return reply(id,{thread:next})}
    case 'thread/archive':case 'thread/delete':threads.delete(thread.id);return reply(id,{})
    case 'thread/compact/start':return reply(id,{})
    case 'thread/unsubscribe':return reply(id,{})
    case 'model/list':return reply(id,{data:[{id:'fixture-model',model:'fixture-model',displayName:'Fixture Model',description:'模拟模型，不调用真实账号',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]})
    case 'account/rateLimits/read':return reply(id,{rateLimits:{planType:'fixture',primary:{usedPercent:20,windowDurationMins:300,resetsAt:time()+3600},secondary:{usedPercent:10,windowDurationMins:10080,resetsAt:time()+86400}}})
    case 'config/read':return reply(id,{config:{model:'fixture-model',model_reasoning_effort:'medium',approval_policy:'on-request',sandbox_mode:'workspace-write'}})
    case 'skills/list':return reply(id,{data:[{cwd:p.cwds?.[0]||cwd,skills:[],errors:[]}]})
    case 'turn/start': {
      const text=p.input?.filter(x=>x.type==='text').map(x=>x.text).join('\n') || '附件消息'
      const turn={id:randomUUID(),status:'inProgress',startedAt:time(),items:[{id:randomUUID(),type:'userMessage',content:p.input}]}
      thread.turns.push(turn);thread.status={type:'active'}
      reply(id,{turn});notify('turn/started',{threadId:thread.id,turn})
      notify('item/completed',{threadId:thread.id,turnId:turn.id,item:turn.items[0]})
      if(thread.ephemeral){finish(thread,turn,'{"title":"自动标题夹具"}');return}
      if(text==='请触发子代理执行'||text==='请触发旧版子代理执行') {
        spawnFixtureAgents(thread,turn,text==='请触发旧版子代理执行')
      }else if(text==='请触发多题提问') {
        finish(thread,turn,'请选择两项设置。',[
          {title:'使用哪个环境？',options:['测试环境','生产环境']},
          {title:'使用哪种输出？',options:['简要','完整']},
        ])
      }else if(text.includes('审批')) {
        const requestId='approval-'+randomUUID()
        waiting.set(requestId,{thread,turn})
        later(()=>output({id:requestId,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn.id,itemId:randomUUID(),command:'echo fixture',cwd,reason:'夹具审批'}}),80)
      }else later(()=>finish(thread,turn,'已收到：'+text+'\n\n**模拟回复**，用于独立服务验收。'),text.includes('慢速')?1800:100)
      return
    }
    case 'turn/steer':return reply(id,{turn:thread.turns.at(-1)})
    case 'turn/interrupt': {
      const turn=thread.turns.find(t=>t.id===p.turnId)
      if(turn){turn.status='interrupted';thread.status={type:'idle'};notify('turn/completed',{threadId:thread.id,turn})}
      return reply(id,{})
    }
    default:return output({id,error:{code:-32601,message:'Mock method not implemented: '+method}})
  }
}
const lines=createInterface({input:process.stdin})
lines.on('line',line=>{try{void handle(JSON.parse(line))}catch(error){process.stderr.write(error.message+'\n')}})
lines.on('close',()=>{for(const timer of timers)clearTimeout(timer)})
