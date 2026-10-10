// Research probe for issue #130. No Claude model request is made.
// Copies the shipped checker into an isolated skill directory, then supplies
// synthetic drafts and hook events. This does not run a Cowork session.
// It needs integrations/claude-code-plugin/dist, which #137 removed. Run it
// from a checkout of 1573c61 (package 1.15.0), the commit it was written for.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'integrations/claude-code-plugin');
const work = mkdtempSync(join(tmpdir(), 'plain-english-130-'));
const plugin = join(work, 'plugin');
const skill = join(plugin, 'skills/writing-a-document');
const runtime = join(skill, 'scripts/runtime');
const project = join(work, 'project');
mkdirSync(runtime, { recursive: true });
mkdirSync(project);
mkdirSync(join(plugin, '.claude-plugin'));
mkdirSync(join(plugin, 'hooks'));
for (const path of ['dist', 'rules', 'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'])
  cpSync(join(source, path), join(runtime, path), { recursive: true });
cpSync(join(source, 'skills/writing-a-document/SKILL.md'), join(skill, 'SKILL.md'));
writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({
  name: 'plain-english-portability-probe', version: '0.0.0',
  description: 'Research fixture for checking the bundled linter in an isolated skill folder.',
  author: { name: 'NordScope' }, license: 'MIT',
}));
writeFileSync(join(project, '.plain-english.yml'),
  'version: 1\nextends: default\nfailOn: error\nmodelChecks: false\nchat:\n  failOn: error\n');
const entry = join(runtime, 'dist/cli.mjs');
const command = (channel) => 'node "${CLAUDE_PLUGIN_ROOT}/skills/writing-a-document/scripts/runtime/dist/cli.mjs" hook ' + channel + ' --agent claude-code';
writeFileSync(join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks: {
  PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|Bash', hooks: [{ type: 'command', command: command('docs'), timeout: 20 }] }],
  Stop: [{ hooks: [{ type: 'command', command: command('chat'), timeout: 60 }] }],
} }, null, 2));

const observations = [];
function run(name, args, input, accept) {
  const began = performance.now();
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: project, input, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PLAIN_ENGLISH_CWD: project, CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: join(work, 'empty-claude-settings') },
  });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { /* Empty hook output is allowed. */ }
  observations.push({ name, passed: accept(result, parsed), exitCode: result.status,
    elapsedMs: Math.round(performance.now() - began), stdout: result.stdout.trim(), stderr: result.stderr.trim() });
}
run('relocated CLI version', ['--version'], '', r => r.status === 0 && r.stdout.trim() === JSON.parse(readFileSync(join(source, 'package.json'))).version);
run('document draft findings', ['lint', '-', '--format', 'json', '--fail-on', 'error'],
  'Furthermore, leverage this seamless solution.', (r, p) => r.status === 1 && JSON.stringify(p).includes('leverage'));
run('clean document draft', ['lint', '-', '--format', 'json', '--fail-on', 'error'],
  'The build takes two minutes.', r => r.status === 0);
run('code example is masked', ['lint', '-', '--format', 'json', '--fail-on', 'error'],
  '```text\nFurthermore, leverage this seamless solution.\n```', r => r.status === 0);
run('chat lint scans saved sessions instead of the supplied draft', ['lint', '--chat', '--agent', 'claude-code', '--format', 'json'],
  'Great question. We leverage this approach.', (r,p) => r.status === 0 && p?.errorCount === 0);
const write = (content, name = 'draft.md') => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project,
  tool_name: 'Write', tool_input: { file_path: join(project, name), content } });
run('Markdown write denied', ['hook', 'docs', '--agent', 'claude-code'], write('We leverage this approach.'),
  (r,p) => p?.hookSpecificOutput?.permissionDecision === 'deny');
run('clean Markdown write allowed', ['hook', 'docs', '--agent', 'claude-code'], write('The build takes two minutes.'),
  (r,p) => r.status === 0 && p?.hookSpecificOutput?.permissionDecision !== 'deny');
run('Word document write is outside current coverage', ['hook', 'docs', '--agent', 'claude-code'], write('We leverage this approach.', 'draft.docx'),
  (r,p) => r.status === 0 && p?.hookSpecificOutput?.permissionDecision !== 'deny');
const stop = (text, active = false) => JSON.stringify({ hook_event_name: 'Stop', cwd: project,
  session_id: randomUUID(), prompt_id: randomUUID(), last_assistant_message: text, stop_hook_active: active });
run('reply finding requests continuation', ['hook', 'chat', '--agent', 'claude-code'], stop('Great question. We leverage this approach.'),
  (r,p) => p?.decision === 'block');
run('clean reply ends normally', ['hook', 'chat', '--agent', 'claude-code'], stop('The build takes two minutes.'),
  (r,p) => r.status === 0 && p?.decision !== 'block');
run('reply loop guard permits ending', ['hook', 'chat', '--agent', 'claude-code'], stop('Great question. We leverage this approach.', true),
  (r,p) => r.status === 0 && p?.decision !== 'block');
run('missing reply payload produces no check', ['hook', 'chat', '--agent', 'claude-code'], JSON.stringify({
  hook_event_name: 'Stop', cwd: project, session_id: randomUUID(), prompt_id: randomUUID(),
}), (r,p) => r.status === 0 && r.stdout.trim() === '');

const validate = spawnSync('claude', ['plugin', 'validate', '--strict', plugin], { encoding: 'utf8', timeout: 30000 });
observations.push({ name: 'traditional-hook plugin validates in installed Claude Code', passed: validate.status === 0,
  exitCode: validate.status, stdout: validate.stdout.trim(), stderr: validate.stderr.trim() });
const files = readdirSync(plugin, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .map(e => ({ path: join(e.parentPath, e.name).slice(plugin.length + 1), bytes: statSync(join(e.parentPath,e.name)).size }));
const evidence = {
  date: new Date().toISOString(), packageVersion: JSON.parse(readFileSync(join(root,'package.json'))).version,
  gitCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  nodeVersion: process.version, claudeVersion: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
  scope: 'Local relocation and synthetic event checks. No cloud session, model request, install, publication, or live Cowork event.',
  sourceEntrySha256: createHash('sha256').update(readFileSync(join(source,'dist/cli.mjs'))).digest('hex'),
  tempDirectory: work, fileCount: files.length, totalBytes: files.reduce((n,f) => n + f.bytes, 0),
  largestFile: files.sort((a,b) => b.bytes-a.bytes)[0], observations,
};
const output = join(root, 'scripts/investigation/claude-surfaces-evidence-2026-10-09.json');
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ passed: observations.filter(o=>o.passed).length, total: observations.length,
  fileCount: evidence.fileCount, totalBytes: evidence.totalBytes, largestFile: evidence.largestFile,
  failures: observations.filter(o=>!o.passed), evidence: output, fixture: work }));
if (observations.some(o => !o.passed)) process.exitCode = 1;
