// Slug↔DB mappings for /biegi/* landing pages.
// Duplicated in backend/scripts/lib/biegi-mappings.js — keep in sync.

export const TYPE_SLUG_TO_DB = {
  'przelajowe': 'trail',
  'uliczne': 'uliczny',
  'ultramaratony': 'ultra',
  'nocne': 'nocny',
  'ocr': 'ocr',
  'nordic-walking': 'nordic walking',
  'charytatywne': 'charytatywny',
}

export const DB_TO_TYPE_SLUG = {
  'trail': 'przelajowe',
  'uliczny': 'uliczne',
  'ultra': 'ultramaratony',
  'nocny': 'nocne',
  'ocr': 'ocr',
  'nordic walking': 'nordic-walking',
  'charytatywny': 'charytatywne',
}

export const TYPE_H1_NOUN = {
  'przelajowe': 'Biegi przełajowe',
  'uliczne': 'Biegi uliczne',
  'ultramaratony': 'Ultramaratony',
  'nocne': 'Biegi nocne',
  'ocr': 'Biegi OCR',
  'nordic-walking': 'Nordic Walking',
  'charytatywne': 'Biegi charytatywne',
}

export const TYPE_SECONDARY_KW = {
  'przelajowe': 'biegi przełajowe, bieg przełajowy, trail running, biegi terenowe, biegi górskie',
  'uliczne': 'biegi uliczne, bieg uliczny, biegi miejskie, bieg po asfalcie',
  'ultramaratony': 'ultramaratony, biegi ultra, ultramaraton, ultra trail, biegi długodystansowe',
  'nocne': 'biegi nocne, bieg nocny, night run, nocny bieg',
  'ocr': 'biegi OCR, obstacle run, biegi z przeszkodami, OCR race',
  'nordic-walking': 'nordic walking, marsze nordic walking, NW',
  'charytatywne': 'biegi charytatywne, charytatywny bieg, bieg na cel',
}

export const REGION_SLUG_TO_DB = {
  'dolnoslaskie': 'Dolnośląskie',
  'kujawsko-pomorskie': 'Kujawsko-Pomorskie',
  'lubelskie': 'Lubelskie',
  'lubuskie': 'Lubuskie',
  'lodzkie': 'Łódzkie',
  'malopolskie': 'Małopolskie',
  'mazowieckie': 'Mazowieckie',
  'opolskie': 'Opolskie',
  'podkarpackie': 'Podkarpackie',
  'podlaskie': 'Podlaskie',
  'pomorskie': 'Pomorskie',
  'slaskie': 'Śląskie',
  'swietokrzyskie': 'Świętokrzyskie',
  'warminsko-mazurskie': 'Warmińsko-Mazurskie',
  'wielkopolskie': 'Wielkopolskie',
  'zachodniopomorskie': 'Zachodniopomorskie',
}

export const DB_TO_REGION_SLUG = {
  'Dolnośląskie': 'dolnoslaskie',
  'Kujawsko-Pomorskie': 'kujawsko-pomorskie',
  'Lubelskie': 'lubelskie',
  'Lubuskie': 'lubuskie',
  'Łódzkie': 'lodzkie',
  'Małopolskie': 'malopolskie',
  'Mazowieckie': 'mazowieckie',
  'Opolskie': 'opolskie',
  'Podkarpackie': 'podkarpackie',
  'Podlaskie': 'podlaskie',
  'Pomorskie': 'pomorskie',
  'Śląskie': 'slaskie',
  'Świętokrzyskie': 'swietokrzyskie',
  'Warmińsko-Mazurskie': 'warminsko-mazurskie',
  'Wielkopolskie': 'wielkopolskie',
  'Zachodniopomorskie': 'zachodniopomorskie',
}

export const REGION_LOCATIVE = {
  'dolnoslaskie': 'w Dolnośląskiem',
  'kujawsko-pomorskie': 'w Kujawsko-Pomorskiem',
  'lubelskie': 'w Lubelskiem',
  'lubuskie': 'w Lubuskiem',
  'lodzkie': 'w Łódzkiem',
  'malopolskie': 'w Małopolsce',
  'mazowieckie': 'na Mazowszu',
  'opolskie': 'w Opolskiem',
  'podkarpackie': 'na Podkarpaciu',
  'podlaskie': 'na Podlasiu',
  'pomorskie': 'na Pomorzu',
  'slaskie': 'na Śląsku',
  'swietokrzyskie': 'w Świętokrzyskiem',
  'warminsko-mazurskie': 'na Warmii i Mazurach',
  'wielkopolskie': 'w Wielkopolsce',
  'zachodniopomorskie': 'w Zachodniopomorskiem',
}

export const MONTH_SLUG_TO_NUM = {
  'styczen': 1, 'luty': 2, 'marzec': 3, 'kwiecien': 4,
  'maj': 5, 'czerwiec': 6, 'lipiec': 7, 'sierpien': 8,
  'wrzesien': 9, 'pazdziernik': 10, 'listopad': 11, 'grudzien': 12,
}

export const MONTH_NUM_TO_SLUG = {
  1: 'styczen', 2: 'luty', 3: 'marzec', 4: 'kwiecien',
  5: 'maj', 6: 'czerwiec', 7: 'lipiec', 8: 'sierpien',
  9: 'wrzesien', 10: 'pazdziernik', 11: 'listopad', 12: 'grudzien',
}

export const MONTH_LOCATIVE = {
  1: 'w styczniu', 2: 'w lutym', 3: 'w marcu', 4: 'w kwietniu',
  5: 'w maju', 6: 'w czerwcu', 7: 'w lipcu', 8: 'w sierpniu',
  9: 'we wrześniu', 10: 'w październiku', 11: 'w listopadzie', 12: 'w grudniu',
}

export const SPECIAL_SLUGS = ['polmaratony', 'maratony', 'dla-dzieci', 'darmowe']

export const SPECIAL_H1 = {
  'polmaratony': 'Półmaratony w Polsce',
  'maratony': 'Maratony w Polsce',
  'dla-dzieci': 'Biegi dla dzieci w Polsce',
  'darmowe': 'Darmowe biegi w Polsce',
}

export const SPECIAL_SECONDARY_KW = {
  'polmaratony': 'bieg na 21 km, półmaraton, half marathon',
  'maratony': 'bieg na 42 km, maraton, marathon polska',
  'dla-dzieci': 'biegi rodzinne, bieg dla dzieci, biegi juniorów',
  'darmowe': 'bezpłatne biegi, darmowy bieg, biegi za darmo',
}

export const REGION_CENTER = {
  'dolnoslaskie':       { lat: 51.10, lng: 16.90, zoom: 8 },
  'kujawsko-pomorskie': { lat: 53.10, lng: 18.50, zoom: 8 },
  'lubelskie':          { lat: 51.25, lng: 23.10, zoom: 8 },
  'lubuskie':           { lat: 52.20, lng: 15.20, zoom: 8 },
  'lodzkie':            { lat: 51.75, lng: 19.50, zoom: 8 },
  'malopolskie':        { lat: 49.90, lng: 20.50, zoom: 8 },
  'mazowieckie':        { lat: 52.20, lng: 21.00, zoom: 8 },
  'opolskie':           { lat: 50.70, lng: 17.90, zoom: 9 },
  'podkarpackie':       { lat: 50.10, lng: 22.30, zoom: 8 },
  'podlaskie':          { lat: 53.10, lng: 23.10, zoom: 8 },
  'pomorskie':          { lat: 54.20, lng: 18.20, zoom: 8 },
  'slaskie':            { lat: 50.30, lng: 19.00, zoom: 9 },
  'swietokrzyskie':     { lat: 50.80, lng: 20.90, zoom: 9 },
  'warminsko-mazurskie':{ lat: 53.90, lng: 21.00, zoom: 8 },
  'wielkopolskie':      { lat: 52.40, lng: 17.60, zoom: 8 },
  'zachodniopomorskie': { lat: 53.40, lng: 15.50, zoom: 8 },
}

export function slugifyCity(city) {
  return city.toLowerCase()
    .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e')
    .replace(/ł/g, 'l').replace(/ń/g, 'n').replace(/ó/g, 'o')
    .replace(/ś/g, 's').replace(/ź/g, 'z').replace(/ż/g, 'z')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}
