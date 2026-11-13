import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import { readSupabaseEnv } from './src/shared/lib/env.ts'

export default defineConfig(({ mode }) => {
  readSupabaseEnv(loadEnv(mode, process.cwd(), 'VITE_'))
  return { plugins: [react(), tailwindcss()] }
})
