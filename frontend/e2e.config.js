// Agentic e2e tests for the admin panel (spike). See frontend/e2e/README.md.
//
// The app is the isolated stack from frontend/e2e/stack.sh (backend :3071 on a
// throwaway Postgres, admin UI :3072). Agent steps run on Claude Code through
// the Agent Client Protocol, signed in with the operator's own `claude` login,
// so no API key is configured here.
import { web } from '@e2e-dev/web'
import { claudeCode } from '@e2e-dev/acp'

/** @type {import('e2e').E2EConfig} */
export default {
  tests: 'e2e/**/*.e2e.js',
  targets: [
    {
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: { url: process.env.ADMIN_E2E_URL ?? 'http://localhost:3072' },
    },
  ],
  agents: {
    default: {
      executor: claudeCode({ model: 'sonnet' }),
      context: [
        'This is the LESZY.RUN admin panel for race timing. The UI is in Polish.',
        'Runners are identified by bib number („nr”, „#12”). „Nie startuje” means the runner',
        'handed the bib back and will not start. „Przegląd trasy” is the live results view.',
      ].join(' '),
    },
  },
  timeout: 180_000,
  workers: 1,
  video: 'retain-on-failure',
}
