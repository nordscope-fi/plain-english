# Independent readability calibration

The sentence-spread rule is now off by default. The existing threshold remains
available to projects that deliberately want a constraint on sentence rhythm.
The public sample does not support treating it as an authorship or quality test.

## Sentence rhythm

The collection of labelled texts is called MAGE. Its [public dataset](https://huggingface.co/datasets/yaful/MAGE)
supplied 1,300 distinct texts: 500 machine-labelled and 800 human-labelled. Thirteen windows
of 100 rows were taken from the test split, beginning at offsets 0, 5,000 and
then every 5,000 through 60,000. Source ordering makes this a convenience sample.
It is neither random nor representative of current coding assistants.

The existing rule excludes sentences under three words and requires at least
20 remaining sentences. That leaves 58 machine-labelled and 173 human-labelled
texts. The eligible machine texts span eight recorded sources and several
generators. Source labels come from the dataset, rather than a new judgment of
the texts' authorship.

| Threshold | Machine-labelled texts flagged | Human-labelled texts flagged |
|---|---:|---:|
| 0.25 | 0 of 58 | 1 of 173 |
| 0.30 | 3 of 58 | 4 of 173 |
| 0.35 | 7 of 58 | 9 of 173 |
| 0.40 | 13 of 58 | 20 of 173 |
| 0.45 | 26 of 58 | 34 of 173 |
| 0.50 | 32 of 58 | 52 of 173 |

At 0.45, 44.8% of eligible machine-labelled texts and 19.7% of eligible
human-labelled texts produce findings. These are rule activity rates, not
measured editing value. Lowering the threshold also loses most machine findings.
The evidence supports removing the default warning, rather than claiming a new
calibrated boundary. Projects can still opt in:

```yaml
readability:
  - id: sentence-spread
    severity: warn
    minSpread: 0.45
    minSentences: 20
```

MAGE is described by Li and colleagues in [Machine-generated Text Detection in
the Wild](https://arxiv.org/abs/2305.13242), 2024. Its dataset card declares
Apache 2.0. This record stores row identifiers and content hashes, without
redistributing the texts. The samples use older model generations and include
continuation tasks, so they do not establish performance on today's replies.

## Held-back vocabulary

The software corpus contains 106 documents at fixed repository commits:
40 from the TypeScript website, 31 from Vite and 35 from Node.js. Every document
produced an opt-in, redacted recording through the package's recording helper.
These are replayed corpus fixtures, not live agent events.

| Candidate | Prose occurrences | Observed use |
|---|---:|---|
| features | 87 | Language and product capabilities |
| primitive | 27 | Language types and runtime values |
| vector | 19 | Cryptographic initialization and security terminology |
| surface | 5 | Public interfaces and exposing runtime information |
| crucial | 1 | A requirement for a type-safe implementation |

The other eleven candidates have no occurrences. Nothing in this sample
establishes an ornamental majority for any candidate, so no additional ban
ships. This is a decision about the proposed rules, rather than a claim that
those words are always useful. Reopen a candidate with evidence of a recurring
fault and exceptions that preserve its technical sense.

The candidate scan uses the existing prose mask and complete word matches.
Eight long Node.js documents exhausted the ordinary rule scan's match budget;
their recordings mark that incomplete scan. Candidate counts and sentence
measurements ran separately to completion and do not inherit that timeout.

## Reproduce the measurements

[measurements.json](measurements.json) records source URLs, pinned commits,
dataset row identifiers, content hashes, counts and each incomplete scan.
Fetch those public sources and verify their hashes before comparing results.
Dataset viewer rows can change; a changed hash is a different sample.

Build the package, then supply a local file with one structured object per line.
Each object has `id`, `source`, `label` and `text` fields. Labels are `human`,
`machine` or `software`.

```bash
npm run build
node scripts/measure-sentence-spread.mjs corpus.jsonl measurements.json
node scripts/measure-vocabulary-candidates.mjs software.jsonl candidates.json
```

The helper rejects duplicate texts and saves metrics without prose. Sampling,
short-sentence exclusions and source labels remain visible in the result.
