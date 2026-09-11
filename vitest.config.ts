import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src') }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['html', 'json', 'json-summary'],
      include: [
        'src/{audio-envelope,export-sources,online-templates,segment-time,types,video-range-transition}.ts',
        'src/renderer/src/model/**/*.ts',
        'src/main/progress.ts',
        'src/main/jobs.ts',
        'src/main/media-protocol.ts',
        'src/main/text-filters.ts',
        'src/main/frame-alpha.ts',
        'src/main/face-pack.ts',
        'src/main/face-process.ts',
        'src/main/face-export.ts',
        'src/main/face-preview.ts',
        'src/main/face-preview-cache.ts',
        'src/main/face-detection-cache.ts',
        'src/main/face-detection-stream.ts',
        'src/main/face-worker.ts',
        'src/main/preview-range.ts',
        'src/main/preview-seek.ts',
        'src/main/preview-timing.ts',
        'src/main/video-range-transition.ts',
        'src/main/validation.ts',
        'src/main/video-picker.ts',
        'src/main/online-templates.ts',
        'src/main/online-media.ts',
        'src/main/imkg.ts',
        'src/main/privileged-export.ts',
        'src/main/exporter.ts',
        'src/main/export-space.ts',
        'src/renderer/src/App.tsx',
        'src/renderer/src/components/AssetPanel.tsx',
        'src/renderer/src/components/ExportProgress.tsx',
        'src/renderer/src/components/ConfirmDialog.tsx',
        'src/renderer/src/components/VideoPicker.tsx',
        'src/renderer/src/components/OnlineTemplates.tsx',
        'src/renderer/src/components/FaceBlurPanel.tsx',
        'src/renderer/src/components/Preview.tsx',
        'src/renderer/src/components/preview-media.ts',
        'src/renderer/src/components/usePreviewAudioMixer.ts',
        'src/renderer/src/components/TransitionPreview.tsx',
        'src/renderer/src/components/RenderedPreview.tsx',
        'src/renderer/src/components/Inspector.tsx'
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85
      }
    }
  }
})
