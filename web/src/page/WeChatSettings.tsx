import * as React from 'react'
import qrcode from 'qrcode-generator'
import type { WeChatStatus } from '../../../shared/contracts'
import type { Api } from '../rpc'

const labels: Record<WeChatStatus['phase'], string> = {
  unbound: '尚未绑定', waiting_scan: '等待扫码', waiting_confirmation: '等待微信确认', waiting_pin: '等待输入验证码',
  connected: '已连接', reconnecting: '正在连接', disconnected: '已断开', expired: '凭据已失效', error: '连接异常',
}
const time = (value: number | null) => value ? new Date(value).toLocaleString() : '暂无'

export function WeChatSettings({ api }: { api: Api }) {
  const [status, setStatus] = React.useState<WeChatStatus | null>(null)
  const [pin, setPin] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const sequence = React.useRef(0)
  const pending = React.useRef(false)
  const request = React.useCallback(async (method: string, payload?: Record<string, unknown>) => {
    const version = ++sequence.current
    try {
      const value = await api<WeChatStatus>('wechat/' + method, payload)
      if (version === sequence.current) { setStatus(value); setError('') }
      return true
    } catch (cause) {
      if (version === sequence.current) setError(cause instanceof Error ? cause.message : '微信请求失败')
      return false
    }
  }, [api])
  React.useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      if (!pending.current) await request('status')
      if (active) timer = setTimeout(refresh, 1500)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer); sequence.current++ }
  }, [request])
  async function act(method: string, payload?: Record<string, unknown>, next?: WeChatStatus) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    if (next) setStatus(next)
    try { if (!await request(method, payload) && next) setStatus(status) }
    finally { pending.current = false; setBusy(false); setPin('') }
  }
  function preferences(results: boolean, decisions: boolean) {
    if (status) void act('preferences', { results, decisions }, { ...status, results, decisions })
  }
  const qr = React.useMemo(() => {
    if (!status?.qr) return null
    try {
      const code = qrcode(0, 'L')
      code.addData(status.qr)
      code.make()
      return code.createDataURL(4)
    } catch { return null }
  }, [status?.qr])
  return <section className="settings-access">
    <header><h2>个人微信接入</h2><p>绑定后可在微信使用当前 Router。Web 和微信派发的任务结果、审批与决策默认都会发送到此账号。</p></header>
    {error && <p role="alert">{error}</p>}
    {status && <>
      <p role="status">{labels[status.phase]} {status.owner}</p>
      {status.error && <p role="alert">{status.error}</p>}
      {(status.phase === 'connected' || (status.phase === 'reconnecting' && status.owner && !status.lastReceived)) && <p>{status.canNotify ? '可接收主动通知' : '请先在微信发一句话，以启用主动通知。'}</p>}
      {qr && <img src={qr} alt="使用本人微信扫描绑定二维码" width={220} height={220}/>}
      {status.qr && !qr && <p role="alert">二维码无法显示，请重新发起绑定。</p>}
      {status.phase === 'waiting_pin' && <form onSubmit={e => { e.preventDefault(); void act('pin', { loginId: status.loginId, pin }) }}>
        <label>微信验证码 <input type="password" inputMode="numeric" autoComplete="off" value={pin} maxLength={12} onChange={e => setPin(e.target.value)}/></label>
        <button className="dsh-codex-button" disabled={busy || !pin}>提交验证码</button>
      </form>}
      <div className="settings-actions">
        {(!status.hasBinding || (status.owner && ['expired','disconnected','error'].includes(status.phase))) && !status.loginId &&
          <button className="dsh-codex-button primary" disabled={busy} onClick={() => void act('bind')}>扫码绑定</button>}
        {status.owner && ['disconnected','error'].includes(status.phase) &&
          <button className="dsh-codex-button" disabled={busy} onClick={() => void act('resume')}>恢复连接</button>}
        {(status.loginId || ['connected','reconnecting'].includes(status.phase)) &&
          <button className="dsh-codex-button" disabled={busy} onClick={() => void act('disconnect')}>{status.loginId ? '取消绑定' : '断开连接'}</button>}
        {(status.hasBinding || status.owner) && <button className="dsh-codex-button" disabled={busy} onClick={() => void act('unbind')}>解除绑定</button>}
      </div>
      {status.owner && <>
        <fieldset className="settings-wechat-notifications" disabled={busy}><legend>主动通知</legend>
          <label><input type="checkbox" checked={status.results} onChange={e => preferences(e.target.checked, status.decisions)}/> 任务结果</label>
          <label><input type="checkbox" checked={status.decisions} onChange={e => preferences(status.results, e.target.checked)}/> 审批及决策</label>
        </fieldset>
        <p>最近接收　{time(status.lastReceived)}<br/>最近发送　{time(status.lastSent)}</p>
        <p>待发送 {status.pending}　待核对 {status.unknown}　失败 {status.failed}</p>
      </>}
    </>}
  </section>
}
