# Editors, and why an agent cares

Editors show lint findings as squiggles and as rows in a Problems list. Several coding
agents read that list and treat what they find there as work to do. Claude Code's docs say
it sees errors and warnings immediately after each edit. Cursor, Cline and Copilot agent
mode all surface diagnostics from the same place VS Code does.

So wiring this into an editor is not only for the human sitting in front of it. It is a
route into an agent's correction loop that needs no adapter, and it keeps working when a
vendor changes their hook JSON.

## The format editors parse

```bash
plain-english lint docs --format unix
```

```
docs/adopting.md:12:1: error: Furthermore (furthermore) Start the sentence with its own point.
docs/adopting.md:12:17: warning: OIDC (unglossed-term) "OIDC" is not explained. Say what it does, then name it.
```

`path:line:col: level: message`, one finding per line. The default `text` format groups
findings under a filename heading, which reads better and parses worse.

## Neovim, Helix, Emacs, Sublime

[`efm-langserver`](https://github.com/mattn/efm-langserver) is a general-purpose language
server that turns any command with that output shape into diagnostics. This is most of
what a purpose-built language server would give you, for a config block.

```yaml
# ~/.config/efm-langserver/config.yaml
version: 2
tools:
  plain-english: &plain-english
    lint-command: "npx --no-install plain-english lint --format unix --fail-on warn"
    lint-stdin: false
    lint-formats:
      - "%f:%l:%c: %trror: %m"
      - "%f:%l:%c: %tarning: %m"

languages:
  markdown:
    - *plain-english
```

`lint-stdin: false` matters: the linter needs the real path to apply the project's
`exclude` list and to resolve `.plain-english.yml`.

`--fail-on warn` matters too. The default is `never`, which exits 0, and efm reads a
zero exit as nothing to report.

[`diagnostic-languageserver`](https://github.com/iamcco/diagnostic-languageserver),
`nvim-lint` and ALE (Asynchronous Lint Engine) all take the same two regular expressions.

## VS Code and the agents hosted in it

Two options, and the second is the interesting one.

**Run it as a task.** A problem matcher on the `unix` format puts findings in the Problems
panel like any other linter:

```jsonc
// .vscode/tasks.json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "plain-english",
      "type": "shell",
      "command": "npx --no-install plain-english lint . --format unix --fail-on warn",
      "problemMatcher": {
        "owner": "plain-english",
        "fileLocation": ["relative", "${workspaceFolder}"],
        "pattern": {
          "regexp": "^(.+):(\\d+):(\\d+): (error|warning): (.+)$",
          "file": 1, "line": 2, "column": 3, "severity": 4, "message": 5
        }
      }
    }
  ]
}
```

**Or produce SARIF (Static Analysis Results Interchange Format), the findings file both
editors and code scanners read, and let the SARIF extension render it.**

```bash
plain-english lint . --format sarif > plain-english.sarif
```

Microsoft's [SARIF Viewer](https://github.com/microsoft/sarif-vscode-extension) turns that
file into squiggles and Problems rows. The same file is what
`github/codeql-action/upload-sarif` wants, so one artifact serves the editor and the pull
request. The GitHub Action takes a `sarif-file` input for exactly this.

## Why there is no language server here

A real language server would be the highest-reach thing this package could ship: five or
more editors, Claude Code's built-in diagnostics client, and every VS Code-hosted agent,
with no configuration from the user at all. Vale and Harper both did it.

It is also a second binary, a document-synchronisation model, and a release surface that
never stops needing attention. The efm config above covers the same editors for a fraction
of that, so the server is a deliberate later decision rather than an oversight. If you
want one, say so in an issue; knowing somebody would use it is the missing input.
