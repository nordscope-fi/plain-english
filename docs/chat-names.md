# Count product names in chat replies

The chat name counter recognises filenames, flags and other names that look like
identifiers. It cannot infer whether an ordinary word names a product. A project
can declare the spellings that should also count:

```yaml
chat:
  limits:
    - id: reader-load
      severity: error
      names: [Cursor, Codex, Vibe]
```

Each declared name counts once, alongside the names already recognised by the
counter. Repeated references and a backticked version do not add to the count.
The threshold, severity and failure setting decide whether a finding holds a
reply or stays advisory. Set severity explicitly when customizing the limit.

Matching preserves casing and requires a boundary around the name. `Cursor`
counts, while lowercase `cursor` in ordinary prose and `Recursor` do not. A
project that declares lowercase `cursor` will count its ordinary uses too. This
setting declares names; it does not infer their meaning.

Declarations are literal text, not patterns. They may contain punctuation or
spaces. At most 128 names are accepted, each with up to 80 characters. Blank
names and control characters are refused as configuration errors.

A project's list replaces an inherited list. Use `names: []` to clear it.
No product list is supplied by default. Undeclared names remain the concern of
the optional model check, whose input includes what the reader asked.
