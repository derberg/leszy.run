// Nationality on the registration form (P2-R31): an ISO 3166-1 alpha-2 code.
// Plain ESM: the edge function checks the code, the browser builds the select.
// Names are never typed here: countryOptions() asks Intl.DisplayNames.

// ISO 3166-1 alpha-2, all 249 officially assigned codes.
export const COUNTRY_CODES = Object.freeze(`
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS
MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS
RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW
TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/))

const CODES = new Set(COUNTRY_CODES)

/** True for an upper-case ISO 3166-1 alpha-2 code from the list. */
export function isCountryCode(v) {
  return typeof v === 'string' && CODES.has(v)
}

/**
 * The select's options: [{ code, name }], Polska first, then the rest by
 * Polish name.
 */
export function countryOptions(locale = 'pl') {
  const names = new Intl.DisplayNames([locale], { type: 'region' })
  const collator = new Intl.Collator(locale)
  const rest = COUNTRY_CODES.filter((c) => c !== 'PL')
    .map((code) => ({ code, name: names.of(code) }))
    .sort((a, b) => collator.compare(a.name, b.name))
  return [{ code: 'PL', name: names.of('PL') }, ...rest]
}
