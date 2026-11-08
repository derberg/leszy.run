// Fails when PR_TITLE is not a Conventional Commits title. Run by
// .github/workflows/pr-title.yml; plain Node, no dependencies.
import { isConventionalTitle, CONVENTIONAL_TYPES } from './lib/conventionalTitle.js'

const title = process.env.PR_TITLE ?? ''
if (isConventionalTitle(title)) {
  console.log(`OK: ${title}`)
} else {
  console.error(`Pull request title is not a Conventional Commits title: "${title}"`)
  console.error(`Expected "<type>(<scope>)?: <description>", type one of: ${CONVENTIONAL_TYPES.join(', ')}`)
  console.error('Example: "fix(scrapers): read the archive page of biegnijmy.pl"')
  process.exit(1)
}
