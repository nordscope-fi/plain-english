#!/usr/bin/env node
/** Read a local JSONL corpus; write metrics and hashes, never source text. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sentences } from '../dist/sentences.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write('Usage: node scripts/measure-sentence-spread.mjs INPUT.jsonl OUTPUT.json\n');
  process.exitCode = 2;
} else {
  const seen = new Set();
  const measurements = readFileSync(input, 'utf8').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const row = JSON.parse(line);
    if (typeof row.text !== 'string' || !['human', 'machine', 'software'].includes(row.label)) throw new Error(`Invalid corpus row ${index + 1}.`);
    const sha256 = createHash('sha256').update(row.text).digest('hex');
    if (seen.has(sha256)) throw new Error(`Duplicate corpus text at row ${index + 1}.`);
    seen.add(sha256);
    const lengths = sentences(row.text).map(sentence => sentence.words).filter(count => count >= 3);
    const mean = lengths.reduce((sum, count) => sum + count, 0) / lengths.length;
    const spread = mean > 0 ? Math.sqrt(lengths.reduce((sum, count) => sum + (count - mean) ** 2, 0) / lengths.length) / mean : null;
    return { id: row.id ?? index, source: row.source, label: row.label, sha256, sentences: lengths.length, spread };
  });
  const thresholds = [.25, .30, .35, .40, .45, .50].map(threshold => ({ threshold, labels: Object.fromEntries(['human', 'machine', 'software'].map(label => {
    const eligible = measurements.filter(row => row.label === label && row.sentences >= 20);
    return [label, { eligible: eligible.length, flagged: eligible.filter(row => row.spread !== null && row.spread < threshold).length }];
  })) }));
  writeFileSync(output, JSON.stringify({ minSentences: 20, minimumSentenceWords: 3, thresholds, measurements }, null, 2) + '\n');
  process.stdout.write(`Measured ${measurements.length} distinct documents. Source text was omitted.\n`);
}
