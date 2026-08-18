---
description: Live documentation lookup. Use Context7 MCP before writing code that touches third-party library APIs, and as a fallback when WebFetch on official docs returns errors.
globs: "src/**,test/**,scripts/**"
---

# Context7 — Live Documentation Lookup

Context7 MCP fetches current, version-specific library documentation.
Use it proactively; do not rely on training data for library APIs.

## Rule: use Context7 when working with library APIs

When implementing, configuring, or debugging code that uses a third-party
library API, fetch current documentation before writing code. Training
data drifts; libraries change between minor versions.

Also use Context7 as a docs reader of last resort when `WebFetch` on an
official documentation site returns 404 or other errors. Vendor sites
are often flaky; Context7 indexes rendered content and bypasses the live
site entirely.

## When to use

- Writing code that calls library-specific APIs
- Unsure about a signature, parameter, return type, or configuration
- The user mentions a specific library version
- Configuring build tools (`tsc`, `vitest` plugins and options)
- Any time `WebFetch` to an official docs site returns 404

## When to skip

- Basic TypeScript/Node patterns
- Simple edits that do not involve library APIs
- Refactoring with no new library usage
- Code that only uses project-internal modules

## How to call

1. Load tools: `ToolSearch("context7")` (loads both `resolve-library-id`
   and `query-docs`)
2. Resolve: `resolve-library-id` with a library name and your question
3. Query: `query-docs` with the resolved library ID and specific topic

Skip step 2 if you already know the library ID from a previous call in
the same session.

## Project library search terms

| Library | Search term | Typical queries |
|---|---|---|
| Node built-ins | `node` | fs, path, url, os APIs by version |
| TypeScript | `typescript` | tsconfig options, compiler API |
| Vitest | `vitest` | Config, mocking, test utilities, matchers |
| Zod | `zod` | Schema definitions, refinements |
| YAML | `js-yaml` | Load/dump, schema options, safe modes |

Add rows as the dependency set grows.
