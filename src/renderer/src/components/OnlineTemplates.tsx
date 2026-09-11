import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import type { OnlineTemplate, TemplateCategory, TemplateSource } from '@shared/online-templates'
import { maxOnlineTemplates, mergeOnlineTemplates, templateSourceNames, templateSources } from '@shared/online-templates'
import type { AssetItem } from '@shared/types'
import './online-templates.css'

const searchDebounceMs = 350

type ProviderResults = Record<TemplateSource, OnlineTemplate[]>
type ProviderFlags = Record<TemplateSource, boolean>
type ProviderErrors = Record<TemplateSource, string | null>

export interface OnlineTemplatesProps {
  category: TemplateCategory
  query: string
  projectId: string
  onAsset: (asset: AssetItem) => void
  onError: (message: string) => void
  children?: ReactNode
}

function emptyResults(): ProviderResults {
  return { memefact: [], imgflip: [], imkg: [], wikimedia: [] }
}

function emptyFlags(): ProviderFlags {
  return { memefact: false, imgflip: false, imkg: false, wikimedia: false }
}

function emptyErrors(): ProviderErrors {
  return { memefact: null, imgflip: null, imkg: null, wikimedia: null }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function templateKey(template: OnlineTemplate): string {
  if (template.source === 'imkg' || template.source === 'wikimedia') return template.id
  const id = template.id.trim()
  return /^\d+$/.test(id) ? id.replace(/^0+(?=\d)/, '') : id
}

function previewKey(template: OnlineTemplate): string {
  return `${template.source}:${templateKey(template)}`
}

function allowedPreviewUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null
    if (hostname !== 'imgflip.com' && hostname !== 'i.imgflip.com' && hostname !== 'upload.wikimedia.org') return null
    return parsed.href
  } catch {
    return null
  }
}

function releasePreviewMedia(media: HTMLMediaElement | null): void {
  if (!media) return
  media.pause()
  media.removeAttribute('src')
  media.load()
}

function isInside(currentTarget: HTMLElement, relatedTarget: EventTarget | null): boolean {
  return relatedTarget instanceof Node && currentTarget.contains(relatedTarget)
}

function providerList(category: TemplateCategory): TemplateSource[] {
  if (category === 'image') return templateSources.filter((source) => source !== 'wikimedia')
  if (category === 'audio') return ['wikimedia']
  return ['imgflip']
}

export function OnlineTemplates({ category, query, projectId, onAsset, onError, children }: OnlineTemplatesProps): React.JSX.Element {
  const [results, setResults] = useState<ProviderResults>(emptyResults)
  const [loading, setLoading] = useState<ProviderFlags>(emptyFlags)
  const [providerErrors, setProviderErrors] = useState<ProviderErrors>(emptyErrors)
  const [preview, setPreview] = useState<OnlineTemplate | null>(null)
  const [addingKey, setAddingKey] = useState<string | null>(null)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const requestGenerationRef = useRef(0)
  const addingKeyRef = useRef<string | null>(null)
  const previewMediaRef = useRef<HTMLMediaElement | null>(null)
  const activePreviewKeyRef = useRef<string | null>(null)
  const hoveredTemplateRef = useRef<OnlineTemplate | null>(null)
  const focusedTemplateRef = useRef<OnlineTemplate | null>(null)

  const releaseMedia = useCallback((): void => {
    releasePreviewMedia(previewMediaRef.current)
    previewMediaRef.current = null
  }, [])

  const setPreviewMedia = useCallback((element: HTMLMediaElement | null): void => {
    if (!element) {
      releaseMedia()
      return
    }
    previewMediaRef.current = element
  }, [releaseMedia])

  const showPreview = useCallback((template: OnlineTemplate): void => {
    const key = previewKey(template)
    if (activePreviewKeyRef.current === key) return
    releaseMedia()
    activePreviewKeyRef.current = key
    setPreview(template)
  }, [releaseMedia])

  const clearPreview = useCallback((): void => {
    releaseMedia()
    activePreviewKeyRef.current = null
    setPreview(null)
  }, [releaseMedia])

  const applyPreviewIntent = useCallback((): void => {
    const next = hoveredTemplateRef.current ?? focusedTemplateRef.current
    if (next) showPreview(next)
    else clearPreview()
  }, [clearPreview, showPreview])

  useEffect(() => {
    const generation = ++requestGenerationRef.current
    const trimmedQuery = query.trim()
    const activeProviders = providerList(category)
    setResults(emptyResults())
    setLoading(emptyFlags())
    setProviderErrors(emptyErrors())
    addingKeyRef.current = null
    setAddingKey(null)
    hoveredTemplateRef.current = null
    focusedTemplateRef.current = null
    clearPreview()

    if (trimmedQuery.length < 2) {
      return () => { requestGenerationRef.current += 1 }
    }

    const pendingFlags = emptyFlags()
    for (const source of activeProviders) pendingFlags[source] = true
    setLoading(pendingFlags)
    const timer = setTimeout(() => {
      for (const source of activeProviders) {
        if (requestGenerationRef.current !== generation) return
        void (async () => {
          try {
            const found = await window.otc.searchTemplates(source, category, trimmedQuery)
            if (requestGenerationRef.current !== generation) return
            setResults((previous) => ({ ...previous, [source]: found.slice(0, maxOnlineTemplates) }))
            setProviderErrors((previous) => ({ ...previous, [source]: null }))
          } catch (cause) {
            if (requestGenerationRef.current !== generation) return
            const detail = errorMessage(cause).trim()
            setProviderErrors((previous) => ({
              ...previous,
              [source]: detail ? `${templateSourceNames[source]} unavailable. ${detail.slice(0, 180)}` : `${templateSourceNames[source]} unavailable.`
            }))
          } finally {
            if (requestGenerationRef.current === generation) {
              setLoading((previous) => ({ ...previous, [source]: false }))
            }
          }
        })()
      }
    }, searchDebounceMs)

    return () => {
      clearTimeout(timer)
      requestGenerationRef.current += 1
    }
  }, [category, clearPreview, projectId, query, retryGeneration])

  useEffect(() => () => {
    requestGenerationRef.current += 1
    addingKeyRef.current = null
    releaseMedia()
  }, [releaseMedia])

  const visibleTemplates = useMemo(() => mergeOnlineTemplates(results), [results])
  const trimmedQuery = query.trim()
  const activeProviders = providerList(category)
  const previewUrl = preview ? allowedPreviewUrl(preview.url) : null
  const providerFailed = activeProviders.some((source) => providerErrors[source] !== null)
  const providerLoading = activeProviders.some((source) => loading[source])
  const retrySearch = useCallback((): void => {
    setRetryGeneration((generation) => generation + 1)
  }, [])

  const setHover = useCallback((template: OnlineTemplate | null): void => {
    hoveredTemplateRef.current = template
    applyPreviewIntent()
  }, [applyPreviewIntent])

  const setFocus = useCallback((template: OnlineTemplate | null): void => {
    focusedTemplateRef.current = template
    applyPreviewIntent()
  }, [applyPreviewIntent])

  const importTemplate = useCallback(async (template: OnlineTemplate): Promise<void> => {
    if (addingKeyRef.current !== null) return
    const generation = requestGenerationRef.current
    const key = `${template.source}:${templateKey(template)}`
    addingKeyRef.current = key
    setAddingKey(key)
    hoveredTemplateRef.current = null
    focusedTemplateRef.current = null
    clearPreview()
    try {
      const asset = await window.otc.importTemplate(template.source, template.id)
      if (requestGenerationRef.current !== generation) return
      onAsset(asset)
    } catch (cause) {
      if (requestGenerationRef.current === generation) {
        const detail = errorMessage(cause).trim()
        onError(detail ? `Could not add template. ${detail.slice(0, 240)}` : 'Could not add template.')
      }
    } finally {
      if (requestGenerationRef.current === generation) {
        addingKeyRef.current = null
        setAddingKey((current) => current === key ? null : current)
      }
    }
  }, [clearPreview, onAsset, onError])

  const openTemplatePage = useCallback((template: OnlineTemplate): void => {
    void window.otc.openTemplatePage(template.source, template.id).catch((cause: unknown) => {
      const detail = errorMessage(cause).trim()
      const provider = templateSourceNames[template.source]
      onError(detail ? `Could not open ${provider}. ${detail.slice(0, 240)}` : `Could not open ${provider}.`)
    })
  }, [onError])

  return (
    <section className="online-templates" aria-label="Online templates">
      {trimmedQuery.length >= 2 && (providerLoading || providerFailed) && <div className="online-template-provider-status" aria-live="polite">
        {activeProviders.map((source) => loading[source] && <span key={`${source}-loading`}>{templateSourceNames[source]} searching…</span>)}
        {activeProviders.map((source) => providerErrors[source] && <span className="online-template-provider-error" role="status" key={`${source}-error`}>{providerErrors[source]}</span>)}
        {providerFailed && !providerLoading && <button type="button" className="online-template-retry" disabled={addingKey !== null} onClick={retrySearch}>Retry online search</button>}
      </div>}
      <div className="asset-list">
        {children}
        {visibleTemplates.map((template) => {
          const key = `${template.source}:${templateKey(template)}`
          const adding = addingKey === key
          return (
            <div
              className="online-template-row"
              key={key}
              onMouseOver={(event: MouseEvent<HTMLDivElement>) => {
                if (!isInside(event.currentTarget, event.relatedTarget)) setHover(template)
              }}
              onMouseOut={(event: MouseEvent<HTMLDivElement>) => {
                if (!isInside(event.currentTarget, event.relatedTarget) && hoveredTemplateRef.current && previewKey(hoveredTemplateRef.current) === previewKey(template)) setHover(null)
              }}
              onFocus={(event: FocusEvent<HTMLDivElement>) => {
                if (!isInside(event.currentTarget, event.relatedTarget)) setFocus(template)
              }}
              onBlur={(event: FocusEvent<HTMLDivElement>) => {
                if (!isInside(event.currentTarget, event.relatedTarget) && focusedTemplateRef.current && previewKey(focusedTemplateRef.current) === previewKey(template)) setFocus(null)
              }}
            >
              <button
                type="button"
                className="visual-asset online-template-import"
                data-template-id={template.id}
                data-template-source={template.source}
                aria-busy={adding}
                disabled={addingKey !== null}
                onClick={() => void importTemplate(template)}
                title={`Online · ${templateSourceNames[template.source]}: ${template.name}`}
              >
                {adding ? `Adding… ${template.name}` : template.name}
              </button>
              <button
                type="button"
                className="online-template-link"
                onClick={(event) => {
                  event.stopPropagation()
                  openTemplatePage(template)
                }}
                aria-label={`View source for ${template.name}`}
                title={`View source for ${template.name}`}
              >
                <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3Z" />
                  <path d="M4.5 7.5h15M4.5 16.5h15" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
      {preview && <aside className="asset-hover-card online-template-preview" aria-label={`Preview of ${preview.name}`}>
        <strong title={`Online · ${templateSourceNames[preview.source]}: ${preview.name}`}>
          Online · {templateSourceNames[preview.source]}: {preview.name}
        </strong>
        {!previewUrl && <p className="online-template-preview-missing">Preview unavailable.</p>}
        {previewUrl && preview.type === 'video' && <video
          key={previewKey(preview)}
          ref={setPreviewMedia}
          src={previewUrl}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />}
        {previewUrl && preview.type === 'audio' && <audio
          key={previewKey(preview)}
          ref={setPreviewMedia}
          src={previewUrl}
          autoPlay
          loop
          controls
          preload="metadata"
        />}
        {previewUrl && preview.type !== 'video' && preview.type !== 'audio' && <img src={previewUrl} alt="" />}
      </aside>}
    </section>
  )
}
