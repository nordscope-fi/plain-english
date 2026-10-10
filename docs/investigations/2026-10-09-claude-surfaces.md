# Plain English checking across Claude surfaces

> **Status:** this report records the state on 9 October 2026, at package
> 1.15.0. Two things have changed since. A live test on 10 October ran the
> bundled checker in Claude chat on the web and in the phone app, which settles
> the cloud-runtime question this report leaves open; the
> [result is on issue 130](https://github.com/nordscope-fi/plain-english/issues/130#issuecomment-6095687083).
> And change #137 moved the checker inside the mod, so the plugin no longer
> ships the separate command-line bundle the probe copies. The probe runs only
> from a checkout of `1573c61` on `main`, whose plugin and source match the
> commit named below.

This investigation supports [issue 130](https://github.com/nordscope-fi/plain-english/issues/130): making plain-english useful in Claude chat and Cowork as well as Claude Code. A portable skill can supply writing guidance and run the bundled checker on drafts. Cowork can load traditional hooks, but the current TypeScript mod is listed for Claude Code. A remote connector is an optional distribution and execution route, not a substitute for automatic enforcement.

The practical first step is a portable draft-checking skill with its own copy of the checker. Follow it with a Cowork hook probe. Keep the existing Code plugin intact while the portable package proves its behavior. Do not promise that a refused chat reply stays hidden: current Cowork reports describe the original reply appearing before its correction.

## Evidence and scope

The local probe uses package 1.15.0 at commit `39c0ad6b9875926484a3e4807dab4da5d8aa2b13`, Node `v26.10.0`, and Claude Code `2.1.295`. It relocates the committed bundle, submits synthetic inputs to it, and validates a temporary plugin. All 13 observations match their expected behavior. It makes no model request and does not install or publish a plugin.

These results establish local packaging and adapter behavior. They do not establish the runtime version in Claude chat, actual Cowork event delivery, or the visibility of refused replies. The source findings below distinguish Anthropic documentation from reports by users.

Reproduce the probe from the repository root:

```bash
node scripts/investigation/claude-surface-portability.mjs
```

The [probe](../../scripts/investigation/claude-surface-portability.mjs) writes [the observations](../../scripts/investigation/claude-surfaces-evidence-2026-10-09.json) and prints the temporary plugin location. That plugin uses the existing document skill unchanged, so validation is evidence about package structure, not a completed portable writing workflow.

## Supported components differ from the current plugin

Anthropic documents the following component support. Chat includes the web, desktop Chat tab, and mobile apps. The platform table describes Cowork as desktop tasks; newer Cowork guidance also covers cloud tasks on web and mobile.

| Component | Chat | Cowork | Claude Code |
| --- | --- | --- | --- |
| Skills | Loads | Loads | Loads |
| Markdown commands | Loads as skills | Explicit slash commands | Loads |
| Agents | Ignored | Loads | Loads |
| Traditional hooks | Ignored | Loads | Loads |
| Remote connector with a fixed URL | User connects it | User connects it | Loads |
| Local server | Plugin component ignored | Depends on local execution | Loads |
| Output styles | Ignored | Ignored | Loads |
| Current TypeScript mod | No equivalent documented | No equivalent documented | Listed for Code |

Source: [Plugin support across platforms](https://claude.com/docs/plugins/platform-support).

The current plugin has a `modules` entry pointing at `register.ts`. Anthropic states that the directory lists a mod for Claude Code. Ordinary hooks use a separate `hooks` object in the same configuration file. A file can contain both, but that schema permission does not establish that adding ordinary hooks changes the directory's supported-surface classification. [Plugin submission checklist](https://claude.com/docs/plugins/pre-submission-checklist#hooks-skills-commands-and-agents)

A portable package without a mod is the least ambiguous first release. The cost is a second plugin identity and installation. A combined package may be preferable later, once the portal shows the intended surfaces and live tests confirm which components load.

Account installation matters too. A command-line installation stays on its machine. Account-installed plugins can sync into Code, with account and version restrictions. Document both installation routes rather than implying that installing in Code enables the phone app. [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)

## Skills can shape replies without becoming standing instructions

Anthropic supports communication skills, including response tone and format. That makes a reply-guidance skill a supported use, rather than an attempt to repurpose a document skill. [Personalization features](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features)

Activation remains conditional. Claude reads the description and decides whether to load the skill. Account instructions cover every conversation; project instructions cover conversations in that project. A skill body saying it applies everywhere cannot force the host to load it everywhere. [What skills do](https://support.claude.com/en/articles/12512176-what-are-skills)

The existing document skill explicitly excludes chat and targets repository Markdown. It also assumes a checker already exists. Copying that skill unchanged into Claude apps would leave the central problem unresolved.

A portable writing skill should cover the actual tasks: answering a question, explaining a technical finding, drafting an email, writing a report, and reviewing supplied prose. Generate its guidance from the existing ruleset so the three Code styles and portable guidance do not become separately maintained policies. Keep document and reply modes distinct: a long report should not inherit the reply length limit.

For account-wide behavior, offer a short instruction users can add themselves, directing Claude to use plain-english for prose and to check substantial drafts. Do not change account settings through the plugin or describe conditional activation as guaranteed coverage. Explicit invocation remains the strongest available user control in chat. [Authoring skills](https://claude.com/docs/skills/how-to#decide-what-skill-to-create)

## The checker can travel inside a skill

Anthropic copies a skill's whole directory into chat's code execution environment. Scripts belong inside that directory, and their instructions need a path that remains readable relative to it. Code and Cowork support the skill-directory placeholder. Do not assume that a sibling plugin bundle reaches chat's sandbox. [Skill scripts](https://claude.com/docs/skills/how-to#add-scripts)

There is primary-source precedent for Node execution: Anthropic's own presentation skill uses Node scripts and a preinstalled JavaScript presentation library. That supports trying the current JavaScript checker first. It does not establish a guaranteed Node version of 20 or later on every account or surface. [Anthropic presentation skill](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md)

The API code execution reference describes a Python environment. It is a different product contract and should not be treated as proof that Claude apps either have or lack Node. [API code execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool#runtime-environment)

The relocation probe puts the bundle and its rules under the document skill's scripts directory. It runs from a separate project, without a package install. The checker still locates its rules and reports the correct package version. The temporary plugin contains 39 files, totaling 1,264,708 bytes; its largest file is 168,017 bytes. These are comfortably below the directory's 512-file and 256-KiB review thresholds. They are not a security approval.

The directory distinguishes a script that a skill tells Claude to run from a launcher executed automatically through a hook or server. The former is outside one program-following check. Other file and security checks still apply. The existing split bundle is therefore a useful starting point; embedding a compiled Node binary would introduce a binary review hold. [File and launcher checks](https://claude.com/docs/plugins/pre-submission-checklist#files-in-the-plugin-folder)

The first cloud probe should run the checker with package downloads disabled. Claude's file execution environment can have network access disabled while retaining its installed packages. A bundled checker avoids a dependency on package-manager access or a changing registry version. [File execution and network controls](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude)

## Local observations identify two adapter gaps

The probe makes these observations directly, using synthetic text:

| Observation | Result | What it establishes |
| --- | --- | --- |
| Relocated version command | Reports 1.15.0 | Bundle paths still resolve |
| Document draft containing three prohibited phrases | Three errors | Draft text can be checked through standard input |
| Clean draft | No findings | Control text is accepted |
| Same phrases inside a fenced example | No findings | Existing code masking survives relocation |
| Chat scan with draft text on standard input | No errors with no saved sessions | The chat scan does not check the supplied draft |
| Proposed Markdown write | Denial with the matching passage | The existing tool adapter can refuse a synthetic event |
| Clean Markdown write | No denial | The adapter accepts the control |
| Proposed Word-document write | No denial | Current document coverage does not include that format |
| Reply with prohibited opening and phrase | Continuation requested | The existing reply adapter produces a blocking response |
| Clean reply | Ends normally | Clean reply control works |
| Reply already being repaired | Ends with a notice | The current loop guard permits completion |
| Stop event without reply text | No output | Missing text does not produce an incomplete-check result |
| Traditional-hook package validation | Passes strict validation | Installed Code accepts the package structure |

The chat CLI currently scans saved conversations. Giving it a fresh draft does not turn it into a draft checker. A portable script needs a direct text entry point that selects the compiled chat rules, rather than using the existing chat scan command. The engine already supplies the required text-checking function.

A missing final reply also looks the same as an event that needs no action. That is acceptable for some host lifecycle events but insufficient for an explicitly requested draft check. Its response should distinguish completed checks, partial checks, invalid input, and an unavailable checker.

The Word-document observation tests extension routing with a synthetic write event; it does not create or parse a real Word file. It establishes that the Markdown adapter is not an office-document adapter. Check a generated document's prose before rendering, or extract the finished prose with a format-specific tool. Do not promise coverage of every file Claude creates from a Markdown-only hook.

## Cowork command hooks have stronger evidence than the original issue suggests

Anthropic documents traditional hooks in Cowork. There is also a useful cloud-session report whose initial diagnosis was corrected. The reporter first claimed that enabled plugin hooks never registered, then wrote:

> “Wrapping them under `"hooks"` fixed it”

The plugin had placed event names at the configuration's top level. The reporter retracted the platform-bug claim after wrapping them correctly. This supports the viability of command hooks in that cloud environment and shows why a plugin load check must precede enforcement claims. It is a user report from September 10, not our own live verification. [Retraction and corrected load result](https://github.com/anthropics/claude-code/issues/93264#issuecomment-5613779932)

Do not copy the earlier comment's workaround into the product. It rewrites a settings file and replaces its hooks with a merged set. The retraction makes that workaround unnecessary for the reported problem, and overwriting unrelated hooks would be an additional defect.

New Pro and Max tasks run in the cloud from October 6, 2026, while older local tasks remain local. Local connectors require the desktop app. Consequently, a local-only server is unsuitable as the primary route for independent mobile and cloud tasks. The newer guidance does not establish that every hook type and event in the Code reference works in Cowork. [Cowork execution changes](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)

A live Cowork probe should begin with a narrow observer and use only synthetic prose. Capture the actual event payload, run the checker, and confirm that a denied Markdown write leaves the file unchanged. Test clean writes, unknown tools, missing text, cancellation, and the next task in the same environment. Avoid a blanket denial hook: an August user report describes one blocking its own recovery actions. That report was closed for inactivity, which is not evidence of a shipped fix. [Reported recovery failure](https://github.com/anthropics/claude-code/issues/85581)

## Preventing a stop does not mean hiding the reply

The official hook contract says a blocking stop response prevents Claude from stopping. It does not promise to retract text already displayed. The current reply adapter therefore establishes continued correction, not necessarily prevention of the reader seeing the first attempt. [Stop decisions](https://code.claude.com/docs/en/hooks#stop-decision-control)

Two open September reports describe refused Cowork replies remaining visible before a rewrite. They are from the same reporter and should not be counted as independent confirmations. They nevertheless identify a concrete acceptance test that the documentation does not settle. [First report](https://github.com/anthropics/claude-code/issues/95461), [second report](https://github.com/anthropics/claude-code/issues/95465)

Use draft checking before the final response as the default user experience. A stop hook can provide a last correction attempt, with a bounded retry, but avoid advertising it as an invisible filter until the interface proves that behavior.

Code also has an event that transforms displayed message text. It is display-only, fails back to the original text, and does not change the transcript or the model's copy. Cowork support for that event is not established here. It is a possible later experiment, not a reason to promise hidden rejected drafts. [Displayed message transformations](https://code.claude.com/docs/en/hooks#messagedisplay)

## A remote connector reaches every surface but changes the service

A connector exposes tools from a server that receives requests from Claude, using the Model Context Protocol (MCP). A remote server can serve web, desktop, mobile, Cowork, and Code. Use a fixed HTTPS endpoint and Streamable HTTP. The plugin references it; users still connect it, and organization owners may need to enable it first. [Connector development](https://claude.com/docs/connectors/building), [Plugin connector setup](https://claude.com/docs/plugins/build#bundle-an-mcp-connector-with-its-skill)

A first tool should accept draft text, a document or reply channel, and explicit preferences. Return the quoted findings and whether every check completed. A digest of the input can identify which draft was checked, but cannot prove that Claude delivers that draft unchanged. Test the final text separately.

For replies, the caller should supply the user's request and the chosen writing level. The current reply judge can use the user's question to decide whether extra length was warranted. Plain pattern matching alone cannot reliably distinguish an unwanted long answer from depth the user requested.

The server should not discover a local project configuration or accept arbitrary local paths from the caller. A cloud request does not have the user's repository. Start with the bundled defaults and validated explicit preferences. Hosted profiles or account-wide vocabulary would be separate product features.

Remote MCP sampling is unsupported in Claude's connector client. A server cannot use that mechanism to ask the user's current session for a model judgment. Start with deterministic checks and let the conversation apply their hints. Independently judged meaning would need a separately operated model service, with its own cost and data handling. [Connector capabilities](https://claude.com/docs/connectors/building#decide-what-the-server-exposes)

This restriction does not mean every native hook lacks model evaluation. Code supports prompt-based hooks that evaluate an event using a model. Whether Cowork supports that hook type, and how it is billed, remain separate questions. Such a hook is also a different integration from the mod's session-model call. [Prompt hook fields](https://code.claude.com/docs/en/hooks#prompt-and-agent-hook-fields)

A connector is called when Claude chooses to use its tool. Chat ignores lifecycle hooks, so installing a connector does not enforce a check on every final reply. Code can call an MCP tool from a hook, making that call automatic there. Cowork compatibility of that hook type needs a live test. [MCP tool hooks](https://code.claude.com/docs/en/hooks#mcp-tool-hook-fields)

The service also receives the draft text, unlike the current local pattern checks. A stateless prototype can avoid sign-in, because unauthenticated servers are supported. A public release still needs a clear retention policy, bounded requests, and operating limits. OAuth is needed only when the product needs user identity or protected resources. [Authentication options](https://claude.com/docs/connectors/building/authentication#supported-authentication-types)

A custom connector can be tested before directory review. For a public directory listing, Anthropic instructs authors who operate a referenced remote server to submit that server separately as a connector as well as submitting the plugin. [Plugin submission](https://claude.com/docs/plugins/submit)

## Recommended sequence and acceptance criteria

1. **Portable guidance and draft checker.** Generate a companion skill, carry the runtime entirely inside it, and add a direct draft entry point for both channels. Require a visible incomplete-check result when runtime or input is missing. Cost: conditional activation and code execution overhead.
2. **Cowork command hooks.** Prove delivery of synthetic events and actual refusal of a write. Keep reply correction bounded and test what the reader sees. Cost: a second adapter path and compatibility checks as Cowork changes.
3. **Remote connector if needed.** Choose it when the skill runtime is unavailable or centralized execution is valuable. Cost: service operation, receiving drafts, and possibly identity management.
4. **Combined listing after validation.** Try a package containing both portable pieces and the current mod only after the separate package works. Cost: uncertain directory classification and possible duplicate checks if both routes load.

For a portable first release, require a compatible runtime on web, desktop chat, mobile chat, and cloud Cowork. It must work without downloading dependencies and activate for representative writing tasks. Explicit invocation must work when automatic activation fails, and editing must preserve clean drafts and the requested editing strength. Include short answers, requested long explanations, Markdown, an email, and prose destined for an office document.

Compare three conditions: no skill, guidance only, and guidance plus checking. Record whether the skill loaded, whether the checker ran, whether a rewrite was needed, whether the final text matches the checked draft, and the added elapsed time. A checker returning correct findings does not by itself establish an improved writing experience.

For Cowork enforcement, require unchanged target files after denials, clean actions that still work, no repeated refusal loop, and a visible notice on incomplete checking. Confirm the plugin loads at session start using the available plugin diagnostic. Do not infer successful loading from an enabled badge alone.

The current local probe supports the first implementation step. It leaves actual cloud-runtime execution, directory classification of mixed packages, and Cowork display behavior as the three material live checks.
