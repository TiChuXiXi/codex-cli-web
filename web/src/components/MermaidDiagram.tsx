import * as React from 'react'
import { useT } from '../i18n'
import { ImageViewer } from './ImageViewer'

// Mermaid has global configuration; keep initialization and rendering in one queue.
let renderQueue: Promise<unknown> = Promise.resolve()
let nextId = 0
async function renderDiagram(text: string, dark: boolean, active: () => boolean): Promise<string | null> {
  const task = renderQueue.catch(() => {}).then(async () => {
    if (!active()) return null
    const { default: mermaid } = await import('mermaid')
    if (!active()) return null
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default',
      fontFamily: 'Arial, sans-serif',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // Keep document directives from enabling HTML labels or relaxing security.
      secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'],
    })
    const container = document.createElement('div')
    container.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;width:1200px;pointer-events:none'
    document.body.appendChild(container)
    try {
      const { svg } = await mermaid.render('codex-mermaid-' + (++nextId), text, container)
      // SVG stays an image: no document scripts, links or styles enter the host DOM.
      const image = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
      const viewBox = image.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
      if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
        image.setAttribute('width', String(viewBox[2]))
        image.setAttribute('height', String(viewBox[3]))
      }
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(image))
    } finally {
      container.remove()
    }
  })
  renderQueue = task
  return task
}

export function MermaidDiagram({ text, source }: { text: string, source: React.ReactNode }) {
  const t = useT()
  const element = React.useRef<HTMLDivElement>(null)
  const [dark, setDark] = React.useState(false)
  const [result, setResult] = React.useState<{text:string, dark:boolean, url?:string, failed?:boolean} | null>(null)
  React.useEffect(() => {
    const root = element.current?.closest('.dsh-codex-root')
    if (!root) return
    const update = () => setDark(root.getAttribute('data-codex-theme') === 'dark')
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, {attributes:true, attributeFilter:['data-codex-theme']})
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    let active = true
    void renderDiagram(text, dark, () => active).then(url => {
      if (active && url) setResult({text, dark, url})
    }).catch(() => {
      if (active) setResult({text, dark, failed:true})
    })
    return () => { active = false }
  }, [text, dark])
  const current = result?.text === text && result.dark === dark ? result : null
  return <div ref={element} className="dsh-codex-mermaid">
    {current?.failed ? <><p role="status">{t('markdown.diagramFailed')}</p>{source}</> :
      current?.url ? <ImageViewer src={current.url} alt={t('markdown.diagram')} onError={() => setResult({text, dark, failed:true})} /> :
      <p role="status">{t('markdown.diagramLoading')}</p>}
  </div>
}
