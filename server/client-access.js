import { BlockList, isIP } from 'node:net'

/** Match the actual TCP peer. Forwarded client headers never grant access. */
export function createClientFilter(entries = []) {
  if (!Array.isArray(entries)) throw new Error('allowedClients 必须为 IP/CIDR 列表')
  const block = new BlockList()
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim() !== entry || !entry) throw new Error('白名单必须填写有效 IP 或 CIDR')
    const parts = entry.split('/')
    const address = parts[0], version = isIP(address)
    if (!version || parts.length > 2) throw new Error('无效白名单 IP/CIDR：' + entry)
    const family = version === 4 ? 'ipv4' : 'ipv6'
    if (parts.length === 1) block.addAddress(address, family)
    else {
      const prefix = Number(parts[1])
      if (!/^\d+$/.test(parts[1]) || !Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128))
        throw new Error('无效白名单 CIDR：' + entry)
      block.addSubnet(address, prefix, family)
    }
  }
  return address => {
    const version = typeof address === 'string' ? isIP(address) : 0
    return version !== 0 && block.check(address, version === 4 ? 'ipv4' : 'ipv6')
  }
}

const loopback = createClientFilter(['127.0.0.1', '::1'])
export const isLanAddress = createClientFilter(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'])
export function isLocalSetupRequest(config, request) {
  const { remoteAddress, localAddress, localPort } = request.socket
  return config.localWhitelistSetup && loopback(remoteAddress) && loopback(localAddress) &&
    request.headers.host === (localPort === 80 ? '127.0.0.1' : `127.0.0.1:${localPort}`) &&
    request.headers['x-forwarded-for'] === undefined &&
    request.headers.forwarded === undefined
}