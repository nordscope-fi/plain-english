/**
 * Fold away the character-level variation that lets a rule be missed.
 *
 * Measured before this existed: the em dash rule, which is the headline rule of
 * the whole ruleset, was defeated by `&mdash;`, by the fullwidth dash, by the
 * horizontal bar, and by a zero-width space dropped inside a word. None of
 * these require anyone to be evading the linter. Entity-encoded dashes and
 * fullwidth punctuation both turn up in ordinary documents.
 *
 * Normalisation runs after masking and preserves length exactly, so every
 * offset in a finding still points at the right place in the original source.
 * A replacement that is not the same length as the original is padded, which is
 * why only same-length or shrinkable substitutions appear here.
 */

/**
 * Characters with no visible width. A zero-width space inside "furthermore"
 * makes the word invisible to a word-boundary regex while looking identical to
 * a reader.
 */
const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

/** Dash characters a reader sees as an em dash. */
const DASH_VARIANTS: Record<string, string> = {
  "—": "—", // em dash, canonical
  "―": "—", // horizontal bar
  "－": "—", // fullwidth hyphen-minus
  "⸺": "—", // two-em dash
  "⸻": "—", // three-em dash
};

/** Non-breaking and figure variants a reader sees as a plain hyphen. */
const HYPHEN_VARIANTS: Record<string, string> = {
  "‑": "-", // non-breaking hyphen
  "‒": "-", // figure dash
  "﹣": "-", // small hyphen-minus
};

/**
 * HTML entities for the dashes, with a replacement padded to the same length so
 * offsets survive. `&mdash;` is 7 characters, so it becomes the dash plus six
 * spaces; the finding then points at the first character of the entity.
 */
const DASH_ENTITIES: [RegExp, string][] = [
  [/&mdash;/gi, "—"],
  [/&#8212;/g, "—"],
  [/&#x2014;/gi, "—"],
  [/&ndash;/gi, "–"],
  [/&#8211;/g, "–"],
];

/**
 * Returns `text` with the variants folded to their canonical form, at exactly
 * the same length.
 */
export function normaliseForMatching(text: string): string {
  let out = text;

  out = out.replace(/[―－⸺⸻]/g, (c) => DASH_VARIANTS[c] ?? c);
  out = out.replace(/[‑‒﹣]/g, (c) => HYPHEN_VARIANTS[c] ?? c);

  for (const [re, replacement] of DASH_ENTITIES) {
    out = out.replace(re, (m) => replacement + " ".repeat(m.length - replacement.length));
  }

  if (out.length !== text.length) {
    // Length drift would corrupt every offset downstream. Rather than report a
    // wrong location, fall back to the untouched text.
    return text;
  }
  return out;
}

/**
 * Text with zero-width characters removed, plus a map back to the original.
 *
 * Replacing a zero-width space with an ordinary space keeps offsets aligned but
 * splits the word, so `Fur<ZWSP>thermore` becomes two words and the rule still
 * misses it. Deleting the character is the only way to match, and deleting it
 * shifts every following offset, so the map is what keeps findings pointing at
 * the right place.
 *
 * When the text contains no zero-width characters, which is almost always, the
 * map is the identity and this costs one scan.
 */
export interface Compacted {
  text: string;
  /** `map[i]` is the offset in the original text of `text[i]`. */
  map: number[] | null;
}

export function stripZeroWidth(text: string): Compacted {
  ZERO_WIDTH.lastIndex = 0;
  if (!ZERO_WIDTH.test(text)) return { text, map: null };

  let out = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/[​‌‍⁠﻿]/.test(ch)) continue;
    map.push(i);
    out += ch;
  }
  return { text: out, map };
}

export const __testing = { ZERO_WIDTH, DASH_VARIANTS, DASH_ENTITIES };
