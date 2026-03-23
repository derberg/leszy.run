import { enrichDistances } from '../src/scrapers/llmEnricher.js'

const result = await enrichDistances()
console.log(JSON.stringify(result, null, 2))
