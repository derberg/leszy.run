import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'dist')

const PAGES = [
  {
    slug: 'polityka-prywatnosci',
    title: 'Polityka prywatności — Leszy.run',
    description: 'Polityka prywatności serwisu Leszy.run — jak przetwarzamy Twoje dane osobowe zgodnie z RODO.',
    canonical: 'https://www.leszy.run/polityka-prywatnosci',
    lang: 'pl-PL',
  },
  {
    slug: 'privacy-policy',
    title: 'Privacy Policy — Leszy.run',
    description: 'Privacy Policy for Leszy.run — how we process your personal data under GDPR.',
    canonical: 'https://www.leszy.run/privacy-policy',
    lang: 'en',
  },
  {
    slug: 'regulamin',
    title: 'Regulamin serwisu — Leszy.run',
    description: 'Regulamin serwisu Leszy.run.',
    canonical: 'https://www.leszy.run/regulamin',
    lang: 'pl-PL',
  },
  {
    slug: 'podmioty-przetwarzajace',
    title: 'Podmioty przetwarzające — Leszy.run',
    description: 'Lista podmiotów współpracujących z Leszy.run w zakresie przetwarzania danych osobowych.',
    canonical: 'https://www.leszy.run/podmioty-przetwarzajace',
    lang: 'pl-PL',
  },
]

async function loadTemplate() {
  const indexHtml = await fs.readFile(path.join(distDir, 'index.html'), 'utf-8')
  return indexHtml
}

async function generate() {
  const template = await loadTemplate()

  for (const page of PAGES) {
    let html = template
      .replace(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`)
      .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${page.description}"`)
      .replace(/<html lang="[^"]*"/, `<html lang="${page.lang}"`)
      .replace(/<link rel="canonical"[^>]*>\s*/, '')
      .replace('</head>', `  <link rel="canonical" href="${page.canonical}" />\n  </head>`)

    const outDir = path.join(distDir, page.slug)
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(path.join(outDir, 'index.html'), html, 'utf-8')
    console.log(`  generated ${page.slug}/index.html`)
  }
}

generate().catch(err => {
  console.error('generate-legal-pages failed:', err)
  process.exit(1)
})
