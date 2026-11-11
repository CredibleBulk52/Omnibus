import React from 'react';

// The drawings occupy the space between the tier stars and the ribbon.
// Each layer is a spot colour and its inked silhouette, back to front.
const cream = '#fff1ba', blue = '#5297ad', red = '#d65350', gold = '#efb951', ink = '#222336';
const scenes = {
  cabinet: [[red,'M9 7 H71 V56 H9Z'],[ink,'M14 12 H66 V49 H14Z'],[gold,'M20 24 H34 L31 34 L28 37 V41 H33 V45 H20 V41 H25 V37 L22 34Z M42 17 H60 L57 29 L53 33 V40 H59 V44 H43 V40 H49 V33 L45 29Z'],[cream,'M14 49 H66 V53 H14Z']],
  laurels: [[blue,'M17 45 L28 36 L43 48 L55 36 L68 46 L59 59 L43 52 L29 58Z'],[gold,'M13 19 Q12 40 36 48 Q14 49 9 32 L14 34 Q9 25 13 19Z M68 17 Q72 38 48 48 Q67 49 73 30 L67 34 Q73 23 68 17Z'],[gold,'M41 6 L47 19 L62 20 L50 30 L53 45 L40 37 L28 44 L30 30 L19 20 L35 18Z'],[cream,'M39 17 L42 12 L44 20 L39 30Z']],
  admission: [
    [blue,'M9 23 L64 19 L66 50 L11 54Z'],
    [red,'M9 26 L61 11 L70 42 L18 57Z'],
    [gold,'M3 19 L64 3 L67 13 Q61 17 70 21 L73 32 L12 49 L9 39 Q16 35 6 30Z'],
    [ink,'M55 9 l2 5 M58 20 l2 5 M61 30 l1 4'],
  ],
  longbox: [
    [gold,'M7 25 L44 9 L68 17 L31 35Z'],
    [ink,'M13 25 L44 13 L61 18 L30 30Z'],
    ['#bf8154','M31 33 L67 17 V40 L31 58Z'],
    [cream,'M7 25 L31 33 V58 L7 49Z'],
    [gold,'M31 33 L67 17 L77 23 L42 40Z'],
    [ink,'M13 35 L24 39 V43 L13 39Z M40 31 l6 -3 M49 27 l6 -3 M58 23 l5 -2'],
  ],
  reviewClipping: [
    [blue,'M12 13 L61 6 L68 49 L18 55Z'],
    [cream,'M18 8 L66 14 L61 55 L54 51 L48 55 L42 50 L35 53 L29 48 L22 50 L14 47Z'],
    [red,'M22 14 L59 19 L58 23 L21 18Z'],
    [ink,'M37 21 L40 30 L51 32 L42 37 L43 47 L35 41 L26 45 L29 35 L21 29 L32 29Z M48 40 l9 1 M48 45 l7 1'],
  ],
  thumbs: [
    [gold,'M6 32 L15 28 Q22 20 23 12 Q26 8 29 12 Q32 16 28 25 L37 24 Q42 25 40 31 L36 43 Q35 47 29 47 L12 46Z'],
    [blue,'M5 32 L13 29 L18 47 L9 51Z'],
    [cream,'M39 34 L47 30 Q54 21 55 11 Q58 6 62 11 Q65 16 60 26 L69 25 Q75 25 73 32 L69 46 Q68 51 61 51 L46 49Z'],
    [red,'M38 34 L46 30 L51 51 L42 54Z'],
  ],
  mangaSpread: [
    [ink,'M4 15 Q22 9 39 18 Q58 9 73 13 L74 51 Q56 49 40 57 Q22 51 5 53Z'],
    ['#faf9f1','M6 13 Q23 8 39 17 V52 Q24 46 7 49Z M40 17 Q56 10 71 12 L72 47 Q55 46 40 52Z'],
    [ink,'M45 20 L66 16 L66 30 L44 33Z M44 38 L65 34 L53 43 L44 45Z'],
    ['#faf9f1','M48 26 Q55 18 62 23 Q56 30 48 26Z'],
    [ink,'M54 24 A2 2 0 1 0 58 24 A2 2 0 1 0 54 24Z'],
    ['#d3d4d6','M8 46 Q17 30 23 11 Q30 11 39 17 Q35 33 28 46 Q19 40 8 46Z'],
    [ink,'M23 21 L32 18 L24 33Z'],
  ],
  newsstand: [[red,'M8 24 L17 8 H65 L74 24Z'],[cream,'M17 24 H66 V56 H17Z'],[blue,'M21 29 H38 V48 H21Z M44 29 H61 V48 H44Z'],[gold,'M9 51 H73 V59 H9Z'],[cream,'M21 12 H28 L24 23 H15Z M43 12 H50 L49 23 H40Z']],
  rocket: [[blue,'M9 51 Q15 27 36 35 Q52 38 64 57Z'],[red,'M34 25 L18 32 L19 40 L33 35 L41 48 L48 42 L47 29Z'],[cream,'M27 36 Q35 11 63 5 Q62 28 38 41Z'],[blue,'M43 21 A5 5 0 1 0 53 21 A5 5 0 1 0 43 21Z'],[gold,'M28 38 L16 53 L34 44Z']],
  rooftops: [[gold,'M45 16 A10 10 0 1 0 65 16 A10 10 0 1 0 45 16Z'],[blue,'M6 56 V34 H19 V18 H32 V39 H47 V30 H65 V56Z'],[ink,'M23 34 L30 24 L38 26 L43 18 L50 23 L43 36 L31 48 L17 53Z'],[cream,'M10 39 H15 V45 H10Z M51 36 H58 V41 H51Z']],
  panels: [[blue,'M7 12 L67 5 L74 51 L14 58Z'],[cream,'M12 17 L37 14 L30 48 L17 51Z'],[red,'M43 13 L63 11 L66 29 L39 32Z'],[gold,'M38 37 L67 33 L69 46 L35 50Z'],[ink,'M16 42 L22 25 L26 31 L33 22 L27 42Z']],
  trophy: [[blue,'M10 54 H70 L64 60 H16Z'],[gold,'M23 10 H59 L55 28 Q52 38 44 40 V47 H55 V53 H27 V47 H37 V40 Q27 36 25 26Z'],[gold,'M23 15 H11 Q11 32 28 33 L26 27 Q18 26 18 20 H24Z M58 15 H70 Q70 32 54 33 L56 27 Q63 26 64 20 H57Z'],[cream,'M31 15 H36 L38 29 L34 25Z']],
  cinema: [[red,'M9 12 H70 V49 H9Z'],[cream,'M15 18 H64 V40 H15Z'],[blue,'M17 38 L30 24 L39 31 L49 21 L62 38Z'],[ink,'M7 59 V51 Q13 40 22 51 Q28 40 37 51 Q44 40 52 51 Q60 40 69 51 L72 59Z']],
  splitEarth: [[blue,'M41 7 A23 23 0 0 0 25 51 L36 35 L30 28Z'],[red,'M50 10 A23 23 0 0 1 37 55 L49 34 L41 28Z'],[gold,'M44 4 L34 28 L42 33 L32 57 L53 29 L45 25 L53 5Z']],
  press: [[blue,'M9 15 L55 8 L62 46 L17 54Z'],[cream,'M22 19 L66 14 L71 51 L27 57Z'],[red,'M28 24 L59 20 L60 28 L29 32Z'],[ink,'M31 37 L41 35 L43 47 L32 49Z M46 36 L62 33 L63 37 L47 40Z M48 44 L62 41 L63 44 L48 47Z']],
  nib: [[red,'M8 47 Q18 39 29 46 T47 46 Q52 45 56 49 Q46 58 33 52 T10 55Z'],[gold,'M29 45 L35 23 L51 15 L62 26 L50 41Z'],[blue,'M50 14 L63 4 L74 16 L62 27Z'],[ink,'M30 45 L42 29 L45 32Z']],
  projector: [[red,'M9 22 H47 V45 H9Z'],[blue,'M12 16 A9 9 0 1 0 30 16 A9 9 0 1 0 12 16Z M31 15 A8 8 0 1 0 47 15 A8 8 0 1 0 31 15Z'],[gold,'M49 30 L73 18 V52 L49 37Z'],[ink,'M22 45 H29 L24 57 H16Z M33 45 H39 L46 57 H38Z']],
  courier: [[blue,'M6 18 H46 V44 H6Z'],[red,'M46 26 H60 L72 37 V45 H46Z'],[cream,'M50 29 H58 L65 36 H50Z M12 24 H37 V30 H12Z'],[ink,'M15 45 A7 7 0 1 0 29 45 A7 7 0 1 0 15 45Z M51 45 A7 7 0 1 0 65 45 A7 7 0 1 0 51 45Z']],
  candle: [[blue,'M13 50 Q30 39 40 47 Q50 38 69 45 L64 56 Q50 50 40 57 Q28 52 17 57Z'],[cream,'M33 26 H48 V47 H33Z'],[gold,'M39 27 Q28 20 42 4 Q41 13 47 17 Q50 23 43 27Z'],[red,'M33 26 H48 V34 L44 37 L42 31 L39 34 L37 30 H33Z']],
  calendar: [[blue,'M10 17 L63 11 L70 51 L17 58Z'],[cream,'M15 16 H65 V50 H15Z'],[red,'M15 15 H65 V25 H15Z'],[ink,'M24 8 H28 V20 H24Z M51 8 H55 V20 H51Z'],[blue,'M23 32 H30 V38 H23Z M34 32 H41 V38 H34Z'],[gold,'M42 39 L48 42 L59 29 L62 34 L49 48Z']],
  armchair: [[blue,'M20 26 Q15 7 32 9 H51 Q63 8 60 27 L55 42 H24Z'],[red,'M10 29 Q11 22 18 25 L25 36 H55 L61 25 Q71 20 72 31 L66 51 H15Z'],[cream,'M25 20 L36 18 L43 25 L51 18 L59 20 L54 32 L43 35 L29 30Z'],[ink,'M18 50 H24 V57 H17Z M57 50 H63 L65 57 H58Z']],
  envelope: [[blue,'M9 23 L62 13 L70 48 L17 57Z'],[cream,'M13 23 L38 37 L62 15Z'],[red,'M28 17 L32 5 L49 9 L46 22Z'],[gold,'M51 32 L55 28 L62 32 L59 40 L52 40Z']],
  repair: [[red,'M14 11 L49 6 L57 53 L21 58Z'],[cream,'M20 16 L43 13 L44 21 L21 25Z'],[blue,'M33 49 L49 29 Q44 17 57 13 L55 22 L62 25 L69 18 Q72 31 58 35 L41 54Z']],
  dialogue: [[blue,'M8 9 H53 V32 H27 L14 41 V32 H8Z'],[cream,'M26 24 H71 V47 H61 L65 57 L50 47 H26Z'],[red,'M34 30 H62 V34 H34Z M34 38 H53 V41 H34Z']],
  grass: [[gold,'M42 17 A11 11 0 1 0 64 17 A11 11 0 1 0 42 17Z'],[blue,'M6 54 L24 28 L37 44 L47 31 L72 54Z'],['#679b67','M9 54 L6 37 L21 48 L18 30 L35 51 L45 37 L44 49 L65 39 L56 55Z']],
  passport: [[red,'M15 11 L54 6 L60 50 L21 57Z'],[blue,'M22 15 L64 10 L69 51 L28 56Z'],[cream,'M32 23 L55 20 L56 25 L33 28Z'],[gold,'M38 37 A7 7 0 1 0 52 37 A7 7 0 1 0 38 37Z']],
  ticket: [[cream,'M5 24 L65 8 L68 17 Q62 22 71 26 L74 39 L13 56 L10 46 Q16 40 8 37Z'],[red,'M53 14 L60 12 L67 38 L60 40Z']],
};

const families = {
  award:'trophy', adapted:'projector', acclaimed:'reviewClipping', crisis:'splitEarth', major:'rooftops',
  arc:'panels', essential:'press', series:'panels', firsts:'press', specials:'ticket',
  annuals:'calendar', long:'grass', pulls:'newsstand', eisner:'trophy', new_releases:'courier',
  streak_days:'candle', streak_weeks:'calendar',
};
const editions = {
  award_5:'cabinet', award_10:'laurels', acclaimed_10:'thumbs', acclaimed_25:'laurels', adapted_5:'cinema', adapted_10:'admission',
  new_releases_10:'newsstand', new_releases_25:'press', pulls_10:'ticket', pulls_20:'courier',
  age_golden:'newsstand', age_silver:'rocket', age_bronze:'rooftops', age_modern:'panels', age_all:'projector',
  triple_feature:'cinema', every_tie_in:'panels', essential_all:'press', full_omnibus:'panels', auteur:'nib',
  list_10:'press', caught_up:'calendar', box_builder:'longbox', list_maker:'nib', trendsetter:'dialogue',
  libraries_5:'ticket', libraries_all:'passport', genres_10:'panels', indie_25:'nib', manga_3:'mangaSpread',
  one_sitting:'candle', weekend_binge:'armchair', first_finish:'trophy', special_order:'envelope',
  no_prize:'repair', previously_on:'dialogue', touched_grass:'grass', called_in_sick:'armchair',
  creature_of_the_night:'rooftops', day_one:'courier', free_comic_book_day:'newsstand',
  shopkeepers_advice:'newsstand', event_fatigue:'splitEarth', spoiler_alert:'cinema',
};
const numberTickets = {minus_one:'−1', zero_hour:'0', one_million:'1M', point_one:'.1', centennial:'100', legacy_number:'500', who_starts_at_37:'37'};

export function readerBadgeArt(item) {
  const number = numberTickets[item.id];
  const family = item.id?.replace(/_\d+$/, '');
  const library = item.group === 'libraries' && item.library;
  const scene = library ? 'passport' : number ? 'ticket' : editions[item.id] || families[family];
  if (!scenes[scene]) return null;
  return (
    <g transform="translate(20 19)" stroke={ink} strokeWidth="2.4" strokeLinejoin="round">
      {scenes[scene].map(([fill,d], index) => <path key={index} fill={library && index === 1 ? library.color || blue : fill} d={d} />)}
      {scene === 'admission' && <text transform="rotate(-15 34 26)" x="34" y="24" textAnchor="middle" fontFamily="Impact, sans-serif" fontWeight="900" fontSize="13" stroke="none" fill={ink}>ADMIT<tspan x="34" dy="12">ONE</tspan></text>}
      {scene === 'ticket' && <text transform="rotate(-15 35 33)" x="35" y="40" textAnchor="middle" fontFamily="Impact, sans-serif" fontSize="20" fontWeight="900" stroke="none" fill={ink}>{number || '★'}</text>}
    </g>
  );
}
