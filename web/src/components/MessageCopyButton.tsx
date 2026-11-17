import * as React from 'react'
import { IconButton } from './Icon'
import { toast } from './Toast'
import { useT } from '../i18n'

export function MessageCopyButton({ text }: { text: string }) {
  const t = useT()
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  React.useEffect(() => setCopied(false), [text])
  return <IconButton
    icon={copied ? 'check' : 'copy'}
    label={t(copied ? 'item.copied' : 'item.copyQuestion')}
    className={'dsh-codex-message-copy' + (copied ? ' is-copied' : '')}
    onClick={async () => {
      try {
        await copyText(text)
        setCopied(true)
      } catch {
        toast(t('item.copyFailed'), 'error')
      }
    }}
  />
}

/** The fallback supports DSH instances served over plain HTTP on a local network. */
async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const previous = document.activeElement
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const field = document.createElement('textarea')
  field.value = text
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  field.setAttribute('aria-hidden', 'true')
  document.body.append(field)
  try {
    field.select()
    if (!document.execCommand('copy')) throw new Error('Copy unavailable')
  } finally {
    field.remove()
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}
