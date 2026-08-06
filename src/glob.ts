/**
 * Minimal glob matching for `exclude` patterns.
 *
 * Shared by the CLI and the hook adapter on purpose. Two copies of a matcher is
 * how the thing this package replaces ended up with three copies of a regex.
 *
 *   **\/  any number of leading directories
 *   **    any characters, including separators
 *   *     any characters except a separator
 *   ?     one character except a separator
 */

const DIR_STAR = "\u0000";
const GLOBSTAR = "\u0001";

export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, DIR_STAR)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split(DIR_STAR)
    .join("(?:.*/)?")
    .split(GLOBSTAR)
    .join(".*");
  return new RegExp(`^${source}$`);
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path.split("\\").join("/"));
}

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}
