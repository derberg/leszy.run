import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'fs'

// Mirror production response headers (public/vercel.json) onto the dev and
// preview servers. Headers like Permissions-Policy change what browser APIs a
// page may use — when dev omits them, a prod-only breakage is invisible until
// after deploy (geolocation=() silently killed "Blisko mnie" for two weeks).
// Reading vercel.json keeps the two in sync with no duplicate list to maintain.
const prodHeaders = Object.fromEntries(
  (JSON.parse(readFileSync(path.resolve(__dirname, 'vercel.json'), 'utf8')).headers ?? [])
    .flatMap((rule) => rule.headers)
    .map((h) => [h.key, h.value])
)

// Serve the Vercel Functions in api/ from the dev server, so `vite dev` runs
// the same handler production does. Vercel calls them with Node's request and
// response, which is what a Connect middleware gets too.
function vercelApi(env) {
  return {
    name: 'vercel-api',
    configureServer(server) {
      process.env.VITE_SUPABASE_URL ??= env.VITE_SUPABASE_URL
      process.env.VITE_SUPABASE_ANON_KEY ??= env.VITE_SUPABASE_ANON_KEY
      server.middlewares.use('/api/results', async (req, res) => {
        const { default: handler } = await server.ssrLoadModule('/api/results.js')
        await handler(req, res)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Env lives at the repo root (see envDir), so load it from there.
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const supabaseUrl = env.VITE_SUPABASE_URL?.trim()

  return {
    plugins: [react(), tailwindcss(), vercelApi(env)],
    envDir: path.resolve(__dirname, '..'),
    // Pure registration rules shared with the edge functions (plain ESM, no runtime APIs).
    resolve: { alias: { '@registration': path.resolve(__dirname, '../supabase/functions/_shared/registration') } },
    preview: { headers: prodHeaders },
    // Mirror the production Vercel rewrite (public/vercel.json): proxy the
    // same-origin `/edge/*` path to the Supabase functions host so auth cookies
    // stay first-party in local dev too. Without this, `/edge` 404s under vite.
    server: {
      headers: prodHeaders,
      fs: { allow: [path.resolve(__dirname, '..'), path.resolve(__dirname, '../supabase/functions/_shared/registration')] },
      ...(supabaseUrl
        ? {
          proxy: {
            '/edge': {
              target: supabaseUrl,
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/edge/, '/functions/v1'),
            },
            // NOTE: bare `/klub/:slug` used to proxy here to the render-club SSR
            // function (mirroring the old Vercel rewrite). That function is retired
            // in favor of static generation (generate-club-pages.js) — under `vite
            // dev` a club page won't exist as a static file, so it falls through to
            // the SPA, which doesn't own the bare route either (only
            // `/klub/:slug/dolacz` is an SPA route) and shows NotFound. Run
            // `npm run build && npm run preview` to see real generated club pages.
          },
        }
        : undefined),
    },
  }
})
