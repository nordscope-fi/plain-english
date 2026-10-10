// The plain-english skill's draft check (ADR-009). Claude runs it on a draft
// in chat or Cowork: the kind is the one argument, the draft arrives on
// standard input, and a JSON report goes to standard output. Exit 0 when the
// draft is clean, 1 when it has errors, 2 when it was not checked. It
// installs nothing, reads no file and opens no connection.

const kind = process.argv[2];

// Read only when the kind is valid, and stop waiting after 10 seconds. Input
// that never closes would otherwise hold the script until the caller's own
// timeout.
let text = "";
let readFailed = "";
if (!process.stdin.isTTY && (kind === "reply" || kind === "document")) {
  process.stdin.setEncoding("utf8");
  const timer = setTimeout(() => {
    readFailed = "Standard input did not close within 10 seconds. Save the draft to a file and redirect it in with <.";
    process.stdin.destroy();
  }, 10_000);
  try {
    for await (const chunk of process.stdin) text += chunk;
  } catch (error) {
    readFailed ||= `Standard input failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
}

let report;
try {
  const core = await import("./core/plugin-core.mjs");
  const { default: rules } = await import("./core/default-rules.mjs");
  const { default: version } = await import("./version.mjs");
  const nothing = () => undefined;
  const io = {
    cwd: "/",
    path: core.pathsFor("/"),
    env: {},
    home: undefined,
    now: () => Date.now(),
    notice: nothing,
    read: nothing,
    stat: nothing,
    list: nothing,
    state: { get: nothing, set: () => false },
    defaultRules: () => rules,
  };
  report = readFailed
    ? { status: "invalid", kind, findings: [], review: [], notes: [readFailed], version }
    : { ...core.checkDraft({ text, kind }, io), version };
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  report = { status: "unavailable", findings: [], review: [], notes: [`The checker did not load: ${reason}`] };
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exitCode = report.status !== "checked" ? 2 : report.findings.some((f) => f.severity === "error") ? 1 : 0;
