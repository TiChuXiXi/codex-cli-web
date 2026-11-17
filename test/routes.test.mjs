import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { once } from 'node:events'
import { createRoutes } from '../server/api/routes.js'
import { EventBus } from '../server/services/events.js'
test('disposing plugin routes ends existing SSE responses so clients can reconnect', async () => {
  const bus = new EventBus({ capacity: 100 })
  const handler = createRoutes({
    hub: { status: () => ({ phase: 'ready' }) },
    bus,
    connection: { requestRejection: () => undefined },
    config: { maxBodyBytes: 1024 },
    logger: console,
  })
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let response
  try {
    const received = new Promise((resolve, reject) => {
      const request = get(
        'http://127.0.0.1:' + server.address().port + '/codex-cli/events',
        (res) => {
          response = res
          res.once('data', () => resolve(res))
        },
      )
      request.once('error', reject)
    })
    const res = await received
    assert.equal(res.statusCode, 200)
    const ended = once(res, 'end')
    res.resume()
    handler.dispose()
    await ended
    assert.equal(res.complete, true)
    handler.dispose()
  } finally {
    response?.destroy()
    handler.dispose()
    bus.dispose()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Git RPC shares the trust fence, forwards cancellation and preserves typed failures',async t=>{
 let rejection=403,calls=0
 const handler=createRoutes({hub:{},bus:{},connection:{requestRejection:()=>rejection},config:{maxBodyBytes:4096},git:{
  async call(endpoint,payload,signal){
   calls++;assert.ok(signal instanceof AbortSignal);assert.equal(payload.cwd,'/tmp/fixture')
   if(endpoint==='fail')throw Object.assign(new Error('fixture failure'),{code:'git-vcs/conflict',details:{fixture:true}})
   return {endpoint}
  },
 }})
 const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening')
 t.after(async()=>{handler.dispose();await new Promise(resolve=>server.close(resolve))})
 const url='http://127.0.0.1:'+server.address().port+'/codex-cli/git/'
 const request=endpoint=>fetch(url+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'test',method:'git/'+endpoint,payload:{cwd:'/tmp/fixture'}})})
 assert.equal((await request('repo/snapshot')).status,403);assert.equal(calls,0)
 rejection=undefined
 const response=await (await request('repo/snapshot')).json()
 assert.deepEqual(response.result,{ok:true,value:{endpoint:'repo/snapshot'}})
 const failure=await (await request('fail')).json()
 assert.deepEqual(failure.result,{ok:false,error:{code:'git-vcs/conflict',message:'fixture failure',details:{fixture:true}}})
})

test('file downloads preserve binary bytes and Unicode names behind the request trust fence',async t=>{
 const {mkdtemp,writeFile,mkdir,symlink,rm}=await import('node:fs/promises')
 const {tmpdir}=await import('node:os')
 const {join}=await import('node:path')
 const {WorkspaceService}=await import('../server/services/workspace.js')
 const root=await mkdtemp(join(tmpdir(),'codex-download-'))
 const workspace=new WorkspaceService({publish(){}})
 const {workspaceId}=await workspace.register(root)
 const name='中文 空格.bin',data=Buffer.from([0,255,13,10,128,42])
 await writeFile(join(root,name),data);await mkdir(join(root,'folder'))
 await symlink(tmpdir(),join(root,'outside'))
 let rejection=403
 const handler=createRoutes({hub:{},bus:{},workspace,connection:{requestRejection:()=>rejection},config:{maxBodyBytes:4096}})
 const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening')
 t.after(async()=>{workspace.dispose();handler.dispose();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})})
 const url=path=>'http://127.0.0.1:'+server.address().port+'/codex-cli/workspace/download?'+new URLSearchParams({workspaceId,path})
 assert.equal((await fetch(url(name))).status,403)
 rejection=undefined
 const response=await fetch(url(name))
 assert.equal(response.status,200)
 assert.match(response.headers.get('content-disposition'),/attachment; filename\*=UTF-8/)
 assert.equal(decodeURIComponent(response.headers.get('content-disposition').split("''")[1]),name)
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),data)
 for(const path of ['folder','../escape','outside/test'])assert.equal((await fetch(url(path))).status,400)
})

test('terminal RPC stays behind authentication and forwards read cancellation', async t => {
  let rejection = 401
  const calls = []
  const terminal = {
    open(payload) { calls.push(['open', payload]); return { sessionId: 'fixture' } },
    read(payload, signal) { calls.push(['read', payload]); assert.ok(signal instanceof AbortSignal); return { data: '', cursor: 0 } },
    write(payload) { calls.push(['write', payload]); return { written: true } },
    resize(payload) { calls.push(['resize', payload]); return { resized: true } },
    close(sessionId) { calls.push(['close', sessionId]); return { closed: true } },
  }
  const handler = createRoutes({ terminal, connection: { requestRejection: () => rejection }, config: { maxBodyBytes: 4096 } })
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { handler.dispose(); await new Promise(resolve => server.close(resolve)) })
  const request = method => fetch('http://127.0.0.1:' + server.address().port + '/codex-cli/terminal/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'terminal/' + method, payload: { sessionId: 'fixture' } }),
  })
  for (const method of ['open', 'read', 'write', 'resize', 'close'])
    assert.equal((await request(method)).status, 401)
  assert.equal(calls.length, 0)
  rejection = undefined
  for (const method of ['open', 'read', 'write', 'resize', 'close'])
    assert.equal((await (await request(method)).json()).result.ok, true)
  assert.deepEqual(calls.map(call => call[0]), ['open', 'read', 'write', 'resize', 'close'])
  assert.equal(calls.at(-1)[1], 'fixture')
})

test('queued permission updates share the RPC trust fence and forward the complete policy', async t => {
  let rejection = 401
  const calls = []
  const followups = { updatePermissions: async payload => { calls.push(payload); return { threadId: payload.threadId, revision: 2, entries: [] } } }
  const handler = createRoutes({ followups, connection: { requestRejection: () => rejection }, config: { maxBodyBytes: 4096 } })
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { handler.dispose(); await new Promise(resolve => server.close(resolve)) })
  const payload = { threadId: 'a', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } }
  const request = () => fetch('http://127.0.0.1:' + server.address().port + '/codex-cli/followups/permissions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'followups/permissions', payload }),
  })
  assert.equal((await request()).status, 401)
  assert.equal(calls.length, 0)
  rejection = undefined
  const response = await (await request()).json()
  assert.equal(response.result.ok, true)
  assert.deepEqual(calls, [payload])
})

test('conversation uploads accept exe binary data above the RPC limit and enforce the 25 MiB file limit', async t => {
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'codex-upload-'))
  let rejection = 401
  const handler = createRoutes({ connection: { requestRejection: () => rejection }, config: { maxBodyBytes: 2 * 1024 * 1024 } })
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    handler.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const post = (endpoint, payload) => fetch('http://127.0.0.1:' + server.address().port + '/codex-cli/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'upload-test', method: endpoint, payload }),
  })
  assert.equal((await post('upload/save', { cwd: root, name: 'denied.exe', dataBase64: 'TVo=' })).status, 401)
  assert.deepEqual(await readdir(root), [])
  rejection = undefined
  for (const size of [2 * 1024 * 1024, 8 * 1024 * 1024, 25 * 1024 * 1024]) {
    const data = Buffer.alloc(size, 0xa5)
    data.write('MZ')
    const response = await post('upload/save', { cwd: root, name: 'installer-' + size + '.exe', dataBase64: data.toString('base64') })
    assert.equal(response.status, 200)
    const { result } = await response.json()
    assert.equal(result.ok, true)
    assert.equal(result.value.size, size)
    assert.ok(result.value.path.endsWith('.exe'))
    assert.deepEqual(await readFile(result.value.path), data)
  }
  const tooLarge = await post('upload/save', { cwd: root, name: 'too-large.exe', dataBase64: Buffer.alloc(25 * 1024 * 1024 + 1).toString('base64') })
  assert.equal(tooLarge.status, 200)
  assert.equal((await tooLarge.json()).result.error.code, 'codex-cli/file-too-large')
  assert.equal((await readdir(join(root, '.dsh-uploads', 'codex-cli'))).length, 3)
  const ordinary = await post('status', { data: 'x'.repeat(2 * 1024 * 1024) })
  assert.equal(ordinary.status, 400)
  assert.equal((await ordinary.json()).result.error.message, '请求体过大')
})
