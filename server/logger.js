export function createLogger(level='info', secrets=[]) {
  const rank={debug:0,info:1,warn:2,error:3,silent:4}
  if(!(level in rank)) throw new Error('无效日志级别')
  const redact=value => {
    let text=String(value instanceof Error?value.message:value)
    for(const secret of secrets) if(secret) text=text.split(secret).join('[REDACTED]')
    return text.replace(/(Bearer\s+)[^\s]+/gi,'$1[REDACTED]').replace(/((?:token|password|cookie|authorization)[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]')
  }
  return Object.fromEntries(['debug','info','warn','error'].map(name=>[name,(...args)=>{
    if(rank[name]>=rank[level]) console[name](JSON.stringify({time:new Date().toISOString(),level:name,message:args.map(redact).join(' ')}))
  }]))
}
