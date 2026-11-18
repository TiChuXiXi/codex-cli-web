const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim()
const tokens = value => normalize(value).split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 2)

function containsName(text, name) {
  if (name === '' || !text.includes(name)) return false
  const start = text.indexOf(name)
  const end = start + name.length
  if (/^[\p{Script=Han}]/u.test(name) || /[\p{Script=Han}]$/u.test(name)) return true
  return !/[a-z0-9_]/i.test(text[start - 1] ?? '') && !/[a-z0-9_]/i.test(text[end] ?? '')
}

export function rankCandidates(entries, query, { original = query, now = Date.now() } = {}) {
  const needle = normalize(query)
  const source = normalize(original)
  const queryTokens = tokens(needle)
  return entries.map(entry => {
    const names = [entry.id, entry.name, ...(entry.aliases ?? [])].map(normalize).filter(Boolean)
    const explicit = names.some(name => containsName(source, name))
    const exact = names.includes(needle)
    const nameTokens = tokens(names.join(' '))
    const namesMatch = needle && (names.some(name => name.includes(needle)) ||
      queryTokens.some(token => nameTokens.includes(token)))
    const summary = normalize(entry.summary)
    const summaryMatch = queryTokens.some(token => summary.includes(token))
    const recent = Number.isFinite(entry.updatedAt) && now - entry.updatedAt < 7 * 86400000
    const reasons = []
    if (explicit) reasons.push('原文明确提到')
    if (namesMatch && !explicit) reasons.push('名称或别名匹配')
    if (summaryMatch) reasons.push('摘要匹配')
    if (recent) reasons.push('近期活动')
    const score = explicit ? 100 : (exact ? 85 : namesMatch ? 60 : 0) +
      (summaryMatch ? 10 : 0) + (recent ? 5 : 0)
    return { ...entry, score, reasons, explicit }
  }).filter(entry => !needle || entry.score > 5)
    .sort((left, right) => right.score - left.score ||
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.id.localeCompare(right.id))
}
