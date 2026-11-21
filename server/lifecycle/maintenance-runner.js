import { jsonFile, locations } from './common.js'
import { maintain } from './maintenance.js'
try {
  const descriptor=await jsonFile(new URL('../../installation.json',import.meta.url))
  const argv=process.argv.slice(2)
  const recover=argv.length===2 && argv[0]==='--recover' && argv[1]==='--yes'
  const options=recover ? {command:'update',recover:true,yes:true} : JSON.parse(argv[0])
  const loc=locations(descriptor.root)
  if(loc.manager!==descriptor.manager) throw Error('使用创建恢复记录时的 XDG_STATE_HOME')
  const result=await maintain(loc,await jsonFile(loc.binding),options)
  console.log(JSON.stringify({code:0,...result}))
} catch(error) {
  process.exitCode=error.exitCode || 1
  console.error(JSON.stringify({code:process.exitCode,error:error.message}))
}
