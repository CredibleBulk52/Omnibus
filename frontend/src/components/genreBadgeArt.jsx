import React from 'react';

// Ink illustrations fit above the ribbon in the badge's 128-unit viewBox.
export const genreBadgeArt = {
  genre_superhero: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#c74a50" d="M53 30 Q35 39 18 73 Q39 62 49 75 L70 58 L85 37Z" />
      <path fill="#292336" d="M56 41 L55 18 L65 29 L80 29 L88 16 L85 52 L70 68 L59 57Z" />
      <path fill="#ffeac4" d="M60 39 L69 43 L63 45Z M75 43 L83 37 L81 44Z" />
    </g>
  ),
  genre_crime: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#ffeac4" d="M32 21 L84 16 L92 75 L39 81Z" />
      <path fill="#acbcc4" d="M40 32 L65 29 L69 54 L44 57Z" />
      <path fill="#292336" d="M47 53 Q47 46 51 44 Q43 35 53 34 Q62 34 59 43 L66 50Z M46 65 L80 60 M48 71 L68 68" />
      <path fill="#c74a50" d="M67 38 L88 34 L90 44 L69 48Z" />
    </g>
  ),
  genre_thriller: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#292336" d="M37 38 L46 26 L56 30 V20 H70 V30 L83 29 L92 43 L88 71 L68 81 L44 74Z" />
      <path fill="#ffeac4" d="M43 52 A22 22 0 1 0 87 52 A22 22 0 1 0 43 52Z" />
      <path fill="#c74a50" d="M65 51 L79 36 L69 57 L53 58Z" />
      <path fill="#ffcb67" d="M50 15 H76 V23 H50Z" />
    </g>
  ),
  genre_drama: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#ffeac4" d="M26 29 Q45 24 59 31 L52 61 Q44 73 33 66 Q23 57 26 29Z" />
      <path fill="#488ca5" d="M55 32 Q72 41 96 30 Q94 65 76 77 Q58 77 51 59Z" />
      <path fill="#292336" d="M61 46 L68 50 L60 51Z M78 48 L88 42 L84 50Z M64 65 Q71 55 80 63 Q72 61 66 68Z" />
      <path fill="#acbcc4" d="M84 53 Q92 62 85 65 Q80 65 84 53Z" />
    </g>
  ),
  genre_war: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#acbcc4" d="M31 62 Q33 31 61 28 Q87 27 93 58 L101 62 L99 68 H24 V62Z" />
      <path fill="#659773" d="M32 59 Q33 35 60 32 Q81 31 89 55 L75 50 L68 56 L55 51 L49 58Z" />
      <path fill="#ffeac4" d="M40 69 Q53 88 75 69 Q56 96 40 69Z" />
    </g>
  ),
  genre_espionage: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#292336" d="M24 58 Q40 54 46 47 L45 30 L59 34 L75 25 L85 43 L99 47 L81 55 L83 70 L69 65 L57 79 L46 63Z" />
      <path fill="#ffeac4" d="M43 51 L82 44 L85 50 L49 58Z" />
      <path fill="#c74a50" d="M64 64 L72 59 L76 63 L69 73Z" />
    </g>
  ),
  genre_supernatural: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#acbcc4" d="M24 76 Q34 70 38 46 Q41 20 62 20 Q83 19 85 44 Q85 62 102 65 Q94 78 81 69 Q73 86 63 70 Q52 85 44 72 Q34 81 24 76Z" />
      <path fill="#292336" d="M47 42 Q55 34 55 48 Q48 55 47 42Z M66 40 Q76 31 74 46 Q68 53 66 40Z M58 59 Q62 49 66 58 L64 65Z" />
    </g>
  ),
  genre_cosmic: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#292336" d="M36 48 A26 26 0 1 0 88 48 A26 26 0 1 0 36 48Z" />
      <path fill="#488ca5" d="M39 40 Q57 33 76 27 Q83 31 86 40 Q65 47 38 52Z" />
      <path fill="#ffcb67" d="M32 44 Q6 72 53 57 Q87 47 102 28 Q116 44 77 61 Q21 86 17 67 Q15 57 32 44Z" />
    </g>
  ),
  genre_street_level: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#c74a50" d="M31 19 H82 V78 H31Z" />
      <path fill="#ffeac4" d="M38 27 H51 V43 H38Z M62 27 H75 V43 H62Z" />
      <path fill="#292336" d="M24 44 H87 V51 H71 L52 72 H82 V78 H36 V71 L57 51 H24Z" />
      <path fill="#acbcc4" d="M29 37 H34 V44 H29Z M79 36 H84 V44 H79Z" />
    </g>
  ),
  genre_team: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#488ca5" d="M20 54 L41 37 L56 44 L62 55 L45 69Z" />
      <path fill="#c74a50" d="M101 45 L80 32 L63 40 L58 55 L79 65Z" />
      <path fill="#ffcb67" d="M58 81 L46 61 L52 49 L64 45 L76 53 L79 72Z" />
      <path fill="#ffeac4" d="M41 39 L51 34 L62 40 L66 47 L58 56 L48 55 L43 49Z" />
    </g>
  ),
  genre_teen: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#488ca5" d="M37 36 Q37 29 51 27 Q51 15 65 17 Q75 16 77 27 Q88 30 88 43 L90 72 Q65 82 35 73Z" />
      <path fill="#c74a50" d="M43 51 Q62 46 82 50 V68 Q61 73 42 68Z" />
      <path fill="#ffcb67" d="M59 32 L70 30 L64 40 H70 L55 49 L60 39 H55Z" />
    </g>
  ),
  genre_martial_arts: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#ffeac4" d="M27 42 L56 38 L69 45 L51 61 L23 65Z M72 42 L98 33 L103 46 L77 54 L66 50Z" />
      <path fill="#c74a50" d="M39 22 L52 19 L65 41 L58 48 L48 43Z" />
      <path fill="#292336" d="M58 43 L65 37 L78 43 L78 50 L90 60 L82 76 L65 68 L61 57 L52 53Z" />
      <path fill="#ffcb67" d="M42 63 L55 54 L51 70 L59 68 L48 81Z" />
    </g>
  ),
  genre_post_apocalyptic: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#acbcc4" d="M22 78 L36 62 L34 31 L48 35 L52 29 L55 48 L46 57 L53 62 L61 79Z M72 78 L76 57 L92 50 L97 74Z" />
      <path fill="#659773" d="M61 76 Q60 52 45 47 Q60 45 66 59 Q70 37 88 36 Q89 52 69 60 L66 77Z" />
    </g>
  ),
  genre_alternate_reality: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#292336" d="M21 72 L24 49 H34 V32 H45 V48 H58 V74Z" />
      <path fill="#488ca5" d="M69 29 L83 31 V48 L94 45 V62 L105 60 V76 L64 72Z" />
      <path fill="#ffeac4" d="M62 16 L75 17 L62 43 L71 42 L55 81 L57 54 L48 55Z" />
    </g>
  ),
  genre_anti_hero: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#ffeac4" d="M32 26 Q62 42 94 24 L87 58 L63 77 L38 59Z" />
      <path fill="#292336" d="M64 36 L93 25 L87 58 L63 77 L69 54 L60 51Z M40 43 L57 48 L52 54 L42 52Z" />
      <path fill="#c74a50" d="M71 48 L85 40 L81 51 L72 54Z" />
    </g>
  ),
  genre_all_ages: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#ffcb67" d="M26 42 Q28 30 39 34 Q44 17 56 29 Q67 16 77 29 Q91 26 96 39 Q105 49 91 56 Q92 68 77 69 L83 80 L61 68 Q43 74 38 63 Q21 64 26 51 Q15 46 26 42Z" />
      <path fill="#292336" d="M38 41 L45 40 L48 49 L42 50Z M68 39 L75 36 L78 45 L72 47Z M44 55 Q60 61 81 49 Q64 76 44 55Z" />
    </g>
  ),
  genre_sword_sorcery: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#488ca5" d="M35 75 Q22 59 39 46 Q32 61 47 59 Q51 45 48 36 Q70 52 61 68 Q78 62 76 51 Q94 70 68 78Z" />
      <path fill="#ffeac4" d="M40 66 L77 22 L91 15 L89 31 L48 72Z" />
      <path fill="#ffcb67" d="M31 58 L37 53 L57 72 L51 78Z" />
    </g>
  ),
  genre_pulp: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#ffcb67" d="M26 70 L47 47 L42 33 L55 21 L76 22 L83 39 L101 42 L97 49 L43 55Z" />
      <path fill="#292336" d="M46 50 L85 43 L78 59 L67 67 L44 65Z" />
      <path fill="#c74a50" d="M38 57 L76 58 L70 71 L55 71 L33 82 L39 69 L20 70Z" />
    </g>
  ),
  genre_cyberpunk: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#292336" d="M20 48 L37 43 L44 28 L81 23 L100 37 L91 57 L79 59 L66 74 L52 71 L44 61 L23 65Z" />
      <path fill="#488ca5" d="M30 48 L81 33 L93 39 L84 48 L34 58Z" />
      <path fill="#ffeac4" d="M46 47 L54 42 L50 50Z M62 42 L73 38 L65 47Z" />
      <path fill="#c74a50" d="M80 56 L95 53 V65 L103 69 L100 75 L89 70 V61 L80 63Z" />
    </g>
  ),
  genre_historical: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#ffcb67" d="M36 27 H88 L96 36 H27Z" />
      <path fill="#ffeac4" d="M34 40 H88 V48 H83 V68 H87 V74 H36 V68 H40 V48 H34Z" />
      <path fill="#acbcc4" d="M51 48 H55 V68 H51Z M68 48 H72 V68 H68Z M29 75 H96 V80 H29Z" />
    </g>
  ),
  genre_time_travel: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#ffeac4" d="M36 23 H84 Q83 40 66 50 Q86 63 85 76 H36 Q37 62 55 50 Q38 39 36 23Z" />
      <path fill="#ffcb67" d="M43 35 H76 L61 48Z M43 72 L61 58 L78 72Z" />
      <path fill="#488ca5" d="M31 17 H90 V24 H31Z M31 75 H90 V82 H31Z" />
    </g>
  ),
  genre_surreal: (
    <g stroke="#201c29" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path fill="#acbcc4" d="M36 17 Q62 10 88 25 L82 65 L70 70 L65 82 L59 74 L52 78 L47 62 L32 53Z" />
      <path fill="#488ca5" d="M43 25 Q62 20 79 29 L75 53 Q65 45 54 57 L40 48Z" />
      <path fill="#ffeac4" d="M44 41 Q58 25 75 37 Q63 53 44 41Z" />
      <path fill="#292336" d="M55 39 A5 5 0 1 0 65 39 A5 5 0 1 0 55 39Z" />
    </g>
  ),
  genre_fantasy: (
    <g stroke="#16241e" strokeWidth="3" strokeLinejoin="round">
      <path fill="#428b68" d="M20 59 Q26 35 47 32 L43 19 L60 30 L69 13 L76 30 L94 21 L89 37 L107 39 Q95 53 89 66 L96 77 Q72 72 54 77 Q32 72 20 59Z" />
      <path fill="#ffd663" d="M29 56 Q52 36 91 45 Q72 76 48 67 Q36 64 29 56Z" />
      <path fill="#14271f" d="M63 44 Q70 53 61 66 Q54 55 63 44Z" />
      <path fill="none" d="M24 50 Q48 31 83 36 M77 68 l8 -6" />
      <circle cx="58" cy="49" r="3" fill="ivory" stroke="none" />
    </g>
  ),
  genre_mystery: (
    <g stroke="#211d26" strokeWidth="4" strokeLinecap="round">
      <path fill="#be7045" d="M69 57 L80 56 L102 74 Q105 81 96 82 L71 65Z" />
      <circle cx="55" cy="44" r="26" fill="#e6af59" />
      <circle cx="55" cy="44" r="20" fill="#cce6df" />
      <path fill="none" strokeWidth="3" d="M41 45 Q42 28 55 30 Q69 30 69 43 M43 52 Q46 47 46 42 Q49 31 59 35 Q65 37 64 46 M49 56 Q53 51 52 43 Q53 37 58 40 Q62 43 57 52 L55 57" />
    </g>
  ),
  genre_comedy: (
    <g stroke="#29202b" strokeWidth="3" strokeLinejoin="round">
      <path fill="#f3c652" d="M81 53 L95 45 L92 37 Q91 30 97 32 Q102 33 101 39 Q108 33 111 39 Q114 46 103 48 L86 62Z" />
      <path fill="#412135" d="M25 48 Q53 23 85 33 L89 57 Q70 80 36 76Z" />
      <path fill="#e75e5b" d="M23 46 Q35 20 65 24 Q83 24 87 35 Q62 33 27 53Z M32 66 Q60 68 89 49 Q94 68 65 77 Q44 83 32 75Z" />
      <path fill="#fff3cf" d="M27 47 Q55 30 85 34 L84 44 Q57 43 32 58Z M33 63 Q62 63 87 46 L88 55 Q64 73 35 72Z" />
      <path fill="none" strokeWidth="2.5" d="M44 40 l4 10 M60 36 l2 10 M51 62 l2 8 M70 55 l2 9" />
    </g>
  ),
  genre_horror: (
    <g stroke="#221b2a" strokeWidth="3" strokeLinejoin="round">
      <path fill="#22172a" d="M24 74 L31 44 L43 50 L48 23 L58 37 L74 16 L72 38 L96 23 L88 48 L104 42 L86 72 L69 68 L55 80 L47 66Z" />
      <path fill="#b1bf9a" d="M35 46 Q38 26 48 31 Q53 36 49 53 L43 60 Q46 43 40 41Z M53 40 Q61 17 71 24 Q77 30 63 52 L58 57 Q65 37 60 35Z M74 42 Q87 24 95 31 Q100 40 80 58 L74 60 Q86 44 83 39Z" />
      <path fill="#f7cc61" d="M45 61 L57 63 L53 67Z M64 63 L76 57 L70 66Z" />
    </g>
  ),
  genre_western: (
    <g stroke="#33202b" strokeWidth="3.5" strokeLinejoin="round">
      <circle cx="65" cy="43" r="26" fill="#ffcc60" />
      <path fill="#a55a36" d="M39 55 Q44 33 49 31 Q53 29 59 38 Q64 41 75 31 Q82 25 85 38 L88 56Z" />
      <path fill="#382132" d="M40 49 Q64 58 85 46 L87 55 Q65 68 38 56Z" />
      <path fill="#cd8550" d="M17 49 Q38 63 64 57 Q89 53 107 43 Q103 65 80 69 Q52 81 26 67 Q17 62 17 49Z" />
    </g>
  ),
  genre_science_fiction: (
    <g stroke="#19283a" strokeWidth="3.5" strokeLinejoin="round">
      <path fill="#ffbe59" d="M45 55 Q31 58 21 80 Q39 74 56 63Z" />
      <path fill="#da5551" d="M44 48 L24 47 L38 35 L60 34Z M59 63 L62 77 L75 61 L77 42Z" />
      <path fill="#dceee9" d="M39 53 Q58 23 96 17 Q91 48 55 67Z" />
      <circle cx="71" cy="39" r="8" fill="#45899d" />
      <path fill="#e86050" d="M83 20 L96 17 L92 30Z" />
    </g>
  ),
  genre_romance: (
    <g transform="rotate(-9 62 53)" stroke="#3b2432" strokeWidth="3.5" strokeLinejoin="round">
      <path fill="#ffe4c1" d="M24 36 H99 V76 H24Z" />
      <path fill="none" d="M25 75 L51 51 M99 75 L73 51 M25 37 L62 62 L98 37" />
      <path fill="#d94a5a" d="M62 68 Q40 54 49 46 Q56 41 62 50 Q70 40 77 46 Q86 55 62 68Z" />
    </g>
  ),
  genre_kaiju: (
    <g stroke="#18272c" strokeWidth="3" strokeLinejoin="round">
      <path fill="#e9b577" d="M20 78 V59 H30 V51 H39 V77 H46 V66 H57 V80 H20Z M80 80 V58 H90 V48 H98 V80Z" />
      <path fill="#476957" d="M29 77 Q46 65 49 51 L41 47 L51 42 L46 33 L57 34 L56 23 L68 28 Q79 18 86 26 L94 29 L97 39 L83 42 L79 47 L91 46 L86 54 L73 55 Q69 65 77 79Z" />
      <path fill="#fff2c5" d="M84 40 L89 40 L86 47Z" />
      <path stroke="#ffe98c" strokeWidth="4" d="M74 31 l7 -2" />
    </g>
  ),
};
