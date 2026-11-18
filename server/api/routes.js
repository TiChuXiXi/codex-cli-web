/**
 * HTTP 路由：RPC 通道 + SSE 事件流。
 *
 * 线格式与 `ctx.connection.rpc` 完全一致（照搬 dsh-git-vcs 的验证过的做法）：
 *   请求  { type: "client-request", rpcId, method, payload }
 *   响应  { type: "server-response", rpcId, result: { ok: true, value } | { ok: false, error } }
 *
 * 信任栅栏复用 connection.requestRejection()：Host/Origin 校验 + 浏览器会话认证。
 */

import { pipeline } from 'node:stream/promises'
import { saveUploadStream } from '../services/uploads.js'
import { HubError } from '../codex/hub.js'
import { readImage } from '../services/images.js'
import { checkDirectory, computerRoots, createDirectory, gitDiff, gitStatus, listDirectory, readTextFile, runCommand, saveUpload } from '../services/fs.js'
import { JsonRpcError } from '../codex/jsonrpc.js'

const CHANNEL = '/codex-cli'
const EVENTS_PATH = `${CHANNEL}/events`
const KEEPALIVE_MS = 15000

export function createRoutes({ hub, bus, connection, config, logger, versions, runtime, workspace, git, followups, terminal, settings, router }) {
  const streams = new Set()
  const uploads = new Set()
  const requireRouter = () => {
    if (!router) throw new HubError('codex-cli/router-unavailable', 'Router 未启用')
    return router
  }
  function wechat() {
    const channel = requireRouter().wechat
    if (!channel) throw new HubError('codex-cli/router-unavailable', '微信接入正在初始化')
    return channel
  }
  const endpoints = {
    'wechat/status': () => wechat().status(),
    'wechat/bind': () => wechat().bind(),
    'wechat/pin': payload => wechat().pin(payload),
    'wechat/disconnect': () => wechat().disconnect(),
    'wechat/unbind': () => wechat().disconnect(true),
    'wechat/resume': () => wechat().resume(),
    'wechat/preferences': payload => wechat().preferences(payload),
    'router/read': () => router?.read() ?? {
      enabled: false, phase: 'disabled', error: null, model: null, busy: false,
      messages: [], clarifications: [], tasks: [], latestEventId: 0,
    },
    'router/reconnect': () => { requireRouter().start(); return router.status() },
    'router/send': payload => requireRouter().send(payload),
    'router/model/set': payload => requireRouter().setModel(payload),
    'router/settings/read': () => requireRouter().settings(),
    'router/settings/save': payload => requireRouter().saveSettings(payload),
    'router/settings/project-root': payload => requireRouter().setupProjectRoot(payload),
    'router/projects/create': payload => requireRouter().openNewProject(payload),
    'router/interactions/respond': payload => requireRouter().respond(payload),
    'router/questions/answer': payload => requireRouter().answerQuestion(payload),
    'router/clarifications/confirm': payload => requireRouter().confirm(payload),
    'router/clarifications/cancel': payload => requireRouter().confirm(payload, true),
    'router/tasks/list': payload => requireRouter().listTasks(payload),
    'router/tasks/get': payload => requireRouter().getTask(payload?.dispatchId),
    'router/tasks/dismiss-unknown': payload => requireRouter().dismissUnknown(payload),
    'settings/read': (_payload,_signal,context) => settings.read(context.request),
    'settings/worker/read': () => settings.workerDefaults(),
    'settings/worker/save': payload => settings.saveWorkerDefaults(payload,hub),
    'settings/whitelist': (payload,_signal,context) => settings.update(payload,context),
    'terminal/open': payload => terminal.open(payload),
    'terminal/read': (payload, signal) => terminal.read(payload, signal),
    'terminal/write': payload => terminal.write(payload),
    'terminal/resize': payload => terminal.resize(payload),
    'terminal/close': payload => terminal.close(payload?.sessionId),
    'workspace/downloadInfo': payload => workspace.downloadInfo(payload?.workspaceId, payload?.path),
    'workspace/upload': payload => workspace.upload(payload?.workspaceId, payload?.directory, payload?.name, payload?.dataBase64),
    'workspace/remove': payload => workspace.remove(payload?.workspaceId, payload?.path),
    'workspace/open': payload => workspace.register(payload?.cwd),
    'fs/roots': () => computerRoots(),
    'workspace/info': payload => workspace.info(payload?.workspaceId, payload?.path),
    'workspace/list': payload => workspace.list(payload?.workspaceId, payload?.path),
    'workspace/search': (payload, signal) => workspace.search(payload?.workspaceId, payload?.query, signal),
    'workspace/text': payload => workspace.text(payload?.workspaceId, payload?.path, payload?.offset, payload?.limit),
    'workspace/bytes': payload => workspace.bytes(payload?.workspaceId, payload?.path, payload?.offset, payload?.length),
    'workspace/watch': payload => workspace.observe(payload?.workspaceId, payload?.path),
    'workspace/unwatch': payload => workspace.release(payload?.watchId),
    status() {
      return {
        ...hub.status(),
        runtime: { ...runtime?.(), workspaceWatchCount: workspace?.watchCount ?? 0, terminalSessionCount: terminal?.count ?? 0 },
        pending: hub.pendingApprovals(),
        ...(router ? { router: router.status() } : {}),
      }
    },
    async 'projects/list'(payload) {
      const projects = await hub.projects({ refresh: payload?.refresh === true, provider: payload?.provider })
      return router?.includeNewProjects(projects) ?? projects
    },
    'threads/list'(payload) {
      return hub.listThreads(payload ?? {})
    },
    'threads/get'(payload) {
      return hub.getThread(payload?.threadId, payload ?? {})
    },
    'threads/subagent/get'(payload, signal) {
      return hub.getSubagent(payload ?? {}, signal)
    },
    'threads/open'(payload) {
      return hub.openThread(payload?.threadId)
    },
    'threads/settings'(payload) {
      return hub.getThreadSettings(payload?.threadId)
    },
    'threads/close'(payload) {
      return hub.closeThread(payload?.threadId)
    },
    'threads/new'(payload) {
      return hub.newThread(payload ?? {})
    },
    'threads/rename'(payload) {
      return hub.renameThread(payload ?? {})
    },
    'threads/archive'(payload) {
      return hub.archiveThread(payload ?? {})
    },
    'threads/unarchive'(payload) {
      return hub.unarchiveThread(payload ?? {})
    },
    'threads/delete'(payload) {
      return hub.deleteThread(payload ?? {})
    },
    'threads/fork'(payload) {
      return hub.forkThread(payload ?? {})
    },
    'threads/export'(payload) {
      return hub.exportThread(payload ?? {})
    },
    'turns/start'(payload) {
      return hub.startTurn(payload ?? {})
    },
    'turns/submit': payload => followups.enqueue(payload ?? {}),
    'followups/list': payload => followups.list(payload?.threadId),
    'followups/permissions': payload => followups.updatePermissions(payload ?? {}),
    'followups/action': payload => followups.action(payload ?? {}),
    'threads/goal'(payload) {
      return hub.setGoal(payload ?? {})
    },
    'threads/compact'(payload) {
      return hub.compactThread(payload?.threadId)
    },
    'turns/steer'(payload) {
      return hub.steerTurn(payload ?? {})
    },
    'turns/interrupt'(payload) {
      followups?.pause(payload?.threadId)
      return hub.interruptTurn(payload ?? {})
    },
    'skills/list': payload => hub.skills(payload ?? {}),
    'models/list'(payload) {
      return hub.models(payload?.provider)
    },
    'account/rateLimits'(payload) {
      return hub.rateLimits(payload?.provider)
    },
    'config/read'() {
      return hub.configRead()
    },
    'approvals/pending'() {
      return { pending: hub.pendingApprovals() }
    },
    'versions/check'(payload) {
      return versions.check({ refresh: payload?.refresh === true })
    },
    'versions/update'(payload) {
      return versions.update({ force: payload?.force === true })
    },
    'versions/rollback'(payload) {
      return versions.rollback({ version: payload?.version, force: payload?.force === true })
    },
    'versions/job'(payload) {
      return versions.job(payload?.jobId)
    },
    'daemon/action'(payload) {
      return versions.daemonAction({ action: payload?.action, force: payload?.force === true })
    },
    'doctor/run'() {
      return versions.doctor()
    },
    'images/read'(payload) {
      return readImage(payload?.path)
    },
    'fs/check'(payload) {
      return checkDirectory(payload?.path)
    },
    'upload/save'(payload) {
      return saveUpload(payload?.cwd, payload?.name, payload?.dataBase64)
    },
    'fs/list'(payload) {
      return listDirectory(payload?.path)
    },
    'fs/mkdir'(payload) {
      return createDirectory(payload?.path, payload?.name)
    },
    'fs/read'(payload) {
      return readTextFile(payload?.path)
    },
    'git/status'(payload) {
      return gitStatus(payload?.cwd)
    },
    'git/diff'(payload) {
      return gitDiff(payload?.cwd, payload?.path)
    },
    'exec/run'(payload) {
      return runCommand(payload?.cwd, payload?.command)
    },
    'approvals/respond'(payload) {
      if (payload === null || typeof payload !== 'object') {
        throw new HubError('codex-cli/bad-request', '缺少审批响应体')
      }
      return hub.respondApproval(payload.requestId, payload.response ?? payload.decision, payload.instanceId)
    },
  }

  async function handleRpc(endpoint, payload, signal, context) {
    if (endpoint.startsWith('git/') && git) {
      try { return {ok:true, value:await git.call(endpoint.slice(4), payload ?? {}, signal)} }
      catch(cause) { return {ok:false,error:{code:cause.code || 'git-vcs/internal',message:cause.message,details:cause.details || {}}} }
    }
    if (!Object.hasOwn(endpoints, endpoint)) {
      return {
        ok: false,
        error: { code: 'codex-cli/unknown-endpoint', message: `未知端点：${String(endpoint)}`, details: {} },
      }
    }
    try {
      const value = await endpoints[endpoint](payload ?? {}, signal, context)
      return { ok: true, value: value ?? null }
    } catch (cause) {
      if (cause instanceof HubError) {
        return { ok: false, error: { code: cause.code, message: cause.message, details: cause.details } }
      }
      if (cause instanceof JsonRpcError) {
        return {
          ok: false,
          error: {
            code: 'codex-cli/rpc',
            message: cause.message,
            details: { rpcCode: cause.code, data: cause.data ?? null },
          },
        }
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      logger?.warn?.(`[codex-cli] 端点 ${endpoint} 失败：${message}`)
      return { ok: false, error: { code: 'codex-cli/internal', message, details: {} } }
    }
  }

  const handler = async function handler(request, response) {
    const rejection = connection.requestRejection(request)
    if (rejection !== undefined) {
      response.writeHead(rejection)
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }

    const pathname = (request.url ?? '').split('?')[0]

    if (pathname === CHANNEL + '/upload/file' && request.method === 'POST') {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
        respondJson(response, 415, { ok: false, error: { code: 'codex-cli/bad-request', message: '上传内容必须为二进制文件' } })
        return
      }
      const controller = new AbortController()
      uploads.add(controller)
      const cancel = () => { if (!response.writableEnded) controller.abort() }
      response.once('close', cancel)
      try {
        const url = new URL(request.url, 'http://localhost')
        const size = Number(url.searchParams.get('size'))
        if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) !== size) {
          throw new HubError('codex-cli/bad-request', '上传内容长度与文件大小不一致')
        }
        const value = await saveUploadStream({
          cwd: url.searchParams.get('cwd'), name: url.searchParams.get('name'),
          size, stream: request, signal: controller.signal,
        })
        if (!response.destroyed) respondJson(response, 200, { ok: true, value })
      } catch (cause) {
        if (!response.destroyed) respondJson(response, cause.code === 'codex-cli/file-too-large' ? 413 : 400, {
          ok: false, error: { code: cause.code || 'codex-cli/upload-failed', message: cause.message || '文件上传失败，请重试', details: cause.details || {} },
        })
      } finally {
        response.off('close', cancel)
        uploads.delete(controller)
      }
      return
    }

    if(pathname === CHANNEL+'/workspace/download' && request.method === 'GET'){
      let file
      try {
        const url = new URL(request.url,'http://localhost')
        file = await workspace.download(url.searchParams.get('workspaceId'),url.searchParams.get('path'))
        response.writeHead(200,{
          'content-type':'application/octet-stream',
          'content-length':file.size,
          'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)),
          'cache-control':'no-store',
          'x-content-type-options':'nosniff',
        })
        await pipeline(file.stream,response)
      }catch(cause){
        file?.stream.destroy()
        if(!response.headersSent)respondJson(response,400,{error:{code:cause.code||'codex-cli/download-failed',message:cause.message}})
        else response.destroy()
      }
      return
    }
    if (pathname === EVENTS_PATH) {
      handleEvents(request, response)
      return
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end('method not allowed')
      return
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      response.writeHead(415)
      response.end('content type must be application/json')
      return
    }

    let message
    try {
      // Both upload endpoints accept 25 MiB files, expanded by Base64 plus the JSON envelope.
      const isUpload = pathname === CHANNEL + '/workspace/upload' || pathname === CHANNEL + '/upload/save'
      message = await readJsonBody(request, isUpload ? Math.max(config.maxBodyBytes, 36 * 1024 * 1024) : config.maxBodyBytes)
    } catch (cause) {
      respondJson(response, 400, {
        type: 'server-response',
        rpcId: 'invalid-request',
        result: {
          ok: false,
          error: {
            code: 'codex-cli/bad-request',
            message: cause instanceof Error ? cause.message : String(cause),
            details: {},
          },
        },
      })
      return
    }

    const rpcId = message !== null && typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
    const method = message !== null && typeof message.method === 'string' ? message.method : ''
    const payload = message?.payload ?? {}
    const endpoint = pathname.slice(CHANNEL.length + 1)
    if (
      message?.type !== 'client-request' ||
      rpcId === 'invalid-request' ||
      method !== endpoint ||
      method === '' ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      respondJson(response, 400, {
        type: 'server-response',
        rpcId,
        result: {
          ok: false,
          error: { code: 'codex-cli/bad-request', message: 'RPC 请求格式或端点不匹配', details: {} },
        },
      })
      return
    }

    const controller = new AbortController()
    const cancel = () => {
      if (!response.writableEnded) controller.abort()
    }
    response.once?.('close', cancel)
    let result
    try {
      result = await handleRpc(method, payload, controller.signal, {request, response})
    } finally {
      response.off?.('close', cancel)
    }
    respondJson(response, 200, { type: 'server-response', rpcId, result })
  }

  function handleEvents(request, response) {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end('method not allowed')
      return
    }
    const url = new URL(request.url ?? EVENTS_PATH, 'http://localhost')
    const lastEventId = request.headers['last-event-id']
    const sinceRaw =
      typeof lastEventId === 'string' && lastEventId !== '' ? lastEventId : url.searchParams.get('since')
    const since = sinceRaw === null ? 0 : Number(sinceRaw)

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write('retry: 3000\n\n')
    writeEvent(response, { seq: bus.seq, ts: Date.now(), type: 'hello', payload: { status: hub.status(), instanceId: runtime?.().hostInstanceId } })

    const replay = bus.since(Number.isFinite(since) ? since : 0)
    if (replay === null) {
      writeEvent(response, {
        seq: bus.seq,
        ts: Date.now(),
        type: 'resync',
        payload: { reason: 'gap' },
      })
    } else {
      for (const event of replay) writeEvent(response, event)
    }

    const unsubscribe = bus.subscribe((event) => {
      writeEvent(response, event)
    })
    const keepalive = setInterval(() => {
      if (response.writableEnded) return
      response.write(': ping\n\n')
    }, KEEPALIVE_MS)
    keepalive.unref?.()

    const close = () => { cleanup(); response.end() }
    const cleanup = () => {
      clearInterval(keepalive)
      unsubscribe()
      streams.delete(close)
      request.off('close', cleanup)
      response.off('close', cleanup)
    }
    streams.add(close)
    request.once('close', cleanup)
    response.once('close', cleanup)
  }
  handler.dispose = () => {
    for (const close of [...streams]) close()
    for (const controller of uploads) controller.abort()
  }
  return handler
}

function writeEvent(response, event) {
  if (response.writableEnded || response.destroyed) return
  response.write(`id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`)
}

async function readJsonBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function respondJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}
