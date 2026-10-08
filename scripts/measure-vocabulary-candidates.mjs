#!/usr/bin/env node
/** Count held-back words in a local corpus, without persisting source prose. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { maskNonProse } from '../dist/mask.js';

const terms = ['surface', 'vector', 'primitive', 'features', 'enhance', 'crucial', 'seam', 'spine', 'ratchet', 'interplay', 'intricate', 'garner', 'enduring', 'haunted', 'sidecar', 'grooves'];
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write('Usage: node scripts/measure-vocabulary-candidates.mjs INPUT.jsonl OUTPUT.json\n');
  process.exitCode = 2;
} else {
  const documents = readFileSync(input, 'utf8').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const row = JSON.parse(line);
    if (typeof row.text !== 'string') throw new Error(`Missing text at row ${index + 1}.`);
    const prose = maskNonProse(row.text);
    const counts = Object.fromEntries(terms.map(term => [term, [...prose.matchAll(new RegExp(`\\b${term}\\b`, 'gi'))].length]));
    return { id: row.id ?? index, source: row.source, sha256: createHash('sha256').update(row.text).digest('hex'), counts };
  });
  const counts = Object.fromEntries(terms.map(term => [term, documents.reduce((sum, row) => sum + row.counts[term], 0)]));
  writeFileSync(output, JSON.stringify({ counts, documents }, null, 2) + '\n');
  process.stdout.write(`Counted ${terms.length} candidates in ${documents.length} documents. Source text was omitted.\n`);
}
