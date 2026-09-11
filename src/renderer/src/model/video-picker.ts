import { create } from 'zustand'

export interface VideoPickerState {
  open: boolean
  chooseVideo: () => Promise<string | null>
  finish: (path: string | null) => void
}

interface PendingChoice {
  promise: Promise<string | null>
  resolve: (path: string | null) => void
}

let pendingChoice: PendingChoice | null = null

export const useVideoPickerStore = create<VideoPickerState>((set) => ({
  open: false,
  chooseVideo: () => {
    if (pendingChoice) {
      set({ open: true })
      return pendingChoice.promise
    }
    let resolveChoice: (path: string | null) => void = () => undefined
    const promise = new Promise<string | null>((resolve) => { resolveChoice = resolve })
    pendingChoice = { promise, resolve: resolveChoice }
    set({ open: true })
    return promise
  },
  finish: (path) => {
    const choice = pendingChoice
    pendingChoice = null
    set({ open: false })
    choice?.resolve(path)
  }
}))

export const chooseVideo = (): Promise<string | null> => useVideoPickerStore.getState().chooseVideo()

export const finishVideoChoice = (path: string | null): void => {
  useVideoPickerStore.getState().finish(path)
}
