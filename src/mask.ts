/**
 * Blank out the parts of a document that are not prose.
 *
 * The original regex guard had no masking at all, which made it fire on code
 * samples, identifiers, URLs and quoted third-party text. Those were the
 * majority of its false positives.
 *
 * Masking replaces each non-prose region with spaces of the same length rather
 * than deleting it. Offsets stay aligned with the source, so a finding can
 * still report a correct line and column against the original text.
 */

/** A region of the source that should not be scanned. */
interface Region {
  start: number;
  end: number;
}

const SPACE_PRESERVING_NEWLINES = (s: string): string =>
  s.replace(/[^\n]/g, " ");

/**
 * YAML frontmatter: a `---` fence on line 1 through the next `---` line.
 * Titles and descriptions there are metadata, not prose the reader sees inline.
 */
function frontmatterRegion(text: string): Region | null {
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!close) return null;
  return { start: 0, end: close.index + close[0].length };
}

/**
 * Fenced code blocks, including nested fences.
 *
 * A fence closes only on a marker at least as long as the one that opened it
 * and of the same character, which is what lets a ```` ```` ```` block contain a
 * ``` ``` ``` block without ending early.
 */
function fencedCodeRegions(text: string): Region[] {
  const regions: Region[] = [];
  const lines = text.split(/(?<=\n)/); // keep line terminators
  let offset = 0;
  let open: { char: string; len: number; start: number } | null = null;

  for (const line of lines) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const marker = m[1]!;
      const char = marker[0]!;
      const len = marker.length;
      if (!open) {
        // An opening fence may carry an info string; a closing one may not.
        open = { char, len, start: offset };
      } else if (char === open.char && len >= open.len && !line.slice(m[0].length).trim()) {
        regions.push({ start: open.start, end: offset + line.length });
        open = null;
      }
    }
    offset += line.length;
  }
  // An unclosed fence masks to end of document, which is what a renderer does.
  if (open) regions.push({ start: open.start, end: text.length });
  return regions;
}

/**
 * Indented code blocks: four spaces or a tab, but only where the line cannot be
 * a list continuation. Kept deliberately narrow to avoid masking wrapped prose.
 */
function indentedCodeRegions(text: string, masked: string): Region[] {
  const regions: Region[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  let blankBefore = true;
  for (let i = 0; i < lineStarts.length; i++) {
    const start = lineStarts[i]!;
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1]! : text.length;
    const line = text.slice(start, end);
    // Skip anything already masked (inside a fence).
    if (masked.slice(start, end).trim() === "" && line.trim() !== "") {
      blankBefore = false;
      continue;
    }
    const isBlank = line.trim() === "";
    const isIndentedCode = /^(?: {4}|\t)/.test(line) && !isBlank;
    // Only treat it as code when a blank line precedes it, matching CommonMark
    // closely enough to avoid swallowing wrapped list items.
    if (isIndentedCode && blankBefore) {
      let scanEnd = end;
      let j = i + 1;
      while (j < lineStarts.length) {
        const s = lineStarts[j]!;
        const e = j + 1 < lineStarts.length ? lineStarts[j + 1]! : text.length;
        const l = text.slice(s, e);
        if (/^(?: {4}|\t)/.test(l) || l.trim() === "") {
          scanEnd = e;
          j++;
        } else break;
      }
      regions.push({ start, end: scanEnd });
      i = j - 1;
      blankBefore = true;
      continue;
    }
    if (!isBlank) blankBefore = false;
    else blankBefore = true;
  }
  return regions;
}

/** Blockquotes. Quoted text is someone else's words, so it is never judged. */
function blockquoteRegions(text: string): Region[] {
  const regions: Region[] = [];
  const re = /^[ \t]{0,3}>.*(?:\r?\n[ \t]{0,3}>.*)*/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    regions.push({ start: m.index, end: m.index + m[0].length });
  }
  return regions;
}

/**
 * Inline spans that are not prose:
 *   `code`            identifiers, property names, snippets
 *   <https://...>     autolinks
 *   bare URLs
 *   ](target)         the target half of a markdown link, but NOT the text half
 *   [ref]: target     link reference definitions
 */
function inlineRegions(text: string): Region[] {
  const regions: Region[] = [];
  const push = (re: RegExp, group?: number) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (group === undefined) {
        regions.push({ start: m.index, end: m.index + m[0].length });
      } else {
        const inner = m[group];
        if (inner === undefined) continue;
        const at = m.index + m[0].indexOf(inner, m[0].indexOf("](") >= 0 ? m[0].indexOf("](") : 0);
        regions.push({ start: at, end: at + inner.length });
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  };

  push(/(`+)[^`]*?\1/g); // inline code, backtick-count aware
  push(/<[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^>\s]+>/g); // autolink
  push(/\]\(([^)\s]+)/g, 1); // link target only
  push(/^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S+/gm); // link reference definition
  push(/\bhttps?:\/\/\S+/g); // bare URL
  push(/\b[\w.-]+@[\w.-]+\.\w+\b/g); // email
  return regions;
}

/**
 * Returns a copy of `text` with every non-prose region replaced by spaces.
 * Length and newline positions are preserved so offsets remain valid.
 */
export function maskNonProse(text: string): string {
  const chars = [...text];
  const apply = (regions: Region[]) => {
    for (const { start, end } of regions) {
      for (let i = start; i < end && i < chars.length; i++) {
        if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
      }
    }
  };

  const fm = frontmatterRegion(text);
  if (fm) apply([fm]);
  apply(fencedCodeRegions(text));

  // Indented-code detection needs to know what the fences already covered.
  apply(indentedCodeRegions(text, chars.join("")));
  apply(blockquoteRegions(text));
  apply(inlineRegions(text));

  return chars.join("");
}

/** Convenience for callers that want the untouched prose only. */
export function proseOnly(text: string): string {
  return maskNonProse(text)
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

export const __testing = {
  frontmatterRegion,
  fencedCodeRegions,
  blockquoteRegions,
  inlineRegions,
  SPACE_PRESERVING_NEWLINES,
};
