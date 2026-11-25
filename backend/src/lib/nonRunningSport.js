// Snow sports, pumptrack and off-road motor events. Timing companies list them
// beside their runs, and most sources expose no discipline field, so only the
// words decide. Found on 2026-11-25: ZŁOTY GROŃ SKITUR ATAK 2026 (bgtimesport,
// "Puchar Polski w skialpinizmie"), 51. Bieg Piastów – Festiwal Narciarstwa
// Biegowego (datasport, active on the public calendar), LETNI CHALLENGE
// NARCIARSKI (zmierzymyczas, roller skis), Pumptrackowy Puchar Brennej and
// 15 Terenowa Integracja Dla Choinki Zamość, a 4x4 and quad rally (b4sport).
//
// "Bieg narciarski" is a ski race, not a run, so narciar- drops it whatever
// stands in front. The stems run to the end of the word because Polish
// declines them (Narciarstwa, Narciarskiej, skialpinizmie).
//
// JS \b treats Polish letters as non-word characters, so the start of a word
// is a lookbehind on a letter class instead. 4x4 and quad must end there too:
// "Quadrans" or a "4x400" relay is not a quad rally.
//
// biathlon is not here: looksMultisport() already drops it, in any form.
//
// "terenowa integracja" is the Zamość rally's own series name. Its name and
// its slug carry no other word that says off-road (the 4x4 is in the organizer
// segment, zamosc4x4, which b4sport deliberately does not read).
const START = '(?<![a-ząćęłńóśźż0-9])'
const END = '(?![a-ząćęłńóśźż0-9])'
const NON_RUNNING = new RegExp(
  START + '(?:' + [
    'ski[- ]?t(?:ou|u)r',
    'ski[- ]?alp',
    'skimo' + END,
    'skiroll',
    'nartoroll',
    'narciar',
    'snowboard',
    'pump[- ]?track',
    'off[- ]?road',
    '4x4' + END,
    'quad(?:y|ów|ach|om|ami)?' + END,
    'terenow[aey] integracj',
  ].join('|') + ')',
  'iu',
)

/** True when a name, or any of the extra texts, names one of these sports. */
export function looksNonRunningSport(...texts) {
  return texts.some(t => typeof t === 'string' && NON_RUNNING.test(t))
}
