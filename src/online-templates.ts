export type TemplateSource = 'memefact' | 'imgflip' | 'imkg' | 'wikimedia'
export type TemplateCategory = 'image' | 'video' | 'audio'

export const templateSources = ['memefact', 'imgflip', 'imkg', 'wikimedia'] as const
export const maxOnlineTemplates = 24

export interface OnlineTemplate {
  id: string
  source: TemplateSource
  name: string
  type: 'image' | 'gif' | 'video' | 'audio'
  url: string
}

export const templateSourceNames: Record<TemplateSource, string> = {
  memefact: 'MemeFact · HF',
  imgflip: 'Imgflip',
  imkg: 'IMKG',
  wikimedia: 'Wikimedia Commons'
}

type ProviderResults = Partial<Record<TemplateSource, readonly OnlineTemplate[]>>

function templateIdentity(template: OnlineTemplate): string {
  if (template.source === 'imkg' || template.source === 'wikimedia') return `${template.source}:${template.id}`
  const id = template.id.trim()
  if (/^\d+$/.test(id)) return `blank:${id.replace(/^0+(?=\d)/, '')}`
  return `${template.source}:${id}`
}

/** Merge complete provider responses in a fixed round-robin order before capping. */
export function mergeOnlineTemplates(results: ProviderResults): OnlineTemplate[] {
  const cursors: Record<TemplateSource, number> = { memefact: 0, imgflip: 0, imkg: 0, wikimedia: 0 }
  const seen = new Set<string>()
  const merged: OnlineTemplate[] = []

  while (merged.length < maxOnlineTemplates) {
    let added = false
    for (const source of templateSources) {
      const entries = results[source] ?? []
      let candidate: OnlineTemplate | undefined
      while (cursors[source] < entries.length) {
        const next = entries[cursors[source]++]
        if (!next) continue
        if (seen.has(templateIdentity(next))) continue
        candidate = next
        break
      }
      if (!candidate) continue
      seen.add(templateIdentity(candidate))
      merged.push(candidate)
      added = true
      if (merged.length === maxOnlineTemplates) return merged
    }
    if (!added) break
  }
  return merged
}
