import { useEffect, useState } from 'react'

export function useMediaUrl(path?: string): string {
  const [media, setMedia] = useState({ path, url: '' })
  useEffect(() => {
    let active = true
    if (path) void window.otc.getPathUrl(path)
      .then((url) => { if (active) setMedia({ path, url }) })
      .catch(() => undefined)
    return () => { active = false }
  }, [path])
  return media.path === path ? media.url : ''
}
