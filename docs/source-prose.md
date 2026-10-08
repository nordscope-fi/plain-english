# Prose in TypeScript and React

Check customer-facing strings without checking the surrounding code:

```bash
plain-english lint src --source-prose --fail-on error
plain-english lint src/help.tsx --source-prose --format unix
```

The flag adds JavaScript and TypeScript files to directory scans. Markdown keeps
its existing checks. Without the flag, directory scans remain Markdown-only.
Project exclusions and declared vocabulary apply to both kinds of file.

## What gets checked

String values, untagged template fragments and visible React text are checked.
Text attributes include titles, alternate text, placeholders, accessible labels,
descriptions, labels and help text. Imports, property names, type declarations,
comments and regular expressions are skipped. React code and quoted blocks are
also skipped. Custom component properties outside the supported text attributes
remain outside coverage.

This is syntax-based extraction. It cannot establish whether every string is
shown to a customer. Choose the files that contain copy, and use project
vocabulary for technical terms in those files.

Fragments stay separate. Variable substitutions,
concatenation and translation lookups are not evaluated. Readability scores
describe those fragments, rather than a page assembled at runtime. The existing
Markdown rules still skip code and quotes inside extracted strings.

Escapes and character entities are decoded for checking. Findings quote the
original source spelling and point to its line and column. Editor output and
findings files use those source positions. Syntax errors return exit code 2.

An escaped character can occupy six characters in the source but one in the
displayed text, so the report quotes the escape and marks its full source span
for the editor.

The source is parsed with [Babel's JavaScript, TypeScript and React parser](https://babeljs.io/docs/babel-parser).
It is never run. React whitespace follows the [compiler's text handling](https://github.com/babel/babel/blob/main/packages/babel-types/src/utils/react/cleanJSXElementLiteralChild.ts).
Hooks check Markdown. This flag is for file linting.

## Use the helper

The package also exports extraction and checking helpers:

```js
import { readFileSync } from 'node:fs';
import { resolveRuleSet } from 'plain-english';
import { lintSourceText } from 'plain-english/source-prose';

const filename = 'src/help.tsx';
const result = lintSourceText(
  readFileSync(filename, 'utf8'),
  resolveRuleSet(process.cwd()),
  { filename },
);
console.log(result.findings);
```

Pass the filename so parsing selects the right syntax. Pipe source text into
`lint - --source-prose` to check standard input as TypeScript with React syntax.
