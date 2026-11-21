import { cp, lstat, mkdir, mkdtemp, realpath, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { backup, DatabaseSync } from 'node:sqlite'
import { fault, jsonFile, lock, privateDirectory, save } from './common.js'
import { npmClient } from './npm.js'
import { start, status, stop } from './process.js'

export async function prepareHelper(loc) {
  const folder = await mkdtemp(join(loc.manager,'helper-'))
  await privateDirectory(folder)
  await mkdir(join(folder,'server','router'),{recursive:true})
  await cp(join(loc.root,'server','lifecycle'),join(folder,'server','lifecycle'),{recursive:true})
  await cp(join(loc.root,'server','router','windows-access.js'),join(folder,'server','router','windows-access.js'))
  await save(join(folder,'package.json'),{type:'module'})
  await save(join(folder,'installation.json'),{root:loc.root,manager:loc.manager})
  return folder
}

async function snapshot(instance, folder) {
  const databases=[['router.sqlite',4],['psm-index.sqlite',1]]
  for (const [name,maxVersion] of databases) {
    const path=join(instance.stateDir,'router',name)
    let info
    try { info=await lstat(path) } catch(e) { if(e.code==='ENOENT') continue; throw e }
    if(!info.isFile() || await realpath(path)!==path) throw fault(6,'无法验证数据库路径')
    const db=new DatabaseSync(path,{readOnly:true})
    try {
      const version=db.prepare('PRAGMA user_version').get().user_version
      if(version>maxVersion || db.prepare('PRAGMA quick_check').get().quick_check!=='ok') throw fault(6,'数据库完整性或版本不符合当前升级条件')
      await backup(db,join(folder,name))
    } finally { db.close() }
  }
}

async function purgeFiles(instance) {
  const files=[]
  for(const path of instance.ownedFiles || []) {
    const rel=relative(instance.stateDir,path)
    if(!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw fault(6,'清除清单路径越界')
    const item=await lstat(path).catch(e=>{if(e.code!=='ENOENT') throw e})
    if(!item) continue
    if(!item.isFile() || await realpath(path)!==path) throw fault(6,'清除目标已更换：'+path)
    files.push(path)
  }
  return files
}

async function apply(loc,instance,args) {
  if (!loc.globalInstall) throw fault(6,'维护操作需要使用全局安装的 zcodex')
  const client=await npmClient(loc.manager)
  const {npm,semver}=client
  const globalArgs=['--global','--prefix',loc.prefix,'--no-audit','--no-fund']
  const running=await status(instance)
  const active=running.state!=='stopped'
  const pending=await jsonFile(loc.journal)
  async function install(file) {
    await npm(['install',...globalArgs,'--engine-strict','--ignore-scripts',file])
  }
  if(pending) {
    if (!args.recover || !args.yes || pending.id!==instance.id) throw fault(7,'上次维护尚未完成，请核对 maintenance.json 后执行 update --recover --yes')
    if(active) throw fault(7,'请先核实并停止当前服务，再恢复')
    if(['activating','purging'].includes(pending.phase)) throw fault(7,'业务或数据状态可能已改变，请先核对现有数据库和备份')
    if(pending.oldFile) await install(pending.oldFile)
    if(pending.active && (await start(loc,instance)).state!=='running') throw fault(7,'旧版本就绪检查失败')
    await unlink(loc.journal)
    return {state:'recovered',version:pending.from}
  }
  if(args.recover) return {state:'no-pending-operation'}
  const installed=await jsonFile(join(loc.root,'package.json'))
  if(installed?.name!=='zcodex') throw fault(4,'全局安装目录中的包身份不匹配')
  const update=args.command==='update'
  let target
  if(update) {
    target=JSON.parse(await npm(['view','zcodex@latest','version','--json','--prefer-online']))
    if(!semver.valid(target) || semver.prerelease(target)) throw fault(2,'latest 应指向精确的稳定版本')
    const available=semver.gt(target,installed.version)
    if(args.check || !available) return {state:available?'update-available':'up-to-date',version:installed.version,target,available}
  }
  if (!args.yes) throw fault(6,'修改安装包需要确认，请加 --yes')
  if(args.purge) {
    const list=await purgeFiles(instance)
    if(args.confirmPurge!==instance.id) throw fault(6,'清除清单 '+JSON.stringify(list)+' 需要 --confirm-purge '+instance.id)
  }
  const folder=await mkdtemp(join(loc.manager,'operation-'))
  let oldFile,newFile
  async function pack(spec) {
    const [result]=JSON.parse(await npm(['pack',spec,'--ignore-scripts','--pack-destination',folder,'--json']))
    if(result.name!=='zcodex') throw fault(4,'缓存的包名不匹配')
    return {file:join(folder,result.filename),version:result.version}
  }
  const old=await pack(loc.root)
  if(old.version!==installed.version) throw fault(4,'已安装版本已变化')
  oldFile=old.file
  if(update) {
    const next=await pack('zcodex@'+target)
    const manifest=await client.manifest(next.file)
    if(next.version!==target || !manifest.bin?.zcodex || !manifest.engines?.node ||
        !semver.satisfies(process.versions.node,manifest.engines.node)) throw fault(3,'候选版本与当前运行环境不兼容')
    newFile=next.file
  }
  const operation={id:instance.id,from:installed.version,target,oldFile,newFile,active,phase:'prepared'}
  await save(loc.journal,operation)
  let stopped=false, mutating=false, activating=false
  const purged=[]
  try {
    if(active) await stop(instance,true,true)
    stopped=true
    await snapshot(instance,folder)
    operation.phase='replacing'
    await save(loc.journal,operation)
    mutating=true
    if(update) {
      await install(newFile)
      const actual=await jsonFile(join(loc.root,'package.json'))
      const build=await jsonFile(join(loc.root,'dist','web','build.json'))
      if(actual?.version!==target || build?.version!==target || !build?.buildId) throw fault(7,'安装后的程序或 Web 版本不匹配')
      try {
        await promisify(execFile)(process.execPath,[join(loc.root,'server/lifecycle/preflight.js'),loc.binding],
          {cwd:instance.directory,windowsHide:true,timeout:60000,maxBuffer:1024*1024})
      } catch { throw fault(7,'新版本维护检查失败') }
      if(active) {
        operation.phase='activating'
        await save(loc.journal,operation)
        activating=true
        const next=await start(loc,instance)
        if(next.version!==target || next.state!=='running') throw fault(7,'新版本未就绪，已保留维护记录')
      }
    } else {
      await npm(['uninstall',...globalArgs,'--ignore-scripts','zcodex'])
      if(await jsonFile(join(loc.root,'package.json'))) throw fault(7,'npm 返回后包目录仍存在')
      if(args.purge) {
        activating=true
        operation.phase='purging'
        await save(loc.journal,operation)
        for(const path of await purgeFiles(instance)) {
          await unlink(path)
          purged.push(path)
        }
        await unlink(join(instance.directory,'owner.json'))
        await unlink(loc.binding)
      }
    }
  } catch(error) {
    if(activating) throw fault(7,error.message)
    try {
      if(mutating) await install(oldFile)
      if(stopped && active && (await start(loc,instance)).state!=='running') throw Error('旧版本未就绪')
      await unlink(loc.journal)
    } catch { throw fault(7,'自动恢复未完成，恢复记录位于 '+loc.journal) }
    await rm(folder,{recursive:true,force:true})
    if(mutating) throw fault(1,error.message+'；已恢复 '+installed.version+' 和原运行状态')
    throw error
  }
  await unlink(loc.journal)
  await rm(folder,{recursive:true,force:true})
  return {state:update?(active?'running':'stopped'):'uninstalled',from:installed.version,version:target,
    stateDir:instance.stateDir,...(!update && {purged})}
}

export async function maintain(loc,instance,args) {
  const release=lock(join(loc.manager,'operation.sqlite'))
  try {
    const owner=await jsonFile(join(instance.directory,'owner.json'))
    if (owner?.id!==instance.id || owner.manager!==loc.manager) throw fault(4,'实例归属已改变')
    return await apply(loc,instance,args)
  } finally { release() }
}
