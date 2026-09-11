export type VideoDirectoryEntryKind = 'directory' | 'video'

export interface VideoDirectoryEntry {
  path: string
  name: string
  kind: VideoDirectoryEntryKind
}

export interface VideoDirectory {
  path: string
  parent: string | null
  entries: VideoDirectoryEntry[]
  truncated: boolean
}
