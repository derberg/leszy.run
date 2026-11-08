// Pull request titles follow Conventional Commits (https://www.conventionalcommits.org).
// Every pull request is squash-merged, so its title becomes the commit subject on
// main. This one rule serves the CI check (scripts/check-pr-title.js, run by
// .github/workflows/pr-title.yml) and the pre-publish review, which merges its
// own pull requests without waiting for CI.

export const CONVENTIONAL_TYPES = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
]

const PATTERN = new RegExp(`^(${CONVENTIONAL_TYPES.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`)

export function isConventionalTitle(title) {
  return typeof title === 'string' && PATTERN.test(title.trim())
}

// A title an agent wrote without a type. The pre-publish fix agents only fix
// defects, so the missing type is `fix`.
export function asConventionalTitle(title, type = 'fix') {
  const t = String(title ?? '').trim()
  return isConventionalTitle(t) ? t : `${type}: ${t}`
}
