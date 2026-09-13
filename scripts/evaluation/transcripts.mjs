function decoration(value) {
  if (!value.startsWith("`")) return false;
  const inner = value.replace(/^`+|`+$/gu, "").replace(/[★─━═\s]/gu, "");
  return !inner || /^insight$/iu.test(inner);
}

/** Exact source text a rewrite must retain, without nested or decorative noise. */
export function protectedLiterals(value) {
  const patterns = [
    /```[\s\S]{1,400}?```/gu,
    /`[^`\n]{1,240}`/gu,
    /https?:\/\/[^\s>)]+/gu,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,
    /(?:^|\s)(?:\.{0,2}\/|\/)[A-Za-z0-9._~@%+,:=\/-]+/gmu,
    /(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*(?:%|ms|s|min|hours?|days?|MB|GB)?\b)/gu,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const literal = match[0].trim();
      if (!literal || decoration(literal)) continue;
      if (found.some((existing) => existing === literal || existing.includes(literal))) continue;
      found.push(literal);
      if (found.length === 30) return found;
    }
  }
  return found;
}
