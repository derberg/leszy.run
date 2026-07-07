// Playwright global setup: sweep test artifacts left behind by crashed or
// interrupted runs before the suite starts. Reuses the edge-function test
// helpers so both suites share one sweep implementation.
import { sweepTestData } from '../../../supabase/functions/tests/helpers.js'

export default async function globalSetup() {
  await sweepTestData()
  console.log('Test-data sweep complete')
}
