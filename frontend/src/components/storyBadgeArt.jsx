import React from 'react';

function Cover({ paper, children }) {
  return (
    <g transform="translate(22 16)" stroke="#201b28" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
      <rect x="-2" y="-3" width="84" height="70" fill={paper} />
      {children}
    </g>
  );
}

export const storyBadgeArt = {
  story_year_one: (
    <Cover paper="#927c70">
      <path fill="#ffce65" d="M10 5 H67 V58 H10Z" />
      <path fill="#171927" d="M35 5 H39 V58 H35Z M10 30 H67 V34 H10Z M5 17 Q22 13 34 23 L36 16 L42 17 L48 12 L46 23 Q58 16 76 13 Q66 21 63 35 Q54 29 48 42 Q39 33 34 45 Q27 33 18 36 Q18 25 5 17Z" />
    </Cover>
  ),
  story_long_halloween: (
    <Cover paper="#374357">
      <path fill="#f6e9c6" d="M15 8 L61 5 L66 52 L54 48 L49 55 L43 50 L16 55Z" />
      <path fill="#d6404d" d="M15 8 L61 5 L62 15 L16 18Z M20 25 H39 M21 32 H34" />
      <path fill="#e88a41" d="M36 42 Q43 30 50 35 Q65 27 72 40 Q77 54 63 60 Q48 66 37 56Z" />
      <path fill="#171927" d="M45 45 L49 39 L52 45Z M57 43 L63 39 L65 44Z M44 50 L50 53 L55 49 L59 52 L68 48 Q59 63 44 50Z" />
    </Cover>
  ),
  story_killing_joke: (
    <Cover paper="#53365a">
      <path fill="#ffce65" d="M10 24 H23 L28 15 H49 L55 22 H69 V54 H10Z" />
      <path fill="#171927" d="M36 37 A12 12 0 1 0 60 37 A12 12 0 1 0 36 37Z" />
      <path fill="#f6e9c6" d="M49 36 L53 28 L54 34 L63 34 L56 39 L58 45 L51 42 L45 46 L46 39 L40 36Z" />
    </Cover>
  ),
  story_watchmen: (
    <Cover paper="#294459">
      <path fill="#ffce65" d="M16 33 A23 23 0 1 0 62 33 A23 23 0 1 0 16 33Z" />
      <path fill="#171927" d="M29 24 h3 v7 h-3Z M44 24 h3 v7 h-3Z M25 37 Q40 55 54 36 Q42 62 25 37Z" />
      <path fill="#d6404d" d="M52 10 L48 23 L38 35 L43 22Z" />
    </Cover>
  ),
  story_all_star_superman: (
    <Cover paper="#4182a6">
      <path fill="#ffce65" d="M37 23 A18 18 0 1 0 73 23 A18 18 0 1 0 37 23Z" />
      <path fill="#f6e9c6" d="M1 53 Q9 40 18 44 Q22 28 37 37 Q46 26 59 41 Q71 36 78 48 V61 H1Z" />
      <path fill="#d6404d" d="M39 29 Q28 35 15 47 Q25 46 33 42 L32 47 L48 37Z" />
      <path fill="#171927" d="M36 32 l7 -7 6 2 9 -6 3 2 -12 10 -8 1 -9 10 -5 1Z" />
    </Cover>
  ),
  story_kingdom_come: (
    <Cover paper="#943b3c">
      <path fill="#171927" d="M6 18 L19 8 H61 L74 18 L40 58Z" />
      <path fill="#d6404d" d="M19 17 H54 L46 24 L30 23 L53 34 L39 47 L45 35 L21 26Z" />
    </Cover>
  ),
  story_sandman: (
    <Cover paper="#33304c">
      <path fill="#ffce65" d="M13 12 L30 15 L33 27 L17 24Z M6 44 L19 36 L23 42 L10 51Z" />
      <path fill="#171927" d="M34 19 Q42 6 58 13 Q72 21 62 36 L52 42 L41 57 L33 53 L43 35 Q31 33 34 19Z" />
      <path fill="#f6e9c6" d="M40 22 L47 19 L45 27Z M53 18 L61 17 L55 24Z M50 34 L43 49 L47 46Z" />
    </Cover>
  ),
  story_anatomy_lesson: (
    <Cover paper="#6a937b">
      <path fill="#f6e9c6" d="M13 53 Q18 20 65 9 Q64 44 37 53 L22 55Z" />
      <path fill="#547f54" d="M22 51 L56 18 L43 41 L56 36 L35 48Z" />
      <path fill="#699db6" d="M10 54 L39 45 L66 38 L45 50 L13 60Z" />
    </Cover>
  ),
  story_hard_traveling: (
    <Cover paper="#719d7b">
      <path fill="#ffce65" d="M2 38 L25 18 L47 33 L62 20 L78 36 V43 H2Z" />
      <path fill="#171927" d="M4 62 Q70 42 39 35 Q27 32 47 29 Q35 33 47 35 Q77 42 39 62Z" />
      <path fill="#547f54" d="M11 17 A8 8 0 1 0 27 17 A8 8 0 1 0 11 17Z" />
      <path fill="#f6e9c6" d="M50 17 L67 8 L63 8 L70 5 L69 13 L68 10 L52 21Z" />
    </Cover>
  ),
  story_doomsday: (
    <Cover paper="#938693">
      <path fill="#171927" d="M26 60 L37 6 L41 6 L32 60Z" />
      <path fill="#d6404d" d="M37 13 Q53 20 72 14 L62 26 L70 26 L54 36 L47 33 L34 38Z" />
      <path fill="#ffce65" d="M42 19 L59 21 L53 25 L47 23 L53 28 L43 31Z" />
    </Cover>
  ),
  story_two_worlds: (
    <Cover paper="#478aa2">
      <path fill="#d6404d" d="M8 44 L27 15 L48 12 L34 30 L41 29 L17 53 L24 38Z M38 50 L56 22 L74 19 L62 36 L69 34 L46 59 L53 43Z" />
      <path fill="#ffce65" d="M37 6 L48 6 L37 29 L45 27 L26 59 L32 37 L26 38Z" />
    </Cover>
  ),
  story_vendetta: (
    <Cover paper="#633247">
      <path fill="#f6e9c6" d="M22 17 Q39 10 60 16 L56 42 L40 57 L26 43Z" />
      <path fill="#171927" d="M27 25 Q32 20 37 25 L33 27Z M44 25 Q50 20 56 23 L49 27Z M28 35 Q35 40 40 33 Q46 39 54 32 Q51 44 40 38 Q30 45 28 35Z M37 45 L43 44 L40 53Z" />
      <path fill="#171927" d="M13 18 L26 13 L29 5 H51 L56 12 L69 15Z" />
    </Cover>
  ),
  story_death_in_the_family: (
    <Cover paper="#8f4b4b">
      <path fill="#171927" d="M9 30 Q8 12 37 11 Q67 9 71 24 L68 31 L56 31 L53 20 Q40 17 27 22 L25 32Z" />
      <path fill="#f6e9c6" d="M27 37 L51 34 L63 55 L18 58Z" />
      <path fill="#d6404d" d="M33 43 A7 7 0 1 0 47 43 A7 7 0 1 0 33 43Z" />
    </Cover>
  ),
  story_new_frontier: (
    <Cover paper="#447a9a">
      <path fill="#ffce65" d="M42 23 A17 17 0 1 0 76 23 A17 17 0 1 0 42 23Z" />
      <path fill="#f6e9c6" d="M2 56 L41 31 L48 33 L14 59Z" />
      <path fill="#171927" d="M27 37 L42 28 L45 13 L50 11 L53 24 L74 17 L64 28 L52 34 L47 48 L42 50 L43 36 L31 43Z" />
    </Cover>
  ),
  story_mister_miracle: (
    <Cover paper="#35735b">
      <path fill="#ffce65" d="M14 13 L29 8 L38 16 L35 30 L22 38 L11 29Z M47 36 L60 28 L71 35 L68 50 L54 57 L44 50Z" />
      <path fill="#171927" d="M19 17 L28 14 L31 18 L28 26 L22 30 L17 26Z M51 39 L60 34 L65 37 L62 46 L55 51 L50 47Z" />
      <path fill="#d6404d" d="M29 40 L40 26 L38 37 L50 28 L39 45 L41 36Z" />
    </Cover>
  ),
  story_preacher: (
    <Cover paper="#aa6143">
      <path fill="#ffce65" d="M9 37 A17 17 0 1 0 43 37 A17 17 0 1 0 9 37Z" />
      <path fill="#171927" d="M3 59 L14 48 L32 46 L39 39 L48 47 L64 43 L77 53 V63 H3Z M46 47 V20 H37 V15 H46 V7 H52 V15 H62 V20 H52 V47Z" />
    </Cover>
  ),
  story_last_man: (
    <Cover paper="#698573">
      <path fill="#f6e9c6" d="M12 12 H28 L40 30 L52 12 H68 L47 40 V58 H33 V40Z" />
      <path fill="#171927" d="M46 29 Q52 15 61 23 Q67 23 64 32 L58 37 L57 47 Q66 53 69 44 Q75 58 60 57 Q48 56 49 43 L45 40Z" />
    </Cover>
  ),
  story_great_power: (
    <Cover paper="#346c91">
      <path fill="#d6404d" d="M15 34 Q19 8 45 11 Q65 13 62 37 L49 56 L30 56Z" />
      <path fill="#f6e9c6" d="M20 27 L37 36 L33 43 Q24 42 20 27Z M44 34 L60 24 Q57 40 47 42Z" />
      <path fill="none" d="M35 13 L39 23 L47 13 M39 23 L40 33 M28 15 Q38 27 53 18" />
    </Cover>
  ),
  story_gwen_stacy: (
    <Cover paper="#595881">
      <path fill="#171927" d="M8 55 V17 H13 V54 H18 V16 H23 V51 L75 46 V52 L6 60Z" />
      <path fill="none" d="M22 21 Q42 47 76 46 M24 31 V50 M38 37 V48 M52 43 V47" />
      <path fill="#ffce65" d="M43 50 L52 53 L48 60 L43 57 L39 62 L36 59Z" />
    </Cover>
  ),
  story_my_destiny: (
    <Cover paper="#466878">
      <path fill="#b4c2c5" d="M4 9 H74 V23 L62 24 L61 35 L42 33 L38 37 L23 32 L9 33Z" />
      <path fill="#d6404d" d="M19 27 L25 25 L34 41 L46 42 L55 26 L62 26 L54 51 L46 57 H32 L24 49Z" />
      <path fill="#f6e9c6" d="M33 46 L38 48 L36 51Z M42 48 L47 44 L46 50Z" />
    </Cover>
  ),
  story_dark_phoenix: (
    <Cover paper="#602738">
      <path fill="#d6404d" d="M3 14 Q24 17 37 34 L42 17 L52 8 L53 21 Q68 13 76 5 Q77 31 54 42 L49 60 L42 48 L31 59 L33 43 Q11 40 3 14Z" />
      <path fill="#ffce65" d="M13 23 L37 38 L41 29 L48 21 L45 39 L67 21 L53 41 L42 51 L39 43Z" />
    </Cover>
  ),
  story_future_past: (
    <Cover paper="#605962">
      <path fill="#f6e9c6" d="M15 11 L66 8 L68 51 L57 49 L49 56 L39 52 L20 56Z" />
      <path fill="#171927" d="M26 18 H57 V22 H26Z M32 44 Q33 36 38 34 Q32 23 43 23 Q54 24 48 34 L55 43Z" />
      <path fill="#d6404d" d="M19 40 L65 25 L67 33 L21 50Z" />
    </Cover>
  ),
  story_born_again: (
    <Cover paper="#903d42">
      <path fill="#f6e9c6" d="M38 17 L42 8 L47 16 V29 L60 39 V58 H19 V39 L37 28Z" />
      <path fill="#171927" d="M26 44 L33 38 V58 H26Z M42 37 L49 43 V58 H42Z" />
      <path fill="#d6404d" d="M9 48 Q21 31 27 32 L27 23 L33 29 L38 24 L38 37 L29 45 L22 45 L16 57Z" />
    </Cover>
  ),
  story_galactus: (
    <Cover paper="#303559">
      <path fill="#a578aa" d="M9 8 L23 15 L25 28 L43 23 L53 8 L63 5 L57 33 L49 46 L26 50 L16 37Z" />
      <path fill="#72acc2" d="M27 34 L34 36 L33 40 L28 40Z M39 34 L48 30 L46 36 L40 38Z" />
      <path fill="#eee9d6" d="M35 57 Q55 43 77 42 Q63 55 35 57Z M52 47 L56 36 L61 32 L64 34 L62 39 L68 42 L63 44 L57 41 L56 47Z" />
    </Cover>
  ),
  story_this_monster: (
    <Cover paper="#41667e">
      <path fill="#de8e46" d="M11 20 L25 10 L51 12 L64 23 L62 42 L47 56 L24 54 L12 41Z" />
      <path fill="#191c2c" d="M16 28 L33 27 L34 34 L20 34Z M42 27 L58 23 L55 30 L43 33Z" />
      <path fill="none" d="M19 18 L26 24 L33 20 L38 13 M33 37 L40 41 L51 35 M24 46 L34 44 L42 49 L53 42" />
    </Cover>
  ),
  story_demon_in_a_bottle: (
    <Cover paper="#754549">
      <path fill="#f7c968" d="M11 15 L27 8 L43 16 L40 42 L28 52 L16 45Z" />
      <path fill="#191c2c" d="M16 22 L26 25 L25 29 L18 27Z M30 24 L39 20 L37 26 L30 28Z" />
      <path fill="#4e8a60" d="M48 9 H58 V23 L66 32 V56 H40 V32 L48 23Z" />
      <path fill="#eee9d6" d="M43 37 H63 V46 H43Z" />
    </Cover>
  ),
  story_kravens_last_hunt: (
    <Cover paper="#47564d">
      <path fill="#eee9d6" d="M16 46 V25 Q17 9 36 12 Q48 13 49 28 V46Z" />
      <path fill="#191c2c" d="M8 57 L24 43 L42 46 L54 38 L70 45 L76 59Z" />
      <path fill="#bd404b" d="M28 48 L33 31 L36 32 L37 40 L42 28 L45 30 L44 41 L51 34 L54 37 L48 50 L35 56Z" />
    </Cover>
  ),
  story_cap_lives: (
    <Cover paper="#71b4c8">
      <path fill="#eee9d6" d="M8 45 L13 14 L42 7 L68 18 L72 46 L53 58 L24 57Z" />
      <path fill="#bd404b" d="M19 34 A20 20 0 1 0 59 34 A20 20 0 1 0 19 34Z" />
      <path fill="#72acc2" d="M28 34 A11 11 0 1 0 50 34 A11 11 0 1 0 28 34Z" />
      <path fill="#eee9d6" d="M39 24 L42 31 L49 31 L44 36 L46 43 L39 39 L32 43 L34 36 L29 31 L36 31Z" />
    </Cover>
  ),
  story_first_claws: (
    <Cover paper="#465b41">
      <path fill="#f7c968" d="M9 44 Q15 32 30 30 L41 39 L35 56 L17 59Z" />
      <path fill="#eee9d6" d="M25 34 L55 8 L32 37Z M32 38 L64 12 L38 42Z M38 42 L73 19 L41 48Z" />
    </Cover>
  ),
  story_best_there_is: (
    <Cover paper="#e0c7ae">
      <path fill="#bd404b" d="M24 29 A17 17 0 1 0 58 29 A17 17 0 1 0 24 29Z" />
      <path fill="#191c2c" d="M8 17 Q41 22 72 15 L68 22 L14 24Z M17 29 H65 V33 H17Z M23 21 H28 L26 59 H20Z M54 20 H59 L62 58 H56Z" />
      <path fill="#eee9d6" d="M34 52 L62 30 L39 55Z" />
    </Cover>
  ),
  story_marvels: (
    <Cover paper="#647485">
      <path fill="#191c2c" d="M7 22 H23 L27 15 H47 L52 21 H69 V53 H7Z" />
      <path fill="#72acc2" d="M27 37 A14 14 0 1 0 55 37 A14 14 0 1 0 27 37Z" />
      <path fill="#f7c968" d="M32 44 V36 H37 V31 H41 V24 H44 V35 H49 V43Z" />
      <path fill="#eee9d6" d="M12 25 H22 V29 H12Z" />
    </Cover>
  ),
  story_winter_soldier: (
    <Cover paper="#344c67">
      <path fill="#eee9d6" d="M29 10 L43 8 L57 18 L53 33 L48 38 L48 49 L34 58 L23 52 L31 39 L25 31Z" />
      <path fill="#bd404b" d="M39 13 L42 20 L50 20 L44 25 L47 31 L39 27 L33 32 L34 25 L29 22 L36 20Z" />
      <path fill="none" d="M31 36 L45 41 M28 43 L43 47 M27 48 L39 52" />
    </Cover>
  ),
  story_krakoa: (
    <Cover paper="#385953">
      <path fill="#4e8a60" d="M10 57 L17 32 Q22 9 44 9 Q67 8 69 39 L72 58 L61 55 L57 37 Q50 21 39 24 Q29 26 27 42 L24 57Z" />
      <path fill="#a578aa" d="M18 30 L11 23 L17 23 L20 17 L25 23 L30 23 L25 31Z M58 22 L55 14 L62 17 L67 12 L68 18 L73 21 L65 25Z" />
      <path fill="#f7c968" d="M30 58 L42 33 L48 33 L43 57Z" />
    </Cover>
  ),
  story_pizza_dog: (
    <Cover paper="#796489">
      <path fill="#f7c968" d="M13 15 Q40 10 60 25 L32 57Z" />
      <path fill="#eee9d6" d="M13 15 Q32 5 61 19 L60 25 Q38 15 16 21Z" />
      <path fill="#bd404b" d="M25 29 A4 4 0 1 0 33 29 A4 4 0 1 0 25 29Z M37 32 A4 4 0 1 0 45 32 A4 4 0 1 0 37 32Z" />
      <path fill="#191c2c" d="M46 53 Q44 44 53 39 L51 29 L60 34 L69 30 L67 42 L74 45 L70 50 L60 51 L56 59Z" />
    </Cover>
  ),
  story_days_gone_bye: (
    <Cover paper="#717f79">
      <path fill="#eee9d6" d="M10 13 H67 V58 H10Z" />
      <path fill="#191c2c" d="M16 18 H38 V56 H16Z M43 18 H62 V56 H43Z" />
      <path fill="#bd404b" d="M21 33 L54 26 L57 31 L24 39Z M23 24 L57 39 L55 44 L20 29Z" />
    </Cover>
  ),
  story_lying: (
    <Cover paper="#585875">
      <path fill="#eee9d6" d="M11 16 Q27 18 36 32 L32 48 Q26 36 20 36 L24 44 Q14 40 12 30 L18 32Z" />
      <path fill="#f7c968" d="M47 29 Q49 14 60 11 L56 23 L69 16 Q66 32 54 38Z" />
      <path fill="#bd404b" d="M23 42 Q39 32 56 42 L48 54 L34 58Z" />
      <path fill="#eee9d6" d="M32 39 Q34 29 44 32 Q49 35 47 41 L39 45Z" />
    </Cover>
  ),
  story_hellspawn: (
    <Cover paper="#465557">
      <path fill="#bd404b" d="M7 8 L30 17 L42 12 L62 9 L72 5 L66 30 L75 55 L53 48 L40 60 L26 45 L5 53 L15 30Z" />
      <path fill="#191c2c" d="M25 21 L39 17 L53 20 L54 35 L40 47 L27 37Z" />
      <path fill="#4e8a60" d="M28 27 L37 30 L35 34Z M44 30 L51 25 L48 33Z" />
    </Cover>
  ),
  story_seed_of_destruction: (
    <Cover paper="#b69b74">
      <path fill="#bd404b" d="M16 53 L13 36 L18 20 L24 18 L28 24 L31 14 L38 13 L42 20 L46 14 L52 18 L54 26 L60 24 L65 31 L62 42 L54 54 L32 58Z" />
      <path fill="none" d="M21 24 L23 35 L30 38 M32 22 L34 33 L43 36 M45 20 L47 31 L54 34 M29 48 L46 46" />
    </Cover>
  ),
  story_out_from_boneville: (
    <Cover paper="#769c82">
      <path fill="#f7c968" d="M4 48 L19 25 L35 42 L52 16 L77 49 V60 H4Z" />
      <path fill="#eee9d6" d="M19 46 Q13 40 18 31 Q24 24 31 30 Q34 35 31 39 Q48 35 46 44 Q45 50 32 49 L35 56 L24 59Z" />
      <path fill="#191c2c" d="M28 33 l2 0 v3 h-2Z" />
    </Cover>
  ),
  story_half_shell: (
    <Cover paper="#727875">
      <path fill="#191c2c" d="M6 45 Q28 30 57 27 L73 31 Q61 48 26 53Z" />
      <path fill="#eee9d6" d="M9 38 L66 19 L68 23 L12 43Z M16 46 L69 29 L63 36 L29 50Z" />
      <path fill="#bd404b" d="M24 30 L51 22 L55 27 L41 31 L34 36 L24 35 L13 41 L16 34Z" />
    </Cover>
  ),
  story_invincible: (
    <Cover paper="#46769c">
      <path fill="#f7c968" d="M9 18 Q38 10 71 18 L62 46 L48 39 L41 32 L33 42 L20 47Z" />
      <path fill="#eee9d6" d="M15 22 L36 19 L32 34 L23 39Z M45 20 L64 22 L57 36 L49 31Z" />
      <path fill="#bd404b" d="M57 13 L54 23 L61 31 L57 34 L49 24 L52 14Z" />
    </Cover>
  ),
  story_kick_ass: (
    <Cover paper="#c69859">
      <path fill="#4e8a60" d="M18 44 L18 28 Q20 8 40 9 Q62 10 62 33 L57 51 L41 58 L25 54Z" />
      <path fill="#f7c968" d="M36 10 H42 L45 51 L39 55Z M19 28 L60 25 L61 33 L19 36Z" />
      <path fill="#191c2c" d="M23 30 L35 30 L33 36 L25 36Z M46 29 L57 27 L55 33 L48 34Z" />
    </Cover>
  ),
  story_coward: (
    <Cover paper="#656778">
      <path fill="#191c2c" d="M14 11 L65 17 L60 55 L23 58Z" />
      <path fill="#eee9d6" d="M22 28 L54 31 L51 49 L27 51Z" />
      <path fill="#f7c968" d="M6 47 L19 39 L33 38 L42 31 L45 34 L37 43 L50 40 L52 44 L38 52 L22 52 L13 59Z" />
    </Cover>
  ),
  story_monstress: (
    <Cover paper="#426456">
      <path fill="#f7c968" d="M14 33 Q38 7 66 29 Q43 57 14 33Z" />
      <path fill="#191c2c" d="M31 32 A10 10 0 1 0 51 32 A10 10 0 1 0 31 32Z M18 32 Q3 23 10 12 Q10 23 24 25Z M55 24 Q68 16 67 9 Q77 22 62 31Z M27 40 Q20 48 30 58 Q16 57 19 42Z M49 42 Q64 55 70 42 Q70 63 52 54Z" />
      <path fill="#eee9d6" d="M39 26 L44 28 L40 33 L36 32Z" />
    </Cover>
  ),
};
