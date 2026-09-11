/// <reference types="vite/client" />

import type { otcApi } from '../../types'

declare global {
  interface Window {
    otc: otcApi
  }
}

export {}
