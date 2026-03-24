// Polish postal code (first 2 digits) → voivodeship mapping
const POSTAL_TO_VOI = {
  '00': 'Mazowieckie', '01': 'Mazowieckie', '02': 'Mazowieckie', '03': 'Mazowieckie', '04': 'Mazowieckie',
  '05': 'Mazowieckie', '06': 'Mazowieckie', '07': 'Mazowieckie', '08': 'Mazowieckie', '09': 'Mazowieckie',
  '96': 'Mazowieckie',
  '10': 'Warmińsko-Mazurskie', '11': 'Warmińsko-Mazurskie', '12': 'Warmińsko-Mazurskie',
  '13': 'Warmińsko-Mazurskie', '14': 'Warmińsko-Mazurskie',
  '15': 'Podlaskie', '16': 'Podlaskie', '17': 'Podlaskie', '18': 'Podlaskie', '19': 'Podlaskie',
  '20': 'Lubelskie', '21': 'Lubelskie', '22': 'Lubelskie', '23': 'Lubelskie', '24': 'Lubelskie',
  '25': 'Świętokrzyskie', '26': 'Świętokrzyskie', '27': 'Świętokrzyskie',
  '28': 'Świętokrzyskie', '29': 'Świętokrzyskie',
  '30': 'Małopolskie', '31': 'Małopolskie', '32': 'Małopolskie', '33': 'Małopolskie', '34': 'Małopolskie',
  '35': 'Podkarpackie', '36': 'Podkarpackie', '37': 'Podkarpackie', '38': 'Podkarpackie', '39': 'Podkarpackie',
  '40': 'Śląskie', '41': 'Śląskie', '42': 'Śląskie', '43': 'Śląskie', '44': 'Śląskie',
  '45': 'Opolskie', '46': 'Opolskie', '47': 'Opolskie', '48': 'Opolskie', '49': 'Opolskie',
  '50': 'Dolnośląskie', '51': 'Dolnośląskie', '52': 'Dolnośląskie', '53': 'Dolnośląskie',
  '54': 'Dolnośląskie', '55': 'Dolnośląskie', '56': 'Dolnośląskie', '57': 'Dolnośląskie',
  '58': 'Dolnośląskie', '59': 'Dolnośląskie',
  '60': 'Wielkopolskie', '61': 'Wielkopolskie', '62': 'Wielkopolskie', '63': 'Wielkopolskie', '64': 'Wielkopolskie',
  '65': 'Lubuskie', '66': 'Lubuskie', '67': 'Lubuskie', '68': 'Lubuskie', '69': 'Lubuskie',
  '70': 'Zachodniopomorskie', '71': 'Zachodniopomorskie', '72': 'Zachodniopomorskie',
  '73': 'Zachodniopomorskie', '74': 'Zachodniopomorskie',
  '75': 'Kujawsko-Pomorskie', '76': 'Kujawsko-Pomorskie', '77': 'Kujawsko-Pomorskie',
  '78': 'Zachodniopomorskie',
  '80': 'Pomorskie', '81': 'Pomorskie', '82': 'Pomorskie', '83': 'Pomorskie', '84': 'Pomorskie',
  '85': 'Kujawsko-Pomorskie', '86': 'Kujawsko-Pomorskie', '87': 'Kujawsko-Pomorskie',
  '88': 'Kujawsko-Pomorskie', '89': 'Kujawsko-Pomorskie',
  '90': 'Łódzkie', '91': 'Łódzkie', '92': 'Łódzkie', '93': 'Łódzkie', '94': 'Łódzkie',
  '95': 'Łódzkie', '97': 'Łódzkie', '98': 'Łódzkie', '99': 'Łódzkie',
}

function voivodeshipFromPostalCode(text) {
  if (!text) return null
  // Match Polish postal code pattern: XX-XXX
  const match = text.match(/(\d{2})-\d{3}/)
  if (!match) return null
  return POSTAL_TO_VOI[match[1]] || null
}

function voivodeshipFromText(text) {
  if (!text) return null
  // Try postal code first
  const fromPostal = voivodeshipFromPostalCode(text)
  if (fromPostal) return fromPostal

  // Try direct voivodeship mentions
  const lower = text.toLowerCase()
  const voivodeships = [
    'mazowieckie', 'małopolskie', 'dolnośląskie', 'wielkopolskie', 'pomorskie',
    'śląskie', 'łódzkie', 'lubelskie', 'podlaskie', 'zachodniopomorskie',
    'warmińsko-mazurskie', 'kujawsko-pomorskie', 'podkarpackie', 'opolskie',
    'świętokrzyskie', 'lubuskie',
  ]
  for (const v of voivodeships) {
    if (lower.includes(v)) return v.replace(/(?:^|\s)\S/g, c => c.toUpperCase())
  }
  // Also check without Polish chars
  const voiAscii = [
    ['mazowieckie', 'Mazowieckie'], ['malopolskie', 'Małopolskie'],
    ['dolnoslaskie', 'Dolnośląskie'], ['wielkopolskie', 'Wielkopolskie'],
    ['pomorskie', 'Pomorskie'], ['slaskie', 'Śląskie'],
    ['lodzkie', 'Łódzkie'], ['lubelskie', 'Lubelskie'],
    ['podlaskie', 'Podlaskie'], ['zachodniopomorskie', 'Zachodniopomorskie'],
    ['warminsko-mazurskie', 'Warmińsko-Mazurskie'], ['kujawsko-pomorskie', 'Kujawsko-Pomorskie'],
    ['podkarpackie', 'Podkarpackie'], ['opolskie', 'Opolskie'],
    ['swietokrzyskie', 'Świętokrzyskie'], ['lubuskie', 'Lubuskie'],
  ]
  for (const [ascii, proper] of voiAscii) {
    if (lower.includes(ascii)) return proper
  }
  return null
}

export { voivodeshipFromPostalCode, voivodeshipFromText }
