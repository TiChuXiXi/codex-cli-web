import { realpath, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}
export function createStatic(root) {
  return async(request,response,pathname)=>{
    if(!['GET','HEAD'].includes(request.method)) {response.writeHead(405,{allow:'GET, HEAD'});response.end();return}
    let decoded
    try {decoded=decodeURIComponent(pathname)} catch {response.writeHead(400);response.end();return}
    if(decoded.includes('\0')||decoded.includes('\\')||decoded.split('/').some(p=>p==='..'||p.startsWith('.'))) {response.writeHead(403);response.end();return}
    const base=await realpath(root)
    let path=resolve(base,'.'+decoded)
    try {path=await realpath(path);if(!(await stat(path)).isFile())throw new Error('directory')}
    catch {
      if(extname(decoded)||decoded.startsWith('/assets/')) {response.writeHead(404);response.end('not found');return}
      path=resolve(base,'index.html')
    }
    if(!path.startsWith(base+sep)) {response.writeHead(403);response.end();return}
    const info=await stat(path)
    response.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream','content-length':info.size,'cache-control':extname(path)==='.html'?'no-store':'no-cache','x-content-type-options':'nosniff','referrer-policy':'same-origin','cross-origin-resource-policy':'same-origin'})
    if(request.method==='HEAD')response.end()
    else await pipeline(createReadStream(path),response)
  }
}
