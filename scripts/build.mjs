import { build } from 'esbuild'
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = resolve(root, 'dist/web.next')
await rm(temporary, {recursive: true, force: true})
await mkdir(temporary, {recursive: true})
const result = await build({
  absWorkingDir: root, entryPoints: ['web/src/main.tsx'], bundle: true,
  outdir: temporary + '/assets', format: 'esm', platform: 'browser', target: 'es2022',
  jsx: 'automatic', loader: {'.module.css': 'local-css'}, write: false,
  minify: true, legalComments: 'eof',
  define: {'process.env.NODE_ENV': '"production"', __CODEX_BUNDLE_CSS__: '""',
    __CODEX_CLIENT_BUILD_ID__: JSON.stringify(process.env.CODEX_CLIENT_BUILD_ID || 'standalone-0.1.0')},
})
for (const file of result.outputFiles) { await mkdir(dirname(file.path), {recursive:true}); await writeFile(file.path, file.contents) }
await writeFile(temporary + '/index.html', await readFile(resolve(root, 'web/index.html')))
const buildId = createHash('sha256').update(result.outputFiles.find(f => f.path.endsWith('.js')).contents).digest('hex').slice(0, 16)
await writeFile(temporary + '/build.json', JSON.stringify({buildId}) + '\n')
await rm(resolve(root, 'dist/web'), {recursive: true, force: true})
await rename(temporary, resolve(root, 'dist/web'))
console.log('Built standalone web: ' + buildId)
