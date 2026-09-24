import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Tauri 期望固定端口；strictPort 避免端口漂移
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts', 'cli/**/*.test.ts'],
    environment: 'node',
  },
})
