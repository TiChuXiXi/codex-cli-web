import type { ThreadTokenUsage } from './types'

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function contextUsage(usage: ThreadTokenUsage | null | undefined) {
  const used = count(usage?.last?.totalTokens)
  const limit = count(usage?.modelContextWindow)
  const percent = used !== null && limit !== null && limit > 0
    ? Math.min(100, Math.max(0, Math.round(used / limit * 100)))
    : null
  return { used, limit: limit !== null && limit > 0 ? limit : null, percent }
}
