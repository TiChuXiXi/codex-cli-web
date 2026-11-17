import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isIP } from 'node:net'
import { HubError } from '../codex/hub.js'
const exec = promisify(execFile)

/** Only explicit settings-managed rich rules are touched; never reload all firewall rules. */
export function createSettingsFirewall(config, run = async args => { await exec('firewall-cmd', args, {timeout:10000, maxBuffer:256*1024}) }) {
  if (!config?.enabled) return {enabled:false, async update(){return async()=>{}}}
  if (!/^[a-zA-Z0-9_-]+$/.test(config.zone ?? '') || !isIP(config.destination) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error('无效 settingsFirewall 配置')
  const family = isIP(config.destination) === 4 ? 'ipv4' : 'ipv6'
  const rule = entry => {
    const address = entry.split('/')[0], version = isIP(address)
    if (version !== isIP(config.destination)) throw new HubError('codex-cli/settings-invalid', '白名单地址类型必须与服务器监听地址一致')
    const source = entry.includes('/') ? entry : entry + (version === 4 ? '/32' : '/128')
    return 'rule family="'+family+'" source address="'+source+'" destination address="'+config.destination+'" port port="'+config.port+'" protocol="tcp" accept'
  }
  return {
    enabled:true,
    async update(previous, next) {
      const previousRules = new Set(previous.map(rule)), nextRules = new Set(next.map(rule))
      const steps = [
        ...[...nextRules].filter(r=>!previousRules.has(r)).flatMap(r=>[false,true].map(permanent=>({action:'add',rule:r,permanent}))),
        ...[...previousRules].filter(r=>!nextRules.has(r)).flatMap(r=>[false,true].map(permanent=>({action:'remove',rule:r,permanent}))),
      ]
      const completed = []
      const perform = step => run([...(step.permanent?['--permanent']:[]),'--zone='+config.zone,'--'+step.action+'-rich-rule='+step.rule])
      const rollback = async () => {
        const failed=[]
        for (const step of [...completed].reverse()) {
          try {await perform({...step,action:step.action==='add'?'remove':'add'})} catch {failed.push(step)}
        }
        if(failed.length)throw new HubError('codex-cli/settings-firewall', '防火墙回滚失败，请检查服务器规则后重试')
      }
      try {
        for(const step of steps) {await perform(step);completed.push(step)}
      } catch {
        await rollback()
        throw new HubError('codex-cli/settings-firewall', '防火墙同步失败，白名单未保存。请检查 firewalld 状态和服务权限。')
      }
      return rollback
    },
  }
}
