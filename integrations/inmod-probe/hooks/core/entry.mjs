import {
  compile,
  isShoutedWord,
  jargonTerms,
  maskNonProse,
  matchAllWithDeadline,
  parseSet,
  sentences,
  toRuleSet
} from "./chunk-4QZB4RMV.mjs";
import "./chunk-YVDCUCSJ.mjs";
import "./chunk-6VUKDY2J.mjs";
import "./chunk-E7FTBMZN.mjs";
import "./chunk-L4PGFK3X.mjs";
import "./chunk-KWWQFVSE.mjs";
import "./chunk-VC7IYITB.mjs";
import "./chunk-3TQ6XHDS.mjs";
import "./chunk-4A7VIGHI.mjs";
import "./chunk-LMIGXZZM.mjs";
import "./chunk-6QJLDWLI.mjs";
import "./chunk-756EJLZL.mjs";

var ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/g;
var DASH_VARIANTS = {
  "\u2014": "\u2014",
  "\u2015": "\u2014",
  "\uFF0D": "\u2014",
  "\u2E3A": "\u2014",
  "\u2E3B": "\u2014"
};
var HYPHEN_VARIANTS = {
  "\u2011": "-",
  "\u2012": "-",
  "\uFE63": "-"
};
var DASH_ENTITIES = [
  [/&mdash;/gi, "\u2014"],
  [/&#8212;/g, "\u2014"],
  [/&#x2014;/gi, "\u2014"],
  [/&ndash;/gi, "\u2013"],
  [/&#8211;/g, "\u2013"]
];
function normaliseForMatching(text) {
  let out = text;
  out = out.replace(/[―－⸺⸻]/g, (c) => DASH_VARIANTS[c] ?? c);
  out = out.replace(/[‑‒﹣]/g, (c) => HYPHEN_VARIANTS[c] ?? c);
  for (const [re, replacement] of DASH_ENTITIES) {
    out = out.replace(re, (m) => replacement + " ".repeat(m.length - replacement.length));
  }
  if (out.length !== text.length) {
    return text;
  }
  return out;
}
function stripZeroWidth(text) {
  ZERO_WIDTH.lastIndex = 0;
  if (!ZERO_WIDTH.test(text)) return { text, map: null };
  let out = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[\u200b\u200c\u200d\u2060\ufeff]/.test(ch)) continue;
    map.push(i);
    out += ch;
  }
  return { text: out, map };
}

var DEFAULT_BUDGET_MS = 2e3;
var REASON = "(?:\\s*:\\s*([^>]*?))?";
var SUPPRESS_NEXT = new RegExp(
  `<!--\\s*plain-english-disable-next-line(?:\\s+([a-z0-9,\\s-]+?))?${REASON}\\s*-->`,
  "i"
);
var SUPPRESS_FILE = new RegExp(
  `<!--\\s*plain-english-disable-file${REASON}\\s*-->`,
  "i"
);
var SUPPRESS_RANGE_OFF = new RegExp(
  `<!--\\s*plain-english-disable(?:\\s+([a-z0-9,\\s-]+?))?${REASON}\\s*-->`,
  "i"
);
var SUPPRESS_RANGE_ON = /<!--\s*plain-english-enable(?:\s+([a-z0-9,\s-]+?))?\s*-->/i;
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}
function locate(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}
function parseIds(raw) {
  const ids = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : "all";
}
function merge(a, b) {
  if (a === void 0) return b;
  if (a === "all" || b === "all") return "all";
  return   new Set([...a, ...b]);
}
function allowedBy(ruleSet, ruleId, text) {
  return ruleSet.allowRe?.find(
    (a) => (!a.rules || a.rules.has(ruleId)) && a.re.test(text)
  );
}
function suppressionsFor(sourceLines) {
  const map =   new Map();
  sourceLines.forEach((line, i) => {
    const m = SUPPRESS_NEXT.exec(line);
    if (!m) return;
    map.set(i + 2, merge(map.get(i + 2), parseIds(m[1])));
  });
  let active = null;
  sourceLines.forEach((line, i) => {
    const isNext = SUPPRESS_NEXT.test(line);
    const isFile = SUPPRESS_FILE.test(line);
    const on = !isNext && !isFile ? SUPPRESS_RANGE_ON.exec(line) : null;
    const off = !isNext && !isFile ? SUPPRESS_RANGE_OFF.exec(line) : null;
    if (on) {
      const ids = parseIds(on[1]);
      if (ids === "all" || active === "all" || active === null) active = null;
      else {
        for (const id of ids) active.delete(id);
        if (active.size === 0) active = null;
      }
      return;
    }
    if (off) {
      active = merge(active ?? void 0, parseIds(off[1]));
      return;
    }
    if (active !== null) map.set(i + 1, merge(map.get(i + 1), active));
  });
  return map;
}
function lintText(text, ruleSet, options = {}) {
  const { allowInlineSuppression = true, budgetMs = DEFAULT_BUDGET_MS } = options;
  const findings = [];
  const timedOut = [];
  const silenced = [];
  const deadline = Date.now() + budgetMs;
  const directiveView = maskNonProse(text);
  const normalised = normaliseForMatching(maskNonProse(text, { maskComments: true }));
  const compacted = stripZeroWidth(normalised);
  const masked = compacted.text;
  const toSource = (i) => compacted.map?.[i] ?? i;
  const starts = lineIndex(text);
  const sourceLines = text.split("\n");
  const maskedLines = normalised.split("\n");
  if (allowInlineSuppression) {
    findings.push(
      ...unexplainedSuppressions(text, directiveView, ruleSet, sourceLines, silenced)
    );
  }
  if (allowInlineSuppression && SUPPRESS_FILE.test(directiveView)) {
    return {
      findings,
      errorCount: findings.filter((f) => f.severity === "error").length,
      warnCount: findings.filter((f) => f.severity === "warn").length,
      suppressed: silenced,
      timedOut
    };
  }
  const suppressed = allowInlineSuppression ? suppressionsFor(directiveView.split("\n")) :   new Map();
  const wordCount = (masked.match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []).length;
  for (const rule of ruleSet.rules) {
    if (rule.severity === "off" || !rule.re) continue;
    if (rule.perThousandWords !== void 0) {
      const all = matchAllWithDeadline(rule.re, masked, deadline - Date.now());
      if (all === null) {
        timedOut.push(rule.id);
        continue;
      }
      const hits = all.filter((d) => d[0].length > 0);
      if (!hits.length || wordCount === 0) continue;
      const rate = hits.length / wordCount * 1e3;
      if (rate <= rule.perThousandWords) continue;
      const first = hits[0];
      const startAt = toSource(first.index);
      const { line, column } = locate(starts, startAt);
      const finding = {
        ruleId: rule.id,
        severity: rule.severity,
        match: text.slice(startAt, toSource(first.index + first[0].length - 1) + 1),
        line,
        column,
        lineText: sourceLines[line - 1] ?? "",
        message: `${hits.length} in ${wordCount} words is ${rate.toFixed(1)} per 1,000, over the ${rule.perThousandWords} threshold` + (rule.message ? `. ${rule.message}` : "")
      };
      if (rule.link) finding.link = rule.link;
      findings.push(finding);
      continue;
    }
    const matches = matchAllWithDeadline(rule.re, masked, deadline - Date.now());
    if (matches === null) {
      timedOut.push(rule.id);
      continue;
    }
    for (const m of matches) {
      if (m[0].length === 0) continue;
      const sourceStart = toSource(m.index);
      const sourceEnd = toSource(m.index + m[0].length - 1) + 1;
      const { line, column } = locate(starts, sourceStart);
      const maskedLine = maskedLines[line - 1] ?? "";
      const sourceLine = sourceLines[line - 1] ?? "";
      if (rule.unlessRe?.some((re) => re.test(maskedLine))) continue;
      const allowed = allowedBy(ruleSet, rule.id, maskedLine);
      if (allowed) {
        silenced.push({ pattern: allowed.entry.pattern, ruleId: rule.id, line });
        continue;
      }
      const sup = suppressed.get(line);
      if (sup === "all" || sup instanceof Set && sup.has(rule.id)) continue;
      const finding = {
        ruleId: rule.id,
        severity: rule.severity,
        match: text.slice(sourceStart, sourceEnd),
        line,
        column,
        lineText: sourceLine
      };
      if (rule.message) finding.message = rule.message;
      if (rule.link) finding.link = rule.link;
      findings.push(finding);
    }
  }
  findings.push(
    ...readabilityFindings(text, ruleSet, starts, sourceLines, suppressed, silenced)
  );
  const familyByRule = new Map([
    ...ruleSet.rules.map((rule) => [rule.id, rule.family]),
    ...ruleSet.readability.map((rule) => [rule.id, rule.family])
  ]);
  const sentenceRows = sentences(text);
  for (const family of ruleSet.families ?? []) {
    if (family.severity === "off") continue;
    const members = findings.filter((finding) => familyByRule.get(finding.ruleId) === family.id);
    if (members.length < family.minFindings) continue;
    const ruleIds = [...new Set(members.map((finding) => finding.ruleId))].sort();
    if (ruleIds.length < family.minRules) continue;
    const sentenceIds = new Set(members.map((finding) => {
      const offset = (starts[finding.line - 1] ?? 0) + finding.column - 1;
      return sentenceRows.findIndex((sentence) => offset >= sentence.start && offset < sentence.end);
    }).filter((id) => id >= 0));
    if (sentenceIds.size < family.minSentences) continue;
    const first = [...members].sort((a, b) => a.line - b.line || a.column - b.column)[0];
    const ruleId = `family-${family.id}`;
    const sup = suppressed.get(first.line);
    if (sup === "all" || sup instanceof Set && sup.has(ruleId)) continue;
    findings.push({
      ruleId,
      severity: family.severity,
      match: first.match,
      line: first.line,
      column: first.column,
      lineText: first.lineText,
      message: family.message ?? `${members.length} related findings form a repeated pattern.`,
      family: family.id,
      hitCount: members.length,
      relatedRuleIds: ruleIds
    });
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));
  return {
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warnCount: findings.filter((f) => f.severity === "warn").length,
    suppressed: silenced,
    timedOut
  };
}
var OPENERS = [
  { re: SUPPRESS_NEXT, scope: "line", idGroup: 1, reason: 2 },
  { re: SUPPRESS_FILE, scope: "file", idGroup: 0, reason: 1 },
  { re: SUPPRESS_RANGE_OFF, scope: "range", idGroup: 1, reason: 2 }
];
function directivesIn(text, view = maskNonProse(text)) {
  const out = [];
  view.split("\n").forEach((line, i) => {
    for (const opener of OPENERS) {
      const m = opener.re.exec(line);
      if (!m) continue;
      const reason = (m[opener.reason] ?? "").trim();
      const directive = {
        scope: opener.scope,
        ids: opener.idGroup ? (m[opener.idGroup] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [],
        line: i + 1,
        column: m.index + 1,
        text: m[0]
      };
      if (reason) directive.reason = reason;
      out.push(directive);
      return;
    }
  });
  return out;
}
function unexplainedSuppressions(text, directiveView, ruleSet, sourceLines, silenced) {
  const rule = (ruleSet.readability ?? []).find(
    (r) => r.kind === "unexplained-suppression"
  );
  if (!rule || rule.severity === "off") return [];
  const severity = rule.severity;
  const findings = [];
  for (const d of directivesIn(text, directiveView)) {
    if (d.reason) continue;
    const sourceLine = sourceLines[d.line - 1] ?? "";
    const allowed = allowedBy(ruleSet, rule.id, sourceLine);
    if (allowed) {
      silenced.push({ pattern: allowed.entry.pattern, ruleId: rule.id, line: d.line });
      continue;
    }
    const finding = {
      ruleId: rule.id,
      severity,
      match: d.text,
      line: d.line,
      column: d.column,
      lineText: sourceLine
    };
    if (rule.message) finding.message = rule.message;
    if (rule.link) finding.link = rule.link;
    findings.push(finding);
  }
  return findings;
}
function isGlossed(text, start, end) {
  const before = text.slice(Math.max(0, start - 60), start);
  const after = text.slice(end, end + 40);
  return /\b(called|named|known as|termed|dubbed|abbreviated|short for|stands for|an acronym for)\s+[("'`]?$/i.test(before) || /^[)"'`]?\s*(stands for|means|is short for)\b/i.test(after) || /^[)"'`]?\s*,\s*(which|meaning)\b/i.test(after) || /^\s*\(/.test(after) ||  
  /[a-z]\s*\(\s*$/.test(before);
}
function firstLineEnd(text) {
  const nl = text.indexOf("\n");
  return nl === -1 ? Math.min(text.length, 80) : Math.min(nl, 80);
}
function closingQuestion(masked) {
  const end = masked.replace(/\s+$/, "").length;
  if (end === 0 || masked[end - 1] !== "?") return null;
  let start = 0;
  for (let i = end - 2; i > 0; i--) {
    const c = masked[i];
    if (c === "." || c === "!" || c === "?" || c === "\n") {
      start = i + 1;
      break;
    }
  }
  const text = masked.slice(start, end).trim();
  if (!text) return null;
  return { text, start: start + (masked.slice(start, end).length - masked.slice(start, end).trimStart().length), end };
}
var SUBORDINATORS = /\b(whether|which|that|because|while|unless|although|so that|rather than|instead of|the same|as the|when the)\b/gi;
function subordinators(question) {
  const body = question.replace(/^(which|what|who|whose|how)\b/i, "");
  return (body.match(SUBORDINATORS) ?? []).length;
}
var IDENTIFIER_NAME = /(?:^|[\s"'(\[|`])((?:--?[a-z][a-z0-9-]{1,}|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+|[\w./~-]+\.[a-z]{2,4}|~?\/[\w./-]{3,}))(?=[\s"')\].,;:|`]|$)/gi;
function readabilityFindings(text, ruleSet, starts, sourceLines, suppressed, silenced) {
  const active = (ruleSet.readability ?? []).filter((r) => r.severity !== "off");
  if (!active.length) return [];
  const out = [];
  const add = (rule, start, end, message) => {
    const { line, column } = locate(starts, start);
    const sup = suppressed.get(line);
    if (sup === "all" || sup instanceof Set && sup.has(rule.id)) return;
    const finding = {
      ruleId: rule.id,
      severity: rule.severity,
      match: text.slice(start, end),
      line,
      column,
      lineText: sourceLines[line - 1] ?? ""
    };
    const msg = message ?? rule.message;
    if (msg) finding.message = msg;
    if (rule.link) finding.link = rule.link;
    out.push(finding);
  };
  for (const rule of active) {
    if (rule.kind === "reply-length") {
      const max = rule.maxWords ?? 250;
      let words = 0;
      for (const sentence of sentences(text)) words += sentence.words;
      if (words > max) {
        add(
          rule,
          0,
          Math.min(text.length, firstLineEnd(text)),
          `${words} words of prose, over ${max}.` + (rule.message ? ` ${rule.message}` : "")
        );
      }
      continue;
    }
    if (rule.kind === "reader-load") {
      const max = rule.maxTerms ?? 15;
      const names =   new Set();
      for (const declared of rule.names ?? []) {
        const literal = declared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, "u");
        if (pattern.test(text)) names.add(declared.toLowerCase());
      }
      for (const m of text.matchAll(/(?<!`)`([^`\n]{1,80})`(?!`)/g)) {
        const name = (m[1] ?? "").trim();
        if (name) names.add(name.toLowerCase());
      }
      for (const m of text.matchAll(IDENTIFIER_NAME)) {
        const name = (m[1] ?? "").trim().toLowerCase().replace(/[.,;:]+$/, "");
        if (name.length > 2) names.add(name);
      }
      if (names.size > max) {
        add(
          rule,
          0,
          Math.min(text.length, firstLineEnd(text)),
          `${names.size} separate names, over ${max}.` + (rule.message ? ` ${rule.message}` : "")
        );
      }
      continue;
    }
    if (rule.kind === "reply-pace") {
      const floor = rule.minWords ?? 80;
      const max = rule.maxMeanWords ?? 13;
      let words = 0;
      let count = 0;
      for (const sentence of sentences(text)) {
        words += sentence.words;
        count++;
      }
      if (count > 0 && words >= floor) {
        const mean = words / count;
        if (mean > max) {
          add(
            rule,
            0,
            Math.min(text.length, firstLineEnd(text)),
            `${mean.toFixed(1)} words a sentence on average, over ${max}.` + (rule.message ? ` ${rule.message}` : "")
          );
        }
      }
      continue;
    }
    if (rule.kind === "unreadable-ask") {
      const max = rule.maxWords ?? 15;
      const maxClauses = rule.maxClauses ?? 1;
      const ask = closingQuestion(maskNonProse(text));
      if (ask) {
        const words = (ask.text.match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []).length;
        const clauses = subordinators(ask.text);
        if (words > max || clauses > maxClauses) {
          const why = words > max ? `${words} words, over ${max}.` : `${clauses} clauses to unpack before it can be answered.`;
          add(rule, ask.start, ask.end, why + (rule.message ? ` ${rule.message}` : ""));
        }
      }
      continue;
    }
    if (rule.kind === "long-sentence") {
      const max = rule.maxWords ?? 35;
      for (const sentence of sentences(text)) {
        if (sentence.words <= max) continue;
        add(
          rule,
          sentence.start,
          sentence.end,
          `${sentence.words} words, over ${max}.` + (rule.message ? ` ${rule.message}` : "")
        );
      }
      continue;
    }
    if (rule.kind === "sentence-spread") {
      const floor = rule.minSentences ?? 20;
      const min = rule.minSpread ?? 0.45;
      const words = sentences(text).map((s) => s.words).filter((n) => n >= 3);
      if (words.length < floor) continue;
      const mean = words.reduce((a, b) => a + b, 0) / words.length;
      if (mean <= 0) continue;
      const sd = Math.sqrt(
        words.reduce((a, b) => a + (b - mean) ** 2, 0) / words.length
      );
      const spread = sd / mean;
      if (spread >= min) continue;
      add(
        rule,
        0,
        Math.min(text.length, firstLineEnd(text)),
        `sentence spread ${spread.toFixed(2)}, under ${min}.` + (rule.message ? ` ${rule.message}` : "")
      );
      continue;
    }
    if (rule.kind === "unglossed-term") {
      const seen =   new Set();
      const known = new Set((rule.known ?? []).map((k) => k.toLowerCase()));
      const emphasis = new Set((rule.emphasis ?? []).map((k) => k.toLowerCase()));
      for (const term of jargonTerms(text)) {
        const key = term.text.toLowerCase();
        if (known.has(key)) continue;
        if (emphasis.has(key) || isShoutedWord(term.text)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        const allowed = allowedBy(ruleSet, rule.id, term.text);
        if (allowed) {
          const { line } = locate(starts, term.start);
          silenced.push({ pattern: allowed.entry.pattern, ruleId: rule.id, line });
          continue;
        }
        if (isGlossed(text, term.start, term.end)) continue;
        add(rule, term.start, term.end, `"${term.text}" is not explained.` + (rule.message ? ` ${rule.message}` : ""));
      }
    }
  }
  return out;
}

function check(yamlText, text) {
  const set = compile(toRuleSet(parseSet(yamlText, "default.yml")));
  return lintText(text, set).findings.map((f) => f.ruleId + ":" + f.line + ":" + f.match);
}
export {
  check
};
