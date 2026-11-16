import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseListing, parseDetail, isLoaderPage } from '../src/scrapers/sources/zapisyvaldano.js'

// One card of https://zapisyvaldano.pl/events as served on 2026-11-16, svg icons
// and Tailwind classes trimmed. Since the redesign the card shows only the day
// and a month abbreviation, with no year, and the town sits in span.truncate.
const LISTING = `<div class="group relative bg-white">
  <div class="p-6 flex">
    <div class="flex sm:flex-col items-center">
      <span class="text-2xl sm:text-3xl font-black tracking-tight leading-none">
          13
      </span>
      <span class="text-xs sm:text-sm font-bold uppercase tracking-wider ml-2 sm:ml-0 sm:mt-1">
          gru
      </span>
    </div>
    <div class="flex-1 min-w-0 space-y-2">
      <h2 class="font-bold text-xl">
        <a href="https://zapisyvaldano.pl/event/81" class="after:absolute after:inset-0">
            XIV JESIENNY RAJD NORDIC WALKING W KRAINIE KORMORANÓW
        </a>
      </h2>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span class="inline-flex items-center gap-1.5">10:00 - 14:00</span>
        <span class="hidden sm:inline text-gray-300">•</span>
        <span class="inline-flex items-center gap-1.5 max-w-xs sm:max-w-md">
          <span class="truncate">Sztutowo, Ośrodek Bursztynowo</span>
        </span>
      </div>
    </div>
  </div>
  <div class="relative z-10 flex">
    <a href="https://zapisyvaldano.pl/event/81/participants">Uczestnicy</a>
    <a href="https://zapisyvaldano.pl/event/81/register">Zapisz się</a>
  </div>
</div>`

// The "Informacje", "Cennik" and "Regulamin" blocks of /event/81 on 2026-11-16.
const DETAIL = `<div>
  <span class="block text-sm text-gray-500 dark:text-gray-400">Miejsce</span>
  <span class="text-gray-800 dark:text-gray-200">Sztutowo, Ośrodek Bursztynowo</span>
</div>
<div>
  <span class="block text-sm text-gray-500 dark:text-gray-400">Początek wydarzenia</span>
  <span class="text-gray-800 dark:text-gray-200">13.12.2026 10:00</span>
</div>
<div>
  <span class="block text-sm text-gray-500 dark:text-gray-400">Zamknięcie zapisów</span>
  <span class="text-gray-800 dark:text-gray-200">10.12.2026 22:00</span>
</div>
<div class="flex flex-col gap-3">
  <div class="flex justify-between"><span class="text-gray-800 dark:text-gray-200">Bieg</span><span class="text-rose-600 dark:text-rose-400 font-semibold whitespace-nowrap">70 zł</span></div>
  <div class="flex justify-between"><span class="text-gray-800 dark:text-gray-200">Nordic Walking</span><span class="text-rose-600 dark:text-rose-400 font-semibold whitespace-nowrap">70 zł</span></div>
  <div class="flex justify-between"><span class="text-gray-800 dark:text-gray-200">Power Walk</span><span class="text-rose-600 dark:text-rose-400 font-semibold whitespace-nowrap">70 zł</span></div>
</div>
<a href="https://zapisyvaldano.pl/event/81/rules/1?t=1794836832" class="flex"><span class="hover:underline">Regulamin</span></a>`

const LOADER = `<!DOCTYPE html><html lang="en"><head><meta charset="utf8">
<script nonce="x">(function(){ setTimeout(function(){ window.location.reload(); }, 5000); }())</script>
<title>One moment, please...</title></head><body><div class="spinner"></div></body></html>`

test('a redesigned listing card still yields the event, with the town before the comma', () => {
  assert.deepEqual(parseListing(LISTING), [
    { sourceId: '81', name: 'XIV JESIENNY RAJD NORDIC WALKING W KRAINIE KORMORANÓW', date: null, location: 'Sztutowo' },
  ])
})

test('the detail page gives the full start date the card no longer shows', () => {
  const d = parseDetail(DETAIL)
  assert.equal(d.startDate, '2026-12-13')
  assert.equal(d.registrationDeadline, '2026-12-10')
  assert.equal(d.priceFrom, 70)
  assert.equal(d.priceTo, 70)
  assert.equal(d.regulaminUrl, 'https://zapisyvaldano.pl/event/81/rules/1')
  assert.deepEqual(d.competitionNames, ['Bieg', 'Nordic Walking', 'Power Walk'])
})

test('the "One moment, please" loader is recognised, a real page is not', () => {
  assert.equal(isLoaderPage(LOADER), true)
  assert.equal(isLoaderPage(LISTING), false)
})
