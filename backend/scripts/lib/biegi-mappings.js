// Slug↔DB mappings for /biegi/* landing pages.
// Duplicated in public/src/lib/biegi-mappings.js — keep in sync.

export const TYPE_SLUG_TO_DB = {
  'przełajowe': 'trail',
  'uliczne': 'uliczny',
  'ultramaratony': 'ultra',
  'nocne': 'nocny',
  'ocr': 'ocr',
  'nordic-walking': 'nordic walking',
  'charytatywne': 'charytatywny',
}

export const DB_TO_TYPE_SLUG = {
  'trail': 'przełajowe',
  'uliczny': 'uliczne',
  'ultra': 'ultramaratony',
  'nocny': 'nocne',
  'ocr': 'ocr',
  'nordic walking': 'nordic-walking',
  'charytatywny': 'charytatywne',
}

export const TYPE_H1_NOUN = {
  'przełajowe': 'Biegi przełajowe',
  'uliczne': 'Biegi uliczne',
  'ultramaratony': 'Ultramaratony',
  'nocne': 'Biegi nocne',
  'ocr': 'Biegi OCR',
  'nordic-walking': 'Nordic Walking',
  'charytatywne': 'Biegi charytatywne',
}

export const TYPE_SECONDARY_KW = {
  'przełajowe': 'biegi przełajowe, bieg przełajowy, trail running, biegi terenowe, biegi górskie',
  'uliczne': 'biegi uliczne, bieg uliczny, biegi miejskie, bieg po asfalcie',
  'ultramaratony': 'ultramaratony, biegi ultra, ultramaraton, ultra trail, biegi długodystansowe',
  'nocne': 'biegi nocne, bieg nocny, night run, nocny bieg',
  'ocr': 'biegi OCR, obstacle run, biegi z przeszkodami, OCR race',
  'nordic-walking': 'nordic walking, marsze nordic walking, NW',
  'charytatywne': 'biegi charytatywne, charytatywny bieg, bieg na cel',
}

export const REGION_SLUG_TO_DB = {
  'dolnośląskie': 'Dolnośląskie',
  'kujawsko-pomorskie': 'Kujawsko-Pomorskie',
  'lubelskie': 'Lubelskie',
  'lubuskie': 'Lubuskie',
  'łódzkie': 'Łódzkie',
  'małopolskie': 'Małopolskie',
  'mazowieckie': 'Mazowieckie',
  'opolskie': 'Opolskie',
  'podkarpackie': 'Podkarpackie',
  'podlaskie': 'Podlaskie',
  'pomorskie': 'Pomorskie',
  'śląskie': 'Śląskie',
  'świętokrzyskie': 'Świętokrzyskie',
  'warmińsko-mazurskie': 'Warmińsko-Mazurskie',
  'wielkopolskie': 'Wielkopolskie',
  'zachodniopomorskie': 'Zachodniopomorskie',
}

export const DB_TO_REGION_SLUG = {
  'Dolnośląskie': 'dolnośląskie',
  'Kujawsko-Pomorskie': 'kujawsko-pomorskie',
  'Lubelskie': 'lubelskie',
  'Lubuskie': 'lubuskie',
  'Łódzkie': 'łódzkie',
  'Małopolskie': 'małopolskie',
  'Mazowieckie': 'mazowieckie',
  'Opolskie': 'opolskie',
  'Podkarpackie': 'podkarpackie',
  'Podlaskie': 'podlaskie',
  'Pomorskie': 'pomorskie',
  'Śląskie': 'śląskie',
  'Świętokrzyskie': 'świętokrzyskie',
  'Warmińsko-Mazurskie': 'warmińsko-mazurskie',
  'Wielkopolskie': 'wielkopolskie',
  'Zachodniopomorskie': 'zachodniopomorskie',
}

export const REGION_LOCATIVE = {
  'dolnośląskie': 'w Dolnośląskiem',
  'kujawsko-pomorskie': 'w Kujawsko-Pomorskiem',
  'lubelskie': 'w Lubelskiem',
  'lubuskie': 'w Lubuskiem',
  'łódzkie': 'w Łódzkiem',
  'małopolskie': 'w Małopolsce',
  'mazowieckie': 'na Mazowszu',
  'opolskie': 'w Opolskiem',
  'podkarpackie': 'na Podkarpaciu',
  'podlaskie': 'na Podlasiu',
  'pomorskie': 'na Pomorzu',
  'śląskie': 'w Śląskiem',
  'świętokrzyskie': 'w Świętokrzyskiem',
  'warmińsko-mazurskie': 'na Warmii i Mazurach',
  'wielkopolskie': 'w Wielkopolsce',
  'zachodniopomorskie': 'w Zachodniopomorskiem',
}

export const MONTH_SLUG_TO_NUM = {
  'styczeń': 1, 'luty': 2, 'marzec': 3, 'kwiecień': 4,
  'maj': 5, 'czerwiec': 6, 'lipiec': 7, 'sierpień': 8,
  'wrzesień': 9, 'październik': 10, 'listopad': 11, 'grudzień': 12,
}

export const MONTH_NUM_TO_SLUG = {
  1: 'styczeń', 2: 'luty', 3: 'marzec', 4: 'kwiecień',
  5: 'maj', 6: 'czerwiec', 7: 'lipiec', 8: 'sierpień',
  9: 'wrzesień', 10: 'październik', 11: 'listopad', 12: 'grudzień',
}

export const MONTH_LOCATIVE = {
  1: 'w styczniu', 2: 'w lutym', 3: 'w marcu', 4: 'w kwietniu',
  5: 'w maju', 6: 'w czerwcu', 7: 'w lipcu', 8: 'w sierpniu',
  9: 'we wrześniu', 10: 'w październiku', 11: 'w listopadzie', 12: 'w grudniu',
}

export const SPECIAL_SLUGS = ['półmaratony', 'maratony', 'dla-dzieci', 'darmowe']

export const SPECIAL_H1 = {
  'półmaratony': 'Półmaratony w Polsce',
  'maratony': 'Maratony w Polsce',
  'dla-dzieci': 'Biegi dla dzieci w Polsce',
  'darmowe': 'Darmowe biegi w Polsce',
}

export const SPECIAL_SECONDARY_KW = {
  'półmaratony': 'bieg na 21 km, półmaraton, half marathon',
  'maratony': 'bieg na 42 km, maraton, marathon polska',
  'dla-dzieci': 'biegi rodzinne, bieg dla dzieci, biegi juniorów',
  'darmowe': 'bezpłatne biegi, darmowy bieg, biegi za darmo',
}

export const REGION_CENTER = {
  'dolnośląskie':       { lat: 51.10, lng: 16.90, zoom: 8 },
  'kujawsko-pomorskie': { lat: 53.10, lng: 18.50, zoom: 8 },
  'lubelskie':          { lat: 51.25, lng: 23.10, zoom: 8 },
  'lubuskie':           { lat: 52.20, lng: 15.20, zoom: 8 },
  'łódzkie':            { lat: 51.75, lng: 19.50, zoom: 8 },
  'małopolskie':        { lat: 49.90, lng: 20.50, zoom: 8 },
  'mazowieckie':        { lat: 52.20, lng: 21.00, zoom: 8 },
  'opolskie':           { lat: 50.70, lng: 17.90, zoom: 9 },
  'podkarpackie':       { lat: 50.10, lng: 22.30, zoom: 8 },
  'podlaskie':          { lat: 53.10, lng: 23.10, zoom: 8 },
  'pomorskie':          { lat: 54.20, lng: 18.20, zoom: 8 },
  'śląskie':            { lat: 50.30, lng: 19.00, zoom: 9 },
  'świętokrzyskie':     { lat: 50.80, lng: 20.90, zoom: 9 },
  'warmińsko-mazurskie':{ lat: 53.90, lng: 21.00, zoom: 8 },
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
