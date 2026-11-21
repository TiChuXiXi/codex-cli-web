import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { loadConfig } from '../config.js'
import { readAccessToken } from '../auth.js'
import { fault, jsonFile, lock, privateDirectory, save } from './common.js'

function within(parent,path) {
  const rel = relative(parent,path)
  return !rel || (!isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..')
}

export async function init(loc, args) {
  const saved = await jsonFile(loc.binding)
  const configFile = args.configFile || process.env.CODEX_WEB_CONFIG || saved?.configFile
  const stateDir = args.stateDir || process.env.CODEX_WEB_STATE_DIR || saved?.stateDir
  const options = { ...(configFile && {configFile:resolve(configFile)}), ...(stateDir && {stateDir:resolve(stateDir)}) }
  const config = await loadConfig(options)
  if (config.stateDir === parse(config.stateDir).root || within(loc.root,config.stateDir) ||
      within(config.stateDir,loc.root) || within(config.stateDir,loc.manager) || within(loc.manager,config.stateDir))
    throw fault(6,'实例数据目录与安装或管理目录重叠')
  await mkdir(dirname(config.stateDir),{recursive:true, mode:0o700})
  const path = join(await realpath(dirname(config.stateDir)), parse(config.stateDir).base)
  await privateDirectory(path)
  const directory = join(path,'zcodex-service')
  await privateDirectory(directory)
  const file = config.configFile || join(directory,'config.json')
  if (saved) {
    if (saved.stateDir !== path || saved.configFile !== file) throw fault(4,'此前已绑定其他状态目录或配置')
    return saved
  }
  const release = lock(join(directory,'service.sqlite'))
  try {
    const owner = await jsonFile(join(directory,'owner.json'))
    if (owner && owner.manager !== loc.manager) throw fault(4,'该状态目录已由其他安装前缀管理')
    const candidates=[join(path,'settings.json'),join(path,'worker-defaults.json'),join(path,'router-installation.json'),
      join(path,'router','wechat.key'),join(path,'router','router.sqlite'),join(path,'router','psm-index.sqlite'),
      ...Array.from({length:6},(_,i)=>join(directory,'service.log'+(i?'.'+i:'')))]
    if(!config.configFile) candidates.push(file)
    if(!config.accessToken && config.authMode==='token') candidates.push(join(path,'access-token'))
    const ownedFiles=[]
    for(const item of candidates) {
      try { await lstat(item) } catch(error) { if(error.code!=='ENOENT') throw error; ownedFiles.push(item) }
    }
    if (!config.configFile) {
      try { await writeFile(file,JSON.stringify({host:config.host,port:config.port},null,2)+'\n',{flag:'wx',mode:0o600}) }
      catch (error) { if(error.code !== 'EEXIST') throw error }
    }
    if(config.authMode === 'token') await readAccessToken({...config,stateDir:path})
    const instance = {id:owner?.id || randomUUID(), manager:loc.manager, stateDir:path, configFile:file,
      directory, log:join(directory,'service.log'),ownedFiles}
    await save(join(directory,'owner.json'),{id:instance.id,manager:loc.manager})
    await save(loc.binding,instance)
    return instance
  } finally { release() }
}

export async function bound(loc,args) {
  const instance = await jsonFile(loc.binding)
  if (!instance) throw fault(2,'请先执行 zcodex init')
  const stateDir = args.stateDir || process.env.CODEX_WEB_STATE_DIR
  const config = args.configFile || process.env.CODEX_WEB_CONFIG
  if ((stateDir && await realpath(resolve(stateDir)) !== instance.stateDir) ||
      (config && resolve(config) !== instance.configFile)) throw fault(4,'指定位置与已绑定实例不符')
  const owner = await jsonFile(join(instance.directory,'owner.json'))
  if (owner?.id !== instance.id || owner.manager !== loc.manager) throw fault(4,'实例归属不符')
  return instance
}

