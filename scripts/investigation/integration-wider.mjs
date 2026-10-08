// <!-- plain-english-disable-file: audit fixtures deliberately contain rejected prose -->
// Run after npm run build. No real model, publishing request or global config write.
// Optional vendor oracle: --gemini-core=/absolute/path/to/the/installed/core-bundle.js
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {decide, extractFromBash} from '../../dist/adapters/hook.js';
import {decideChat} from '../../dist/adapters/chat.js';
import {byId} from '../../dist/agents/registry.js';
import {compile, loadDefault, chatRuleSet} from '../../dist/rules.js';
import {lintText} from '../../dist/lint.js';
import {cursorChat} from '../../dist/chat/cursor.js';
import {geminiChat, geminiHome} from '../../dist/chat/gemini.js';
import {parseApplyPatch} from '../../dist/agents/fields.js';

const root=mkdtempSync(join(tmpdir(),'pe-wider-'));
const cli=fileURLToPath(new URL('../../dist/cli.js',import.meta.url));
const bad='We leverage this approach.';
const results=[];
const agents=['copilot','codex','cursor','vibe','gemini','qwen'];
function record(name, expected, actual, evidence={}) {
 results.push({name, expected, actual, pass:JSON.stringify(expected)===JSON.stringify(actual), evidence});
}
function project(name, extra='') {
 const dir=join(root,name);mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'.plain-english.yml'),'version: 1\nextends: default\nfailOn: error\nchat:\n  failOn: error\n'+extra);
 return dir;
}
function run(args,cwd,input,env={}) {
 const out=spawnSync(process.execPath,[cli,...args],{cwd,input,encoding:'utf8',timeout:10000,env:{...process.env,PLAIN_ENGLISH_CHAT_JUDGE:'1',...env}});
 if(out.error)throw out.error;
 return {code:out.status,stdout:out.stdout,stderr:out.stderr};
}
function payload(agent,dir,path,text) {
 if(agent==='codex')return {tool_name:'apply_patch',cwd:dir,tool_input:{command:`*** Begin Patch\n*** Add File: ${path}\n+${text}\n*** End Patch`}};
 return {tool_name:agent==='copilot'||agent==='cursor'?'Write':'write_file',cwd:dir,tool_input:{file_path:path,content:text}};
}
try {
 // Independent controls for each installed adapter, without invoking its model.
 for(const agent of agents) {
  const dir=project('native-'+agent,'exclude:\n  - ignored.md\n');
  for(const [label,path,text,want] of [['bad','notes.md',bad,'deny'],['clean','notes.md','The cache holds results.','allow'],['source','source.ts',bad,'allow'],['excluded','ignored.md',bad,'allow']]) {
   const p=byId(agent);const parsed=p.parse(payload(agent,dir,path,text));
   const d=decide(parsed,'docs',{projectDir:dir});
   record(agent+' native '+label,want,d.decision,{normalised:parsed,findings:d.findings.map(f=>f.ruleId)});
  }
 }
 // Full init proves the collision occurs in the public command, not just a merge helper.
 for(const [agent,path,event,nested] of [['cursor','.cursor/hooks.json','preToolUse',false],['gemini','.gemini/settings.json','BeforeTool',true],['qwen','.qwen/settings.json','PreToolUse',true],['codex','.codex/hooks.json','PreToolUse',true]]) {
  const dir=project('init-'+agent);const target=join(dir,path);mkdirSync(join(target,'..'),{recursive:true});
  const unrelated={type:'command',command:'node scripts/plain-english-summary.mjs'};
  const control={type:'command',command:'node scripts/other-summary.mjs'};
  writeFileSync(target,JSON.stringify({version:1,hooks:{[event]:nested?[{matcher:'Write',hooks:[unrelated,control]}]:[unrelated,control]}}));
  const out=run(['init','--agent',agent,'--root',dir],dir);
  if(out.code!==0)throw new Error('init failed: '+out.stderr);
  const installed=readFileSync(target,'utf8');
  record(agent+' init preserves unrelated package-name hook',true,installed.includes(unrelated.command));
  record(agent+' init preserves ordinary unrelated hook',true,installed.includes(control.command));
  run(['init','--agent',agent,'--root',dir],dir);
  record(agent+' init remains idempotent',installed,readFileSync(target,'utf8'));
 }
 // Execute Git in a disposable repository to establish that bypassed spellings are valid.
 const git=project('git');mkdirSync(join(git,'sub'));
 const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'Audit',GIT_AUTHOR_EMAIL:'audit@example.invalid',GIT_COMMITTER_NAME:'Audit',GIT_COMMITTER_EMAIL:'audit@example.invalid'};
 const init=spawnSync('git',['init','--quiet'],{cwd:git,env:gitEnv});if(init.status!==0)throw new Error('git init failed');
 writeFileSync(join(git,'sub','message.txt'),bad);
 const commands=[
  ['plain','git commit --allow-empty -m "We leverage this approach."'],
  ['global directory option','git -C sub commit --allow-empty -m "We leverage this approach."'],
  ['attached short flag','git commit --allow-empty -mWe\\ leverage\\ this\\ approach.'],
  ['leading whitespace','  git commit --allow-empty -m "We leverage this approach."'],
  ['concatenated quoted argument','git commit --allow-empty -m "We "\'leverage this approach.\''],
  ['directory change','cd sub && git commit --allow-empty -F message.txt'],
 ];
 const prior=process.cwd();process.chdir(git);
 try {
  for(const [label,command] of commands) {
   const executed=spawnSync('/bin/sh',['-c',command],{cwd:git,env:gitEnv,encoding:'utf8'});
   const message=spawnSync('git',['log','-1','--format=%B'],{cwd:git,encoding:'utf8',env:gitEnv}).stdout.trim();
   if(executed.status!==0||message!==bad)throw new Error('invalid Git fixture: '+label);
   const d=decide({tool:'bash',cwd:git,input:{command}},'github');
   record('actual Git '+label,'deny',d.decision,{command,message,extracted:extractFromBash(command)});
  }
  const command='git commit --allow-empty -m "The cache holds results." && printf "%s\\n" -m "We leverage this approach."';
  spawnSync('/bin/sh',['-c',command],{cwd:git,env:gitEnv,encoding:'utf8'});
  const message=spawnSync('git',['log','-1','--format=%B'],{cwd:git,env:gitEnv,encoding:'utf8'}).stdout.trim();
  record('later unrelated command cannot poison clean commit','allow',decide({tool:'bash',cwd:git,input:{command}},'github').decision,{command,actualCommitMessage:message,extracted:extractFromBash(command)});
 } finally {process.chdir(prior);}
 // A literal shell redirect should use the destination reached after cd.
 const shell=project('shell','exclude:\n  - ignored/**\n');mkdirSync(join(shell,'ignored'));
 for(const [label,command,want] of [
  ['redirect control','printf "%s\\n" "We leverage this approach." > notes.md','deny'],
  ['excluded directory','cd ignored && printf "%s\\n" "We leverage this approach." > notes.md','allow'],
  ['printf formatting','printf "We lever%s this approach.\\n" age > formatted.md','deny'],
  ['printf format consumes extra values','printf "The cache holds results.\\n" "We leverage this approach." > clean.md','allow'],
 ]) {
  const execution=spawnSync('/bin/sh',['-c',command],{cwd:shell,encoding:'utf8'});if(execution.status!==0)throw new Error('invalid shell fixture');
  const path=label==='excluded directory'?'ignored/notes.md':label==='printf formatting'?'formatted.md':label==='printf format consumes extra values'?'clean.md':'notes.md';
  const actualText=readFileSync(join(shell,path),'utf8');
  record('actual shell '+label,want,decide({tool:'bash',cwd:shell,input:{command}},'github',{projectDir:shell}).decision,{command,actualText});
 }
 // Confirm independent acknowledgement channels in both directions.
 for(const ack of ['docs','github']) {
  const dir=project('ack-'+ack);writeFileSync(join(dir,'.plain-english-ack-'+ack),'');
  record(ack+' ack shell file',ack==='docs'?'allow':'deny',decide({tool:'bash',cwd:dir,input:{command:'printf "%s\\n" "We leverage this approach." > notes.md'}},'github',{projectDir:dir}).decision);
  record(ack+' ack commit',ack==='github'?'allow':'deny',decide({tool:'bash',cwd:dir,input:{command:'git commit -m "We leverage this approach."'}},'github',{projectDir:dir}).decision);
 }
 // Exercise warning-only fallback rather than assuming a missing judge is the only case.
 const paced=Array.from({length:12},(_,i)=>`Step ${i} is `+'done '.repeat(12).trim()+'.').join(' ');
 const base=compile(loadDefault());base.chat.failOn='error';
 record('warning-only fixture really contains only a warning',[['reply-pace','warn']],lintText(paced,chatRuleSet(base)).findings.map(f=>[f.ruleId,f.severity]));
 for(const [label,judge] of [['absent',undefined],['undefined verdict',()=>undefined],['passing verdict',()=>({ok:true})]]) {
  const dir=project('warning-'+label.replaceAll(' ','-'));
  const d=decideChat({text:paced,isSubagent:false,session:label,source:'fixture',line:1},{projectDir:dir,ruleSet:base,promptId:label,judge});
  record('warning at error threshold '+label,'allow',d.decision,{reason:d.reason});
 }
 // Cursor's history hint must distinguish neighbouring repositories.
 const cursorRoot=join(root,'cursor-home');process.env.CURSOR_HOME=cursorRoot;
 const requested=join(root,'workspace','repo');
 const sibling=requested+'-other';
 const flattened=p=>p.replace(/^\//,'').replace(/[/.]/g,'-');
 for(const [i,p] of [requested,sibling].entries()) {
  const path=join(cursorRoot,'projects',flattened(p),'agent-transcripts','session-'+i);mkdirSync(path,{recursive:true});
  writeFileSync(join(path,'session-'+i+'.jsonl'),JSON.stringify({role:'assistant',message:{content:[{type:'text',text:i===0?'Inside the requested repository.':'From the neighbouring repository.'}]}})+'\n');
 }
 const read=cursorChat.read({cwd:requested});
 record('Cursor history excludes sibling project',['Inside the requested repository.'],read.map(r=>r.text));
 // Default GEMINI_CLI_HOME represents a home, even if its basename is .gemini.
 process.env.GEMINI_CLI_HOME=join(root,'custom','.gemini');
 record('Gemini home override follows vendor semantics',join(process.env.GEMINI_CLI_HOME,'.gemini'),geminiHome());
 // Native Gemini history uses update/rewind records. Compare against its own loader if provided.
 const vendorPath=process.argv.find(a=>a.startsWith('--gemini-core='))?.slice('--gemini-core='.length);
 if(vendorPath) {
  const vendor=await import(vendorPath);
  async function discover(dir) {
   // The vendor logs discovery to stdout; keep the audit's JSON stream parseable.
   const write=process.stdout.write;process.stdout.write=()=>true;
   try {return await vendor.getEnvironmentMemoryPaths([dir]);}
   finally {process.stdout.write=write;}
  }
  const home=join(root,'gemini-home');process.env.GEMINI_CLI_HOME=home;
  const chats=join(home,'.gemini','tmp','audit-project','chats');mkdirSync(chats,{recursive:true});
  writeFileSync(join(home,'.gemini','projects.json'),JSON.stringify({projects:{[requested]:'audit-project'}}));
  const metadata={sessionId:'audit-session',projectHash:'audit-project',startTime:new Date().toISOString()};
  const old={id:'message-1',type:'gemini',content:'Abandoned response.'};
  const updated={...old,content:'The corrected response.'};
  const abandoned={id:'message-2',type:'gemini',content:bad};
  const path=join(chats,'session-audit.jsonl');
  writeFileSync(path,[metadata,old,updated,abandoned,{$rewindTo:'message-2'}].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const native=await vendor.loadConversationRecord(path);
  const expected=native.messages.filter(m=>m.type==='gemini').map(m=>m.content);
  record('Gemini history agrees with native update and rewind',expected,geminiChat.read({cwd:requested}).map(r=>r.text));
  record('Gemini fallback stop ignores abandoned response',expected.at(-1),geminiChat.current({transcript_path:path,session_id:'audit-session'})?.text);
  const legacy=join(chats,'session-legacy.json');
  writeFileSync(legacy,JSON.stringify({...metadata,messages:[{id:'legacy-message',type:'gemini',content:'A retained legacy response.'}]}));
  const nativeLegacy=await vendor.loadConversationRecord(legacy);
  record('Gemini retained legacy history is readable',true,geminiChat.read({cwd:requested}).some(r=>r.text===nativeLegacy.messages[0].content));
  const generated=join(root,'init-gemini');
  vendor.resetGeminiMdFilename();
  record('Gemini native loader discovers generated guidance',true,(await discover(generated)).some(p=>p.endsWith('/AGENTS.md')));
  vendor.setGeminiMdFilename('AGENTS.md');
  record('Gemini configured filename discovery control',true,(await discover(generated)).some(p=>p.endsWith('/AGENTS.md')));
  vendor.resetGeminiMdFilename();
  process.env.GEMINI_CLI_HOME=join(root,'custom','.gemini');
  record('Gemini override disagrees with native storage',vendor.Storage.getGlobalGeminiDir(),geminiHome());
 }
 // Host-generated MCP names must reach the configured issue matcher.
 const cursorPlan=byId('cursor').plan({prompts:{},ruleSet:base});
 const issue=cursorPlan.config.find(c=>c.at.at(-1)==='preToolUse').entries.find(e=>e.command.includes('hook issue'));
 record('Cursor native MCP issue name matches hook',true,new RegExp(issue.matcher).test('MCP:save_issue'),{matcher:issue.matcher,nativeName:'MCP:save_issue'});
 // SARIF production must honor the action threshold independently of local defaults.
 const action=project('action');writeFileSync(join(action,'notes.md'),bad);
 const sarif=run(['lint','notes.md','--format','sarif'],action);
 record('SARIF step cannot veto requested advisory action',0,sarif.code,{findings:JSON.parse(sarif.stdout).runs[0].results.length});
 const main=run(['lint','notes.md','--format','github','--fail-on','never'],action);
 record('action main step advisory control',0,main.code);
 // Run both semantic events through the actual CLI with a harmless stand-in.
 const bin=join(root,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'claude'),'#!/bin/sh\nprintf \'%s\' \'{"ok":false,"reason":"Lead with the point."}\'\n',{mode:0o755});
 for(const agent of ['cursor','gemini','vibe']) {
  const dir=project('semantic-'+agent);
  writeFileSync(join(dir,'.plain-english.yml'),'version: 1\nextends: default\nfailOn: never\n');
  const p=payload(agent,dir,'clean.md','The cache holds results.');
  const env={PLAIN_ENGLISH_CHAT_JUDGE:'0',PATH:bin+':'+process.env.PATH};
  const pre=run(['hook','docs','--agent',agent,'--event','pre'],dir,JSON.stringify(p),env);
  const post=run(['hook','docs','--agent',agent,'--event','post'],dir,JSON.stringify(p),env);
  record(agent+' semantic-only advice survives full CLI',true,!!(pre.stdout||post.stdout),{pre,post});
  const badPayload=payload(agent,dir,'notes.md',bad);
  const control=run(['hook','docs','--agent',agent,'--event','post'],dir,JSON.stringify(badPayload));
  record(agent+' deterministic post advice control',true,control.stdout.includes('leverage'));
 }
 // Pure rename without added text publishes pre-existing prose under a new Markdown name.
 const moved=project('move-only');
 const patch='*** Begin Patch\n*** Update File: source.txt\n*** Move to: notes.md\n@@\n We leverage this approach.\n*** End Patch';
 writeFileSync(join(moved,'source.txt'),bad+'\n');
 const parsed=parseApplyPatch(patch);
 record('rename with no additions is documented coverage limit',[],parsed.map(f=>f.text).filter(Boolean));
} finally {
 rmSync(root,{recursive:true,force:true});
}
const clean=JSON.parse(JSON.stringify(results).replaceAll(root,'{{TMP}}'));
if(process.argv.includes('--json')) console.log(JSON.stringify(clean,null,2));
else {
 for(const r of clean)console.log(`${r.pass?'PASS':'GAP'} ${r.name}`);
 console.log(JSON.stringify({probes:clean.length,pass:clean.filter(r=>r.pass).length,gap:clean.filter(r=>!r.pass).length}));
}
