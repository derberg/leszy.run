// Count phrases for /listy/* copy. Polish takes the singular for 1, the "few" form for
// numbers ending in 2–4 (but not 12–14), and the genitive plural for everything else, so
// a single noun string cannot be right for every count: "10 listy w Lubelskiem",
// "11 biegi ocr" and "3 biegów" all shipped before this table existed.

const FORMS = {
  bieg: ['bieg', 'biegi', 'biegów'],
  wydarzenie: ['wydarzenie', 'wydarzenia', 'wydarzeń'],
  przelajowe: ['bieg przełajowy', 'biegi przełajowe', 'biegów przełajowych'],
  uliczne: ['bieg uliczny', 'biegi uliczne', 'biegów ulicznych'],
  ultramaratony: ['ultramaraton', 'ultramaratony', 'ultramaratonów'],
  nocne: ['bieg nocny', 'biegi nocne', 'biegów nocnych'],
  ocr: ['bieg OCR', 'biegi OCR', 'biegów OCR'],
  'nordic-walking': ['marsz nordic walking', 'marsze nordic walking', 'marszów nordic walking'],
  charytatywne: ['bieg charytatywny', 'biegi charytatywne', 'biegów charytatywnych'],
  polmaratony: ['półmaraton', 'półmaratony', 'półmaratonów'],
  maratony: ['maraton', 'maratony', 'maratonów'],
  'dla-dzieci': ['bieg dla dzieci', 'biegi dla dzieci', 'biegów dla dzieci'],
  darmowe: ['darmowy bieg', 'darmowe biegi', 'darmowych biegów'],
  'ostatnia-szansa': ['bieg z kończącymi się zapisami', 'biegi z kończącymi się zapisami', 'biegów z kończącymi się zapisami'],
}

/** @param {number} n @param {keyof FORMS} [noun='bieg'] */
export function countPhrase(n, noun = 'bieg') {
  const [one, few, many] = FORMS[noun] || FORMS.bieg
  if (n === 1) return `1 ${one}`
  const last = n % 10
  const lastTwo = n % 100
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return `${n} ${few}`
  return `${n} ${many}`
}
