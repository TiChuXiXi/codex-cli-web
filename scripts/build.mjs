import { build } from 'esbuild'
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const destination = resolve(process.argv[2] || root, 'dist')
const buildVersion = process.argv[3] || version
const temporary = resolve(destination, 'web.next')
await rm(temporary, {recursive: true, force: true})
await mkdir(temporary, {recursive: true})
const result = await build({
  absWorkingDir: root, entryPoints: ['web/src/main.tsx'], bundle: true,
  outdir: temporary + '/assets', format: 'esm', platform: 'browser', target: 'es2022',
  jsx: 'automatic', loader: {'.module.css': 'local-css'}, write: false,
  minify: true, legalComments: 'eof',
  define: {'process.env.NODE_ENV': '"production"', __CODEX_BUNDLE_CSS__: '""', __CODEX_PACKAGE_VERSION__:JSON.stringify(buildVersion),
    __CODEX_CLIENT_BUILD_ID__: JSON.stringify(process.env.CODEX_CLIENT_BUILD_ID || 'standalone-' + buildVersion)},
})
for (const file of result.outputFiles) { await mkdir(dirname(file.path), {recursive:true}); await writeFile(file.path, file.contents) }
await writeFile(temporary + '/index.html', await readFile(resolve(root, 'web/index.html')))
const buildId = createHash('sha256').update(result.outputFiles.find(f => f.path.endsWith('.js')).contents).digest('hex').slice(0, 16)
await writeFile(temporary + '/build.json', JSON.stringify({buildId, version:buildVersion}) + '\n')
await rm(resolve(destination, 'web'), {recursive: true, force: true})
await rename(temporary, resolve(destination, 'web'))
console.log('Built standalone web: ' + buildId)
