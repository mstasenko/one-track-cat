import type { OnlineTemplate } from '../online-templates'
import { maxOnlineTemplates } from '../online-templates'
import catalog from './imkg-catalog.json'

// Only searchable metadata is bundled. Preview/add fetch the original captioned image.
const entries = catalog.memes.map((meme) => ({
  template: {
    id: meme.id,
    source: 'imkg',
    name: meme.name,
    type: 'image',
    url: meme.url
  } satisfies OnlineTemplate,
  name: meme.name.toLowerCase(),
  caption: meme.caption.toLowerCase()
}))

export function searchImkg(query: string): OnlineTemplate[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const nameMatches: OnlineTemplate[] = []
  const captionMatches: OnlineTemplate[] = []
  for (const entry of entries) {
    if (words.every((word) => entry.name.includes(word))) {
      nameMatches.push(entry.template)
      if (nameMatches.length === maxOnlineTemplates) return nameMatches
    } else if (
      captionMatches.length < maxOnlineTemplates
      && words.every((word) => entry.name.includes(word) || entry.caption.includes(word))
    ) {
      captionMatches.push(entry.template)
    }
  }
  return [...nameMatches, ...captionMatches].slice(0, maxOnlineTemplates)
}
