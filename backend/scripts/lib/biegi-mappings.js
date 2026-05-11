// Slug↔DB mappings for /biegi/* landing pages.
// Duplicated in public/src/lib/biegi-mappings.js — keep in sync.

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
  'przelajowe': 'trail running, biegi terenowe, biegi górskie, bieg w terenie',
  'uliczne': 'biegi miejskie, bieg po asfalcie, bieg uliczny',
  'ultramaratony': 'biegi ultra, ultramaraton, ultra trail, biegi długodystansowe',
  'nocne': 'bieg nocny, night run, nocny bieg uliczny',
  'ocr': 'biegi z przeszkodami, obstacle run, obstacle race',
  'nordic-walking': 'marsze nordic walking, NW',
  'charytatywne': 'charytatywny bieg, bieg na cel, bieg dobroczynny',
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
  'slaskie': 'w Śląskiem',
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
