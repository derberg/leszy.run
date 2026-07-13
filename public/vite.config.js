import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({ mode }) => {
  // Env lives at the repo root (see envDir), so load it from there.
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const supabaseUrl = env.VITE_SUPABASE_URL?.trim()

  return {
    plugins: [react(), tailwindcss()],
    envDir: path.resolve(__dirname, '..'),
    // Mirror the production Vercel rewrite (public/vercel.json): proxy the
    // same-origin `/edge/*` path to the Supabase functions host so auth cookies
    // stay first-party in local dev too. Without this, `/edge` 404s under vite.
    server: supabaseUrl
      ? {
          proxy: {
            '/edge': {
              target: supabaseUrl,
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/edge/, '/functions/v1'),
            },
          },
        }
      : undefined,
  }
})
