/**
 * Finding the files a shell command writes.
 *
 * Agents write prose through the shell. Asked to edit a markdown file, Copilot
 * CLI 1.0.78 ran:
 *
 *   printf '%s\n' "We leverage this approach." > notes.md && echo 'WROTE'
 *
 * That arrives as a `Bash` tool call, so a hook matching Write and Edit never
 * sees it, and the file lands unchecked.
 *
 * This is parsed with a scanner rather than a regex, for two reasons.
 *
 * Quoting cannot be done with a regex. `echo "see > README.md" >> log.txt`
 * redirects to a log file, and any pattern that reads the first `>` gets it
 * wrong. Getting it wrong is not free: under `failOn: error` a false positive
 * refuses a write that was never going to a file at all.
 *
 * And a scanner is linear by construction. The last hand-written pattern in the
 * hook path went quadratic and hung the agent for 200 seconds, so a new one
 * would have to earn its place.
 *
 * Deliberately narrow. It reads a trailing redirect on a simple command whose
 * content is visible in the command itself, and gives up on everything else:
 * `sed -i`, `cp`, `mv`, a path in a variable, content in a variable. Missing a
 * write costs a finding. Inventing one costs somebody their edit.
 */

/** A word, with whether any of it was quoted. */
interface Word {
  text: string;
  /** True when the word contained `$`, so its value is not knowable here. */
  expands: boolean;
}

interface Redirect {
  target: Word;
  /** A file-descriptor form such as `2>`, or `>&`, or `>(`. Never a plain write. */
  exotic: boolean;
}

interface Command {
  words: Word[];
  redirects: Redirect[];
  /** Bodies of every heredoc opened in this command. */
  heredocs: string[];
  /** Something was quoted or escaped in a way that makes the rest unsafe to read. */
  unterminated: boolean;
}

/** Native Windows paths use backslashes as separators, including attached file flags. */
function windowsPathPrefix(text: string): boolean {
  return /^(?:-[FC]|--(?:file|body-file|notes-file)=)?(?:[A-Za-z]:|\\\\)/.test(text);
}

const SEPARATORS = new Set([";", "\n", "&"]);

/**
 * Split a command line into simple commands, respecting quotes.
 *
 * One pass, one character at a time. Heredoc bodies are consumed whole so a
 * `>` or a `;` inside one is never mistaken for shell syntax.
 */
export function parseCommands(input: string): Command[] {
  const commands: Command[] = [];
  let current: Command = { words: [], redirects: [], heredocs: [], unterminated: false };
  let word = "";
  let quoted = false;
  let expands = false;
  let pendingRedirect: { exotic: boolean } | null = null;
  const pendingHeredocs: { tag: string; raw: boolean }[] = [];

  const endWord = () => {
    if (!word && !quoted) return;
    const w: Word = { text: word, expands };
    if (pendingRedirect) {
      current.redirects.push({ target: w, exotic: pendingRedirect.exotic });
      pendingRedirect = null;
    } else {
      current.words.push(w);
    }
    word = "";
    quoted = false;
    expands = false;
  };

  const endCommand = () => {
    endWord();
    if (current.words.length || current.redirects.length || current.heredocs.length) {
      commands.push(current);
    }
    current = { words: [], redirects: [], heredocs: [], unterminated: false };
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i]!;

    // A newline first collects any heredoc bodies opened on this line.
    if (c === "\n" && pendingHeredocs.length) {
      endWord();
      i++;
      for (const h of pendingHeredocs.splice(0)) {
        const body: string[] = [];
        let closed = false;
        while (i < input.length) {
          let nl = input.indexOf("\n", i);
          if (nl === -1) nl = input.length;
          const line = input.slice(i, nl);
          i = nl + 1;
          // `<<-` allows a tab-indented terminator, and only tabs.
          if ((h.raw ? line.replace(/^\t+/, "") : line.trim()) === h.tag) {
            closed = true;
            break;
          }
          body.push(line);
        }
        if (!closed) current.unterminated = true;
        current.heredocs.push(body.join("\n"));
      }
      continue;
    }

    if (c === "\\") {
      if (/^(?:-[FC]|--(?:file|body-file|notes-file)=)?$/.test(word) && input[i + 1] === "\\" && /[A-Za-z0-9]/.test(input[i + 2] ?? "")) {
        word += "\\\\";
        i += 2;
        continue;
      }
      if (windowsPathPrefix(word)) {
        word += c;
        i++;
        continue;
      }
      // A line continuation joins, anything else is a literal next character.
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < input.length) {
        word += input[i + 1];
        quoted = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (c === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) {
        current.unterminated = true;
        break;
      }
      word += input.slice(i + 1, close);
      quoted = true;
      i = close + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < input.length) {
        if (input[j] === "\\" && j + 1 < input.length) {
          if (!out && input[j + 1] === "\\" && /[A-Za-z0-9]/.test(input[j + 2] ?? "")) {
            out = "\\\\";
            j += 2;
          } else if (windowsPathPrefix(out)) {
            out += "\\";
            j++;
          } else {
            out += input[j + 1];
            j += 2;
          }
          continue;
        }
        if (input[j] === '"') {
          closed = true;
          break;
        }
        if (input[j] === "$") expands = true;
        out += input[j];
        j++;
      }
      if (!closed) {
        current.unterminated = true;
        break;
      }
      word += out;
      quoted = true;
      i = j + 1;
      continue;
    }

    if (c === "$") {
      expands = true;
      word += c;
      i++;
      continue;
    }

    if (c === "<" && input[i + 1] === "<") {
      // `<<<` is a here-string, not a heredoc.
      if (input[i + 2] === "<") {
        endWord();
        i += 3;
        continue;
      }
      endWord();
      let j = i + 2;
      const raw = input[j] === "-";
      if (raw) j++;
      while (input[j] === " " || input[j] === "\t") j++;
      let tag = "";
      let q = "";
      if (input[j] === "'" || input[j] === '"') {
        q = input[j]!;
        j++;
      }
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) tag += input[j++]!;
      if (q && input[j] === q) j++;
      if (tag) pendingHeredocs.push({ tag, raw });
      i = j;
      continue;
    }

    if (c === ">") {
      endWord();
      // `>>` appends, `>&` duplicates a descriptor, `>(` substitutes a process.
      let j = i + 1;
      let exotic = false;
      if (input[j] === ">") j++;
      if (input[j] === "&" || input[j] === "(") {
        exotic = true;
        j++;
      }
      // A digit immediately before is a file descriptor: `2> err`, `1>> out`.
      const prev = current.words[current.words.length - 1];
      if (prev && /^\d$/.test(prev.text) && !prev.expands) {
        current.words.pop();
        exotic = true;
      }
      pendingRedirect = { exotic };
      i = j;
      continue;
    }

    if (c === "<") {
      // An input redirect. Consume its target so it is not read as an argument.
      endWord();
      i++;
      while (i < input.length && /\s/.test(input[i]!)) i++;
      while (i < input.length && !/[\s;&|<>]/.test(input[i]!)) i++;
      continue;
    }

    if (c === "|") {
      endCommand();
      i += input[i + 1] === "|" ? 2 : 1;
      continue;
    }

    if (SEPARATORS.has(c)) {
      endCommand();
      i += input[i + 1] === c && c === "&" ? 2 : 1;
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }

    if (c === "(" || c === ")") {
      // Subshells and groupings. Treated as a boundary rather than parsed.
      endCommand();
      i++;
      continue;
    }

    word += c;
    i++;
  }

  endCommand();
  return commands;
}

/** Flags that carry no content, so a leading one is skipped rather than judged. */
const ECHO_FLAGS = new Set(["-e", "-n", "-E"]);

/**
 * A format string and nothing else, such as `'%s\n'`.
 *
 * `printf` takes one of these before its values. Judging it would be harmless
 * noise rather than a false positive, but it is noise in a refusal message a
 * human has to read.
 */
function isFormatOnly(s: string): boolean {
  return /^[\s%sdifgxbcqu\\n\\t.\-0-9]*$/.test(s) && /%|\\/.test(s);
}

/**
 * The text a command puts into a file, when that is knowable from the command.
 *
 * Returns nothing rather than guessing. `cat template.md > out.md` has content,
 * but it is in another file, and reading that file to judge it is a different
 * decision from reading a hook payload.
 */
function contentOf(cmd: Command): string {
  if (cmd.heredocs.length) return cmd.heredocs.join("\n");

  const name = cmd.words[0]?.text ?? "";
  if (name !== "printf" && name !== "echo") return "";

  const args = cmd.words.slice(1).filter((w) => !ECHO_FLAGS.has(w.text));
  // A value the shell would substitute is not readable here.
  if (args.some((a) => a.expands)) return "";

  const texts = args.map((a) => a.text);
  if (name === "printf" && texts.length > 1 && isFormatOnly(texts[0]!)) texts.shift();
  return texts.join(" ");
}

export interface ShellWrite {
  path: string;
  text: string;
}

/**
 * Files this command writes, with the text going into each.
 *
 * Only a plain trailing redirect whose content the command itself carries. The
 * caller applies the markdown, project-scope and exclude filters, exactly as it
 * does for a write arriving through a tool call.
 */
export function shellFileWrites(input: string, baseDir?: string): ShellWrite[] {
  const out: ShellWrite[] = [];
  let cwd = baseDir;

  for (const cmd of parseCommands(input)) {
    // A command whose quoting did not close cannot be read with confidence.
    if (cmd.unterminated) continue;
    if (cmd.words[0]?.text === "cd" && cwd !== undefined) {
      const target = cmd.words[1];
      if (target && !target.expands && cmd.words.length === 2) cwd = resolveDirectory(cwd, target.text);
      continue;
    }
    const targetPath = (path: string) => cwd === undefined ? path : resolveDirectory(cwd, path);

    const text = contentOf(cmd);
    if (!text.trim()) continue;

    // Descriptor forms sit alongside a real write all the time (`> x.md 2>&1`),
    // so they are ignored rather than treated as ambiguity. Two *plain*
    // redirects in one command is ambiguity, and gets nothing.
    const plain = cmd.redirects.filter((r) => !r.exotic && !r.target.expands && r.target.text);
    if (plain.length === 1) {
      out.push({ path: targetPath(plain[0]!.target.text), text });
      continue;
    }
    if (plain.length > 1) continue;

    // `tee notes.md <<EOF` writes through an argument rather than a redirect.
    // One file only: `tee a.md b.md` is a fan-out, and picking one would be a
    // guess about which the author meant.
    if (cmd.redirects.length) continue;
    if ((cmd.words[0]?.text ?? "") !== "tee") continue;
    const targets = cmd.words.slice(1).filter((w) => !w.text.startsWith("-"));
    if (targets.length !== 1 || targets[0]!.expands) continue;
    out.push({ path: targetPath(targets[0]!.text), text });
  }

  return out;
}

/** Lexical directory resolution without Node dependencies, also usable in mods. */
function resolveDirectory(base: string, path: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(base) || /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  const slash = windows ? "\\" : "/";
  const absolute = /^[A-Za-z]:[\\/]|^[\\/]/.test(path);
  const joined = absolute ? path : base + slash + path;
  const network = windows && joined.startsWith("\\\\");
  const prefix = network ? slash + slash : windows ? (/^[A-Za-z]:/.exec(joined)?.[0] ?? "") + slash : joined.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of joined.replace(/^[A-Za-z]:/, "").split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length > (network ? 2 : 0)) parts.pop(); }
    else parts.push(part);
  }
  return prefix + parts.join(slash);
}

/** A publishing command, with arguments after its subcommand and its directory. */
export interface PublishingCommand {
  args: Word[];
  cwd: string;
  heredocs: string[];
}

/** Git's global options before the subcommand, including directory selection. */
function gitCommand(cmd: Command, cwd: string): { subcommand: string; index: number; cwd: string } {
  let i = 1;
  while (i < cmd.words.length) {
    const option = cmd.words[i]!.text;
    if (!option.startsWith("-")) return { subcommand: option, index: i, cwd };
    if (option === "-C" || option === "-c" || option === "--git-dir" || option === "--work-tree") {
      const value = cmd.words[++i];
      if (!value || value.expands) return { subcommand: "", index: i, cwd };
      if (option === "-C") cwd = resolveDirectory(cwd, value.text);
    } else if (option.startsWith("-C") && option.length > 2) cwd = resolveDirectory(cwd, option.slice(2));
    i++;
  }
  return { subcommand: "", index: i, cwd };
}

/** Commands that carry commit, pull request, issue, or release prose. */
export function publishingCommands(input: string, baseDir = process.cwd()): PublishingCommand[] {
  const out: PublishingCommand[] = [];
  let cwd = baseDir;
  for (const cmd of parseCommands(input)) {
    if (cmd.unterminated || cmd.words[0]?.expands) continue;
    const name = cmd.words[0]?.text;
    if (name === "cd") {
      const target = cmd.words[1];
      if (target && !target.expands && cmd.words.length === 2) cwd = resolveDirectory(cwd, target.text);
      continue;
    }
    if (name === "git") {
      const git = gitCommand(cmd, cwd);
      if (git.subcommand === "commit") out.push({ args: cmd.words.slice(git.index + 1), cwd: git.cwd, heredocs: cmd.heredocs });
    } else if (name === "gh") {
      const kind = cmd.words[1]?.text;
      const action = cmd.words[2]?.text;
      const actions = kind === "pr" ? ["create", "edit", "comment", "review"]
        : kind === "issue" ? ["create", "edit", "comment"]
        : kind === "release" ? ["create", "edit"] : [];
      if (action && actions.includes(action)) out.push({ args: cmd.words.slice(3), cwd, heredocs: cmd.heredocs });
    }
  }
  return out;
}

/** Shared selection for callers that only need to know whether to run the checker. */
export function classifyShellCommand(input: string): "docs" | "github" | undefined {
  if (input.length > 256 * 1024) return undefined;
  if (publishingCommands(input, "").length) return "github";
  if (input.includes("*** Begin Patch") || shellFileWrites(input).some((f) => /\.(md|markdown|mdx)$/i.test(f.path))) return "docs";
  return undefined;
}
