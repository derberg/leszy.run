// Standalone pre-test sweep: removes test artifacts left behind by crashed or
// interrupted runs (test profiles, marker-tagged reports/feedback, source='test'
// events). Runs before the node:test suite (see public/package.json) and before
// Playwright e2e (see public/tests/e2e/global-setup.js).
import { sweepTestData } from './helpers.js'

await sweepTestData()
console.log('Test-data sweep complete')
