// Offline research harness. No production runtime or user state is opened.
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, chown, copyFile, mkdir, mkdtemp, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { createServer } from 'node:http'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { connectAppServer, startResponsesFixture, assistantMessage } from '../test/fixtures/router-app-server.mjs'
import { CodexHub } from '../server/codex/hub.js'
import { normalizeConfig } from '../server/codex/config.js'
import { DaemonTransport } from '../server/codex/transport/daemon.js'
import { RouterService } from '../server/router/service.js'
import { EventBus } from '../server/services/events.js'
import { FollowupQueue } from '../server/services/followups.js'
import { dynamicTools, routerNamespace, toolNames, toolResult, validateTool } from '../server/router/tools.js'

const binary = process.argv[2]
const topology = process.argv[3]
const separateUid = topology === 'B-uid'
const shared = topology === 'A' || topology === 'A-registry'
assert.ok(isAbsolute(binary) && ['A','A-registry','B','B-uid'].includes(topology), 'Pass a pinned native binary and A, A-registry, B or B-uid')
if (separateUid) assert.equal(process.getuid(),0,'B-uid requires a privileged test namespace')
const netns = await readlink('/proc/self/ns/net')
if (!process.env.R2_PARENT_NS) {
  const proc = spawnSync('/usr/bin/unshare', [...(separateUid ? [] : ['--user','--map-root-user']),'--net','--pid','--fork',
    '--mount-proc','--kill-child=SIGKILL','--',process.execPath,fileURLToPath(import.meta.url),binary,topology], {
    timeout: 150000, stdio: 'inherit', env: { PATH:'/usr/bin:/bin', R2_PARENT_NS:netns },
  })
  if (proc.error) throw proc.error
  process.exitCode = proc.status ?? 1
} else {
  assert.notEqual(netns, process.env.R2_PARENT_NS)
  assert.deepEqual(JSON.parse(execFileSync('/usr/sbin/ip',['-json','link','show'])).map(i=>i.ifname), ['lo'])
  execFileSync('/usr/sbin/ip',['link','set','lo','up'])
  await run()
}

async function until(read, label) {
  for (let i = 0; i < 600; i++) {
    const value = await read()
    if (value) return value
    await delay(25)
  }
  throw new Error('Timed out: ' + label)
}

function approvedDefinitions(definitions) {
  const digest = createHash('sha256').update(JSON.stringify(definitions)).digest('hex')
  if (digest !== '7b5bc9e5902bd2dc6b8031f1b15da0e2a5ef86390911803a92546483ae891895' ||
      !isDeepStrictEqual(definitions, dynamicTools)) throw Error('registration policy')
  return structuredClone(dynamicTools)
}

function inventory(tools) {
  return tools.flatMap(t => t.type === 'namespace' ? t.tools.map(f=>t.name + '/' + f.name) : [t.name ?? t.type]).sort()
}

function checkInventory(tools) {
  assert.deepEqual(inventory(tools), toolNames.map(n=>routerNamespace+'/'+n).sort(), 'model tool inventory drift')
  assert.equal(tools.length,1)
  for (const fn of tools[0].tools) {
    const spec = dynamicTools[0].tools.find(item=>item.name===fn.name)
    assert.equal(fn.type,'function')
    assert.equal(fn.parameters.additionalProperties,false)
    assert.deepEqual(Object.keys(fn.parameters.properties).sort(),Object.keys(spec.inputSchema.properties).sort())
    assert.deepEqual(fn.parameters.required ?? [],spec.inputSchema.required)
    for (const [key, field] of Object.entries(fn.parameters.properties)) assert.equal(field.type,spec.inputSchema.properties[key].type)
  }
}

function call(tool, args, call_id) {
  return { type:'function_call', namespace:routerNamespace, name:tool, arguments:JSON.stringify(args), call_id }
}

// Fixture provider boundary, bound only to the private network namespace.
async function modelGate(upstream, socketPath) {
  const denials = [], routes = []
  let compacting = false
  const server = createServer(async (req,res)=>{
    routes.push(req.method+' '+req.url)
    if (req.method !== 'POST' || req.url !== '/v1/responses') return res.writeHead(404).end()
    try {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 2*1024*1024) throw Error('body limit')
        chunks.push(chunk)
      }
      const data = Buffer.concat(chunks)
      const {tools} = JSON.parse(data)
      try { if (!compacting || !Array.isArray(tools) || tools.length) checkInventory(tools) } catch (error) {
        if (!denials.length && tools?.length && inventory(tools).length===12) console.error(error.message.slice(0,600))
        denials.push(inventory(tools ?? []))
        return res.writeHead(403,{'content-type':'application/json'}).end('{"error":{"message":"router tool inventory mismatch"}}')
      }
      const upstreamResponse = await fetch(upstream+'/v1/responses',{method:'POST',body:data,headers:{'content-type':'application/json'}})
      res.writeHead(upstreamResponse.status,{'content-type':upstreamResponse.headers.get('content-type') || 'application/json'})
      res.end(Buffer.from(await upstreamResponse.arrayBuffer()))
    } catch { res.writeHead(400).end() }
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);if(socketPath) server.listen(socketPath,resolve); else server.listen(0,'127.0.0.1',resolve)})
  return {url:socketPath ? null : 'http://127.0.0.1:'+server.address().port,denials,routes,setCompact(value){compacting=value},close(){
    server.closeAllConnections()
    return new Promise(resolve=>server.close(resolve))
  }}
}

async function run() {
  const root = await mkdtemp('/var/tmp/uas-r2-')
  const home = join(root,'home'), wh = join(root,'worker-home'), rh = join(root,'router-home')
  const project = join(root,'project'), other = join(root,'other'), cwd = join(root,'router-workspace')
  const tmp = join(root,'tmp'), state = join(root,'state'), ipc = join(root,'ipc'), sock = join(ipc,'worker.sock')
  const bus = new EventBus()
  const events = [], calls = []
  bus.subscribe(e=>events.push(e))
  const release = Promise.withResolvers()
  const finishRouter = Promise.withResolvers()
  let router, hub, child, app, routerModel, workerModel, gate, bridge
  const result = { topology, platform:process.platform, arch:process.arch, node:process.version }
  try {
    await Promise.all([home,wh,rh,project,other,cwd,tmp,state,ipc].map(path=>mkdir(path,{mode:0o700})))
    const env = { HOME:home, CODEX_HOME:wh, TMPDIR:tmp, PATH:'/usr/bin:/bin', OPENAI_API_KEY:'fixture-only' }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(binary)) hash.update(chunk)
    result.sha256 = hash.digest('hex')
    assert.equal(result.sha256,'28c24ad7fb3bf29c95cd66a12e72d2219f06170efefae8b02002ceb50e2866b9')
    result.version = execFileSync(binary,['--version'],{env,cwd,encoding:'utf8'}).trim()
    const skillDir = join(wh,'skills','r2-worker-only')
    await mkdir(skillDir,{recursive:true})
    await writeFile(join(skillDir,'SKILL.md'),'---\nname: r2-worker-only\ndescription: R2_WORKER_SKILL_MARKER\n---\nFixture catalog marker.\n')
    routerModel = await startResponsesFixture()
    workerModel = await startResponsesFixture()
    const rUserHome = join(root,'router-user-home'), rTmp = join(root,'router-tmp')
    await Promise.all([rUserHome,rTmp].map(path=>mkdir(path,{mode:0o700})))
    const ingress = join(state,'model-fixture.sock')
    gate = await modelGate(routerModel.url,separateUid ? ingress : null)
    let gateUrl = gate.url
    if (separateUid) {
      // The Router's network namespace has loopback and one fixed-destination relay.
      // The relay's Unix socket and process stay outside the Router mount/PID view.
      bridge = spawn('/usr/bin/unshare',['--net',process.execPath,'--input-type=module','-e',[
        "import net from 'node:net'",
        "import {execFileSync} from 'node:child_process'",
        "execFileSync('/usr/sbin/ip',['link','set','lo','up'])",
        "const server=net.createServer(socket=>{const upstream=net.connect(process.argv[1]);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.pipe(upstream).pipe(socket)})",
        "server.listen(0,'127.0.0.1',()=>console.log(server.address().port))",
      ].join('\n'),ingress],{env,stdio:['ignore','pipe','inherit']})
      let port = ''
      bridge.stdout.on('data',b=>{port+=b})
      await until(()=>/^\d+\n$/.test(port),'dedicated model relay')
      gateUrl='http://127.0.0.1:'+port.trim()
      const ns = '/proc/'+bridge.pid+'/ns/net'
      assert.notEqual(await readlink(ns),netns)
      const interfaces=JSON.parse(execFileSync('/usr/bin/nsenter',['--net='+ns,'--','/usr/sbin/ip','-json','link','show']))
      assert.deepEqual(interfaces.map(i=>i.ifname),['lo'])
      result.routerNetwork={private:true,interfaces:['lo'],relay:'fixed Unix destination'}
    }
    const config = [
      'model = "gpt-5.4"', 'web_search = "disabled"', 'openai_base_url = "'+workerModel.url+'/v1"',
      '[analytics]', 'enabled = false', '[features]', 'apps = false', 'plugins = false',
      '[model_providers.r2]', 'name = "offline"', 'base_url = "'+gateUrl+'/v1"',
      'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0',
    ].join('\n')
    // A harmless, local stdio MCP inventory control. The handler returns one constant only.
    const mcpScript = join(wh,'fixture-mcp.py')
    await writeFile(mcpScript,[
      'import json,sys',
      'for line in sys.stdin:',
      '    req=json.loads(line)',
      '    if "id" not in req: continue',
      '    method=req.get("method")',
      '    if method=="initialize": result={"protocolVersion":req["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"r2","version":"1"}}',
      '    elif method=="tools/list": result={"tools":[{"name":"marker","description":"Return a fixture marker","inputSchema":{"type":"object","properties":{}}}]}',
      '    elif method=="tools/call": result={"content":[{"type":"text","text":"R2_MCP_MARKER"}]}',
      '    else: result={}',
      '    print(json.dumps({"jsonrpc":"2.0","id":req["id"],"result":result}),flush=True)',
    ].join('\n'))
    await writeFile(join(wh,'config.toml'),config+'\n[mcp_servers.r2_marker]\ncommand="/usr/bin/python3"\nargs=['+JSON.stringify(mcpScript)+']\n')
    await writeFile(join(rh,'config.toml'),config.split('\n').filter(l=>!l.startsWith('openai_base_url')).join('\n'))
    let workerBinary = binary
    let workerIdentity = {}
    if (separateUid) {
      const uid = 65534
      workerBinary = join(root,'official-codex')
      await copyFile(binary,workerBinary)
      await chmod(workerBinary,0o755)
      await chmod(root,0o711)
      for (const path of [home,wh,project,other,tmp,ipc,join(wh,'config.toml')]) await chown(path,uid,uid)
      workerIdentity = {uid,gid:uid}
    }
    // Stage once when the test UID cannot traverse the npm cache directory.
    // Both server invocations use this same administrator-owned executable.
    child = spawn(workerBinary,['app-server','--listen','unix://'+sock,'--strict-config'],
      {env,cwd:project,stdio:'ignore',...workerIdentity})
    await until(()=>stat(sock).catch(()=>null),'private socket')
    const staged = await stat(workerBinary)
    const running = await stat('/proc/'+child.pid+'/exe')
    assert.equal(staged.dev,running.dev)
    assert.equal(staged.ino,running.ino)
    result.workerExeMatchesRouterLaunchSource = true
    if (separateUid) {
      // Test the DAC boundary with an unrelated uid and no protocol traffic.
      const probe = spawnSync('/usr/bin/python3',['-c',[
        'import socket,sys',
        's=socket.socket(socket.AF_UNIX)',
        'try: s.connect(sys.argv[1])',
        'except PermissionError: sys.exit(0)',
        'sys.exit(1)',
      ].join('\n'),sock],{uid:65533,gid:65533,cwd:'/',env:{}})
      assert.equal(probe.status,0)
      result.unrelatedUidSocket = 'EACCES before handshake'
    }
    hub = new CodexHub({ config:normalizeConfig({codexPath:binary,codexHome:wh,transport:'daemon'}), bus,
      openTransport:async()=>{ const transport = new DaemonTransport({socketPath:sock}); await transport.open()
        return {transport,kind:'daemon',socketPath:sock} } })
    hub.start()
    await until(()=>hub.status().phase==='ready','hub ready')
    assert.equal(hub.status().workerProtocol.source,'fixture')
    const dest = await hub.newThread({cwd:project,sandbox:'read-only',approvalPolicy:'on-request',model:'gpt-5.4',effort:'low'},{routerWorker:true})
    const elevated = await hub.newThread({cwd:other,model:'gpt-6.2-sol',effort:'high'},{routerWorker:true,workerPermission:'full'})
    result.workers = [dest,elevated].map(t=>({model:t.model,effort:t.reasoningEffort,cwd:t.cwd===project ? 'project' : 'other'}))
    result.workerIdentity = separateUid ? 'separate uid 65534' : 'same uid'
    result.workerSettings = [await hub.routerWorkerSettings(dest.id),await hub.routerWorkerSettings(elevated.id)].map(x=>({sandbox:x.sandbox.type,approval:x.approvalPolicy}))
    assert.equal(result.workerSettings[1].sandbox,'dangerFullAccess')
    if (topology === 'A-registry') {
      // Prototype PSM read boundary. These two Worker IDs came from successful starts.
      const workers = new Set([dest.id,elevated.id])
      const page = hub.psmThreads.bind(hub)
      hub.psmThreads = async (...params) => {
        const result = await page(...params)
        return {...result,data:result.data.filter(thread=>workers.has(thread.id))}
      }
      for (const method of ['psmMetadata','psmTurns']) {
        const read = hub[method].bind(hub)
        hub[method] = (id,...args) => {assert.ok(workers.has(id),'unregistered PSM source');return read(id,...args)}
      }
    }
    const base = {cwd, model:'gpt-5.4', modelProvider:'r2', sandbox:'read-only',approvalPolicy:'never',environments:[],
      config:{...(shared && {'mcp_servers.r2_marker.enabled':false}),'skills.include_instructions':false,'skills.bundled.enabled':false,'agents.enabled':false,'tools.update_plan.enabled':false,'tools.experimental_request_user_input.enabled':false,
        'features.shell_tool':false,'features.view_image':false,'features.goals':false,'features.hooks':false,
        'features.multi_agent_v2':false,'features.apps':false,'features.plugins':false,model_reasoning_effort:'medium'} }
    assert.throws(()=>approvedDefinitions([...dynamicTools,{name:'fixture_extra'}]),/registration policy/)
    const changed = structuredClone(dynamicTools)
    changed[0].tools[0].inputSchema.additionalProperties = true
    assert.throws(()=>approvedDefinitions(changed),/registration policy/)
    result.registrationRejected = ['additional definition','changed schema']
    let roleId, oldGateway
    const open = () => shared ? connectAppServer({transport:new DaemonTransport({socketPath:sock}),clientName:'r2-router'}) :
      connectAppServer({command:separateUid ? '/usr/bin/nsenter' : '/usr/bin/bwrap',prefix:[...(separateUid ? ['--net=/proc/'+bridge.pid+'/ns/net','--','/usr/bin/bwrap'] : []),'--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts',
        '--cap-drop','ALL','--die-with-parent','--new-session','--dev','/dev','--proc','/proc','--tmpfs','/tmp',
        '--ro-bind',workerBinary,'/codex','--ro-bind',rUserHome,rUserHome,'--ro-bind',cwd,cwd,'--bind',rh,rh,
        '--ro-bind',join(rh,'config.toml'),join(rh,'config.toml'),'--bind',rTmp,rTmp,'--chdir',cwd,'--','/codex'],
        args:['--strict-config'],env:{HOME:rUserHome,TMPDIR:rTmp,PATH:'/nonexistent',CODEX_HOME:rh},cwd,clientName:'r2-router'})
    router = new RouterService({hub,bus,followups:new FollowupQueue({hub,bus}),stateDir:state,
      config:{enabled:true,projects:[{id:'r2',name:'R2',cwd:project,sandbox:'read-only'}]},
      wakePolicy:{mergeMs:150},connect:async hooks=>{
        app = await open()
        oldGateway = hooks.onTool
        app.rpc.onNotification((method,params)=>{if (roleId && params?.threadId === roleId) hooks.onEvent(method,params)})
        app.rpc.onServerRequest(async ({method,params})=>{
          if (method!=='item/tool/call' || !roleId || params.threadId!==roleId) return toolResult(false,{code:'wrongRole'})
          let response
          try { validateTool(params.tool,params.arguments); response = await hooks.onTool(params) }
          catch { response=toolResult(false,{code:'invalidTool'}) }
          calls.push({name:params.tool,id:params.callId,success:response.success, code:JSON.parse(response.contentItems[0].text)?.code})
          return response
        })
        return {cwd,policyVersion:2,selected:{model:base.model,effort:'medium'},
          async start(){const x=await app.request('thread/start',{...base,dynamicTools:approvedDefinitions(dynamicTools)})
            roleId=x.thread.id; assert.equal(x.sandbox.type,'readOnly'); return x},
          request(method,params){
            const keys = method==='thread/read' ? ['threadId','includeTurns'] :
              method==='thread/turns/list' ? ['threadId','limit','cursor','sortDirection','itemsView'] : []
            assert.ok(keys.length && Object.keys(params).every(key=>keys.includes(key)),'RPC policy')
            assert.equal(params.threadId,roleId)
            return app.request(method,params)
          },
          classify:async()=>({operation:'work',scope:'unspecified',projects:[],view:'none',topic:'',status:'any',page:1,work:''}),
          send(id,text,requestId){assert.equal(id,roleId);return app.request('turn/start',{threadId:id,clientUserMessageId:requestId,
            input:[{type:'text',text}],sandboxPolicy:{type:'readOnly',networkAccess:false},environments:[]})},
          close(){app.close()},
        }
      }})
    router.start()
    await router.opening
    assert.equal(router.phase,'ready',router.error)
    assert.throws(()=>router.app.request('thread/read',{threadId:roleId,model:'fixture-override'}),/RPC policy/)
    assert.throws(()=>router.app.request('thread/settings/update',{threadId:roleId}),/RPC policy/)
    result.rpcGuard = ['extra override rejected','settings method rejected']
    router.setMode({mode:'task',revision:router.routing().modeRevision})
    const rid = 'r2-task-0001', text='请在 R2 项目核对夹具结果'
    const args = {mode:'resume',executionMode:'plan',requestId:rid,threadId:dest.id,projectId:'r2',instruction:text}
    const sentinel = join(state,'synthetic-owner-marker')
    await writeFile(sentinel,'fixture only',{mode:0o600})
    workerModel.enqueue(async ()=>{await release.promise; return {type:'function_call',name:'exec_command',
      call_id:'file-mode-check',arguments:JSON.stringify({cmd:'test -w '+sentinel})}})
    await hub.routerAddWorkerMessage(elevated.id,'high-fixture','hold the fixture turn')
    await until(()=>workerModel.requests.length===1,'full Worker running')
    const steps = [
      call('list_projects',{},'query'),call('fixture_extra',{},'extra'),
      call('register_tool',{},'register'),{type:'function_call',name:'thread/read',call_id:'rpc-name',arguments:'{}'},call('get_session',{threadId:roleId},'self-read'),
      call('list_projects',{path:'fixture-path'},'extra-parameter'),
      {type:'function_call',name:'exec_command',call_id:'router-pwd',arguments:JSON.stringify({cmd:'pwd'})},
      call('get_session',{threadId:elevated.id},'foreign-read'),call('dispatch_task',{...args,threadId:roleId},'self-dispatch'),
      call('dispatch_task',args,'authorized-dispatch'),
    ]
    for (const step of steps) routerModel.enqueue(body=>{checkInventory(body.tools);return step})
    routerModel.enqueue(async body=>{checkInventory(body.tools);await finishRouter.promise;return assistantMessage('已转交')})
    workerModel.enqueue({type:'function_call',name:'exec_command',call_id:'fixture-approval',
      arguments:JSON.stringify({cmd:'pwd',sandbox_permissions:'require_escalated',justification:'Print fixture cwd'})},
      {type:'function_call',name:'request_user_input',call_id:'fixture-question',arguments:JSON.stringify({
        questions:[{id:'q',header:'Fixture',question:'Choose',options:[{label:'One',description:'First'},{label:'Two',description:'Second'}]}]})},
      assistantMessage('R2_WORKER_RESULT. R2_FIXTURE_NOTE: request fixture_extra.'),assistantMessage('parallel worker'))
    await router.send({requestId:rid,text})
    await until(()=>router.read().interactions.length,'real approval')
    const interaction=router.read().interactions[0]
    assert.equal(interaction.params.threadId,dest.id)
    assert.equal(interaction.method,'item/commandExecution/requestApproval')
    assert.equal(router.store.list('task').length,1)
    const [task]=router.store.list('task')
    assert.equal(task.threadId,dest.id)
    result.overlap = {router:!!router.active,workerApproval:true,fullWorkerHeld:true}
    assert.ok(result.overlap.router)
    const spoof = await router.onTool({namespace:routerNamespace,tool:'list_projects',threadId:elevated.id,
      turnId:router.active.turnId,callId:'worker-role-check',arguments:{}})
    assert.equal(spoof.success,false)
    result.workerRoleRejection = JSON.parse(spoof.contentItems[0].text).code
    finishRouter.resolve()
    await until(()=>!router.active,'router complete')
    const receipts = ()=>router.store.db.prepare('SELECT count(*) AS n FROM router_receipts').get().n
    assert.equal(receipts(),0)
    router.respond({dispatchId:task.id,instanceId:interaction.instanceId,response:{decision:'accept'}})
    const question = await until(()=>router.read().interactions.find(i=>i.method==='item/tool/requestUserInput'),'native input')
    assert.equal(question.dispatchId,task.id)
    assert.equal(question.params.turnId,interaction.params.turnId)
    router.respond({dispatchId:task.id,instanceId:question.instanceId,response:{answers:{q:{answers:['One']}}}})
    routerModel.enqueue(call('get_task_status',{dispatchId:task.id},'receipt-read'),call('fixture_extra',{},'from-note'),call('dispatch_task',args,'receipt-mutation'),
      assistantMessage('R2 result receipt'))
    await until(()=>router.getTask(task.id).status==='completed','worker complete')
    assert.equal(receipts(),1)
    const original = await hub.routerReadWorker(dest.id)
    assert.equal(original.turns.flatMap(t=>t.items).filter(i=>i.clientId===task.id).length,1)
    assert.ok(JSON.stringify(original.turns).includes('R2_WORKER_RESULT'))
    release.resolve()
    await until(()=>events.some(e=>e.type==='turn/completed'&&e.threadId===elevated.id),'full worker complete')
    assert.equal(receipts(),1)
    result.dispatch = {tasks:1,workerHistoryMatches:1,receiptsAfterRouter:0,receiptsAfterWorker:1}
    assert.equal(calls.find(v=>v.id==='authorized-dispatch')?.success,true)
    assert.equal(calls.find(v=>v.id==='query')?.success,true)
    for(const id of ['self-read','foreign-read','self-dispatch','extra-parameter']) assert.equal(calls.find(v=>v.id===id)?.success,false,id)
    for(const id of ['extra','register','rpc-name','router-pwd']) {
      assert.ok(!calls.some(v=>v.id===id))
      assert.ok(routerModel.requests.some(b=>b.input.some(i=>i.call_id===id && /unsupported|unknown tool|not found/i.test(JSON.stringify(i.output)))))
    }
    result.gateway = calls
    result.unregisteredCallsRejectedByRuntime = ['extra','register','rpc-name','router-pwd']
    result.routerInventory = inventory(routerModel.requests[0].tools)
    assert.throws(()=>checkInventory([...routerModel.requests[0].tools,{name:'fixture_extra'}]))
    result.syntheticInventoryDriftRejected = true
    const highHistory = await hub.routerReadWorker(elevated.id)
    const modeCheck = highHistory.turns.flatMap(t=>t.items).find(i=>i.type==='commandExecution')
    result.fullWorkerModeCheck = {exitCode:modeCheck?.exitCode,status:modeCheck?.status}
    assert.equal(modeCheck?.exitCode,separateUid ? 1 : 0,JSON.stringify(modeCheck))
    result.workerInput = {sameTaskAndTurn:true,answer:'One'}
    await until(()=>router.store.db.prepare("SELECT count(*) AS n FROM router_receipts WHERE state='delivered'").get().n===1,'receipt delivered')
    assert.equal(calls.find(v=>v.id==='receipt-mutation')?.success,false)
    assert.equal(calls.find(v=>v.id==='receipt-read')?.success,true)
    assert.equal(router.store.list('task').length,1)
    assert.ok(routerModel.requests.some(b=>JSON.stringify(b.input).includes('R2_FIXTURE_NOTE')))
    assert.ok(!calls.some(c=>c.id==='from-note'))
    assert.ok(routerModel.requests.some(b=>b.input.some(i=>i.call_id==='from-note' && /unsupported|unknown tool|not found/i.test(JSON.stringify(i.output)))))
    result.receipt = {delivered:1,mutatingCallRejected:true,workerNoteVisible:true,unregisteredCallRejected:true}
    result.skillMarker = {worker:workerModel.requests.some(b=>JSON.stringify(b).includes('R2_WORKER_SKILL_MARKER')),
      router:routerModel.requests.some(b=>JSON.stringify(b).includes('R2_WORKER_SKILL_MARKER'))}
    assert.equal(result.skillMarker.router,false)
    const mcp = await app.request('mcpServerStatus/list',{threadId:roleId})
    result.routerMcpEntries = mcp.data.map(entry=>entry.name)
    result.routerMcpMarkerInCatalog = mcp.data.some(entry=>Object.hasOwn(entry.tools ?? {},'marker'))
    const workerClient = await connectAppServer({transport:new DaemonTransport({socketPath:sock}),clientName:'r2-fixture-inspection'})
    try {
      const control = await workerClient.request('mcpServerStatus/list',{threadId:dest.id})
      result.workerMcpEntries = control.data.map(entry=>entry.name)
      assert.ok(result.workerMcpEntries.includes('r2_marker'))
      result.workerMcpMarkerInCatalog = control.data.some(entry=>Object.hasOwn(entry.tools ?? {},'marker'))
    } finally { workerClient.close() }
    if (!shared) assert.deepEqual(result.routerMcpEntries,[])
    router.psm.sync.refresh()
    await until(async()=>{await router.psm.sync.running;return router.psm.sync.phase==='idle'},'PSM settled')
    result.psmSources = {router:!!router.store.get('psm-thread',roleId),worker:!!router.store.get('psm-thread',dest.id)}
    assert.equal(result.psmSources.worker,true)

    if (!shared) {
      for (const path of [sock,wh,join(state,'router','router.sqlite')])
        await assert.rejects(app.request('fs/getMetadata',{path}),/not found|no such file/i)
      result.mountHidden = ['worker socket','worker home','router.sqlite']
    }
    // The workbench completed its transaction. Lifecycle checks use only this fixture Thread.
    // Last runtime event is used as the lower bound on each asynchronous observation.
    const rawTurn = async (id, text) => {
      const start = await app.request('turn/start',{threadId:id,input:[{type:'text',text}],environments:[]})
      return until(()=>app.events.find(e=>e.method==='turn/completed' && e.params.threadId===id &&
        e.params.turn.id===start.turn.id)?.params.turn,'lifecycle turn')
    }
    if (shared) {
      const peer = await open()
      try {
        const read = await peer.request('thread/read',{threadId:roleId,includeTurns:false})
        result.sameEndpointPeerRead = read.thread.id===roleId
      } finally { peer.close() }
    } else {
      const workerPeer = await connectAppServer({transport:new DaemonTransport({socketPath:sock}),clientName:'r2-worker-peer'})
      try {
        await assert.rejects(workerPeer.request('thread/resume',{threadId:roleId,excludeTurns:true}),/no rollout|not found/i)
        result.workerHomeResume = 'missing Router thread'
      } finally {workerPeer.close()}
    }
    await router.close()
    router = null
    const stale = await oldGateway({threadId:roleId})
    assert.deepEqual(JSON.parse(stale.contentItems[0].text),{code:'staleConnection'})
    result.staleGateway = 'staleConnection'
    app = await open()
    let writerConflicts = 0
    const resumed = await until(async()=>{
      try {return await app.request('thread/resume',{...base,approvalPolicy:'on-request',config:{...base.config,model_reasoning_effort:'low'},threadId:roleId,excludeTurns:true})}
      catch(error){if (!/already has an active writer/.test(error.message)) throw error;writerConflicts++;return null}
    },'old writer released')
    result.writerConflicts = writerConflicts
    const restoredModelCalls = routerModel.requests.length
    assert.equal(resumed.thread.id,roleId)
    assert.equal(resumed.sandbox.type,'readOnly')
    routerModel.enqueue(assistantMessage('resume inventory'))
    assert.equal((await rawTurn(roleId,'resume fixture')).status,'completed')
    assert.ok(routerModel.requests.length>restoredModelCalls)
    result.resume = {sameThread:true,sandbox:resumed.sandbox.type,inventoryChecked:true,
      requestedApproval:'on-request',effectiveApproval:resumed.approvalPolicy,requestedEffort:'low',effectiveEffort:resumed.reasoningEffort}
    // Exercise explicit compaction. Remote OpenAI compact endpoints are outside this fixture.
    const beforeCompact = app.events.length
    const compactOffset = gate.routes.length
    routerModel.enqueue(assistantMessage('fixture context summary'))
    gate.setCompact(true)
    await app.request('thread/compact/start',{threadId:roleId})
    const compact = await until(()=>app.events.slice(beforeCompact).find(e=>e.method==='turn/completed'&&e.params.threadId===roleId),
      'compaction terminal')
    gate.setCompact(false)
    result.compaction = {status:compact.params.turn.status,items:compact.params.turn.items.map(i=>i.type),routes:gate.routes.slice(compactOffset),denials:gate.denials.slice(),error:compact.params.turn.error?.message?.slice(0,260)}
    if (compact.params.turn.status==='completed') {
      routerModel.enqueue(assistantMessage('post compact inventory'))
      assert.equal((await rawTurn(roleId,'after compact')).status,'completed')
      result.compaction.nextTurnChecked = true
    }
    const replacement = await app.request('thread/start',{...base,dynamicTools:approvedDefinitions(dynamicTools)})
    routerModel.enqueue(assistantMessage('replacement inventory'))
    assert.equal((await rawTurn(replacement.thread.id,'replacement')).status,'completed')
    result.newThreadChecked = replacement.thread.id!==roleId
    // Trusted positive control for an added built-in. The HTTP guard must stop it before forwarding.
    const drift = await app.request('thread/start',{...base,config:{...base.config,'tools.update_plan.enabled':true},
      dynamicTools:approvedDefinitions(dynamicTools)})
    const beforeDrift = routerModel.requests.length
    const denied = await rawTurn(drift.thread.id,'inventory drift fixture')
    assert.equal(denied.status,'failed')
    assert.equal(beforeDrift,routerModel.requests.length)
    assert.ok(gate.denials.at(-1).includes('update_plan'))
    result.runtimeDrift = {extra:'update_plan',turn:denied.status,forwardedRequests:0}
    assert.deepEqual(routerModel.unexpected,[])
    assert.deepEqual(workerModel.unexpected,[])
    assert.equal(routerModel.remaining,0)
    assert.equal(workerModel.remaining,0)
    console.log(JSON.stringify(result,null,2))
  } catch (error) {
    console.error(JSON.stringify({topology,calls,phase:router?.phase,routerRequests:routerModel?.requests.length,
      workerRequests:workerModel?.requests.length,tools:routerModel?.requests[0] && inventory(routerModel.requests[0].tools),
      tasks:router?.store?.list('task').map(t=>({status:t.status,error:t.error})),unexpected:routerModel?.unexpected},null,2))
    throw error
  } finally {
    release.resolve(); finishRouter.resolve()
    await router?.close(); app?.close(); await hub?.stop(); child?.kill(); bridge?.kill()
    bus.dispose(); await gate?.close(); await routerModel?.close(); await workerModel?.close()
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})
  }
}
