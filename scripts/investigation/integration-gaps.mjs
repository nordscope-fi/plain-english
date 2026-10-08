// <!-- plain-english-disable-file: executable fixtures deliberately contain rejected prose -->
// Audit reproductions. Run npm run build, then node scripts/investigation/integration-gaps.mjs.
// Uses synthetic text and a local Claude stand-in; never calls a real model.
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync,appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {compile,loadDefault,chatRuleSet} from '../../dist/rules.js';
import {lintText} from '../../dist/lint.js';
import {decideChat} from '../../dist/adapters/chat.js';
import {mergeFlat} from '../../dist/init.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {decide,extractFromBash} from '../../dist/adapters/hook.js';
import {byId} from '../../dist/agents/registry.js';
import {parseApplyPatch} from '../../dist/agents/fields.js';
const root=mkdtempSync(join(tmpdir(),'pe-repro-'));
const project=join(root,'project');mkdirSync(project);
writeFileSync(join(project,'.plain-english.yml'),'version: 1\nextends: default\nfailOn: error\nchat:\n  failOn: error\n');
const results=[];
function record(name,expected,actual,extra={}) {results.push({name,expected,actual,pass:JSON.stringify(expected)===JSON.stringify(actual),...extra});}
const bad='We leverage this approach.';
for (const [label,file] of [['relative-outside','../other.md'],['absolute-outside',join(root,'other.md')]]) {
 const d=decide({tool:'write',cwd:project,input:{filePath:file,content:bad}},'docs',{projectDir:project});
 record(label,'allow',d.decision,{rules:d.findings.map(f=>f.ruleId)});
}
mkdirSync(join(project,'sub'));
writeFileSync(join(project,'sub','msg.txt'),bad);
const previous=process.cwd();process.chdir(project);
for (const command of ['git commit -m "We leverage this approach."','git -C sub commit -m "We leverage this approach."','git commit -mWe\\ leverage\\ this\\ approach.','git commit --message="We leverage this approach."','cd sub && git commit -F msg.txt']) {
 const d=decide({tool:'bash',cwd:project,input:{command}},'github');
 record('commit '+command,'deny',d.decision,{extracted:extractFromBash(command)});
}
const wrong=join(root,'wrong');mkdirSync(wrong);
writeFileSync(join(project,'msg.txt'),bad);
process.chdir(wrong);
const d=decide({tool:'bash',cwd:project,input:{command:'git commit -F msg.txt'}},'github');
record('message file relative to event cwd','deny',d.decision);
process.chdir(previous);
for (const [from,to,want] of [['source.txt','notes.md','deny'],['notes.md','source.ts','allow']]) {
 const patch=`*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-old\n+${bad}\n*** End Patch`;
 const files=parseApplyPatch(patch);
 const d=decide({tool:'patch',cwd:project,input:{files}},'docs',{projectDir:project});
 record('rename '+from+' -> '+to,want,d.decision,{files});
}
const transcript=join(project,'cursor.jsonl');
writeFileSync(transcript,JSON.stringify({role:'assistant',message:{content:[{type:'text',text:'The result is ready — check it.'}]}})+'\n');
const cli=fileURLToPath(new URL('../../dist/cli.js',import.meta.url));
function hook(agent,channel,payload,env={},event='pre',cwd=project) {
 const p=spawnSync(process.execPath,[cli,'hook',channel,'--agent',agent,'--event',event],{input:JSON.stringify(payload),cwd,encoding:'utf8',env:{...process.env,PLAIN_ENGLISH_CHAT_JUDGE:'1',...env}});
 return {code:p.status,stdout:p.stdout,stderr:p.stderr};
}
for (const agent of ['cursor','vibe','gemini','qwen','copilot','codex']) {
 const payload=agent==='cursor'?{hook_event_name:'stop',conversation_id:'audit-chat',generation_id:'generation-1',workspace_roots:[project],transcript_path:transcript}:
 agent==='vibe'?{hook_event_name:'post_agent',cwd:project,session_id:'audit-vibe',transcript_path:join(project,'vibe.jsonl')}:
 agent==='gemini'?{hook_event_name:'AfterAgent',cwd:project,session_id:'audit-gemini',prompt_response:'The result is ready — check it.'}:
 agent==='copilot'?{hook_event_name:'Stop',cwd:project,session_id:'audit-copilot',transcript_path:join(project,'copilot.jsonl'),stop_hook_active:false}:
 {hook_event_name:'Stop',cwd:project,session_id:'audit-'+agent,last_assistant_message:'The result is ready — check it.',...(agent==='codex'?{turn_id:'turn-1'}:{prompt_id:'prompt-1'})};
 if(agent==='vibe')writeFileSync(payload.transcript_path,JSON.stringify({role:'user',content:'First user turn.',message_id:'user-1',injected:false})+'\n'+JSON.stringify({role:'assistant',content:'The result is ready — check it.'})+'\n');
 if(agent==='copilot')writeFileSync(payload.transcript_path,JSON.stringify({type:'user.message',data:{content:'First user turn.'}})+'\n'+JSON.stringify({type:'assistant.message',data:{content:'The result is ready — check it.'}})+'\n');
 const first=hook(agent,'chat',payload);
 if(agent==='cursor')payload.generation_id='generation-2';
 if(agent==='codex')payload.turn_id='turn-2';
 if(agent==='qwen')payload.prompt_id='prompt-2';
 if(agent==='gemini')payload.prompt='second turn';
 if(agent==='vibe')appendFileSync(payload.transcript_path,JSON.stringify({role:'user',content:'Second user turn.',message_id:'user-2',injected:false})+'\n'+JSON.stringify({role:'assistant',content:'The result is ready — check it.'})+'\n');
 if(agent==='copilot')appendFileSync(payload.transcript_path,JSON.stringify({type:'user.message',data:{content:'Second user turn.'}})+'\n'+JSON.stringify({type:'assistant.message',data:{content:'The result is ready — check it.'}})+'\n');
 const second=hook(agent,'chat',payload);
 const block=o=>!!o.stdout && (o.stdout.includes('"block"')||o.stdout.includes('"deny"')||o.stdout.includes('"followup_message"'));
 record(agent+' chat first turn',true,block(first),{first});
 record(agent+' chat second turn',true,block(second),{second});
}
// A stand-in records whether the common hook starts Claude; it never calls a model.
const bin=join(root,'bin');mkdirSync(bin);const marker=join(root,'judge-calls');
writeFileSync(join(bin,'claude'),'#!/usr/bin/env node\nimport("node:fs").then(fs=>{fs.appendFileSync(process.env.AUDIT_JUDGE_MARKER,"called\\n");console.log(JSON.stringify({ok:false,reason:"Explain the result before naming it."}));});\n',{mode:0o755});
for(const agent of ['copilot','codex','cursor','vibe','gemini','qwen']) {
 const tools={copilot:'Write',codex:'Write',cursor:'Write',vibe:'write_file',gemini:'write_file',qwen:'write_file'};
 const payload=agent==='codex'?{tool_name:'apply_patch',cwd:project,tool_input:{command:'*** Begin Patch\n*** Add File: clean.md\n+The cache holds results.\n*** End Patch'}}:{tool_name:tools[agent],cwd:project,tool_input:{file_path:join(project,'clean.md'),content:'The cache holds results.'}};
 const env={PLAIN_ENGLISH_CHAT_JUDGE:'0',PATH:bin+':'+process.env.PATH,AUDIT_JUDGE_MARKER:marker};
 const before=(()=>{try{return readFileSync(marker,'utf8').split('\n').length-1}catch{return 0}})();
 const output=hook(agent,'docs',payload,env);
 const after=(()=>{try{return readFileSync(marker,'utf8').split('\n').length-1}catch{return 0}})();
  record(agent+' shared docs hook starts Claude',false,after>before,{output});
}
const configPath=join(project,'.plain-english.yml');
const priorConfig=readFileSync(configPath,'utf8');
writeFileSync(configPath,priorConfig+'exclude:\n  - excluded.md\n');
const excluded=hook('codex','docs',{tool_name:'apply_patch',cwd:project,tool_input:{command:'*** Begin Patch\n*** Add File: excluded.md\n+The cache holds results.\n*** End Patch'}},{PLAIN_ENGLISH_CHAT_JUDGE:'0',PATH:bin+':'+process.env.PATH,AUDIT_JUDGE_MARKER:marker});
record('excluded document cannot be refused by shared judge',false,excluded.stdout.includes('"deny"'),{output:excluded});
writeFileSync(configPath,priorConfig);
// Markdown sent to the shell channel must not share GitHub acknowledgements.
writeFileSync(join(project,'.plain-english-ack-github'),'');
const ack=decide({tool:'bash',cwd:project,input:{command:'printf "%s\\n" "We leverage this approach." > notes.md'}},'github',{projectDir:project});
record('github ack also waives shell document writes','deny',ack.decision);


const rawPatch={hook_event_name:'PreToolUse',cwd:project,tool_name:'Edit',tool_input:'*** Begin Patch\n*** Add File: notes.md\n+We leverage this approach.\n*** End Patch\n'};
const copilotPatch=hook('copilot','docs',rawPatch);
record('live Copilot raw patch is checked',true,copilotPatch.stdout.includes('"deny"'),{output:copilotPatch});
const base=compile(loadDefault());base.chat.failOn='error';
const paced=Array.from({length:12},(_,i)=>`Step ${i} is `+Array.from({length:12},()=> 'done').join(' ')+'.').join(' ');
const warnings=lintText(paced,chatRuleSet(base)).findings;
const paceDecision=decideChat({text:paced,isSubagent:false,session:'pace',source:'fixture',line:1},{projectDir:project,ruleSet:base,promptId:'pace-check'});
record('warning-only chat stays advisory at error threshold','allow',paceDecision.decision,{findings:warnings.map(f=>({id:f.ruleId,severity:f.severity})),reason:paceDecision.reason});
const unrelated={type:'command',command:'node scripts/plain-english-summary.mjs'};
record('unrelated hook with package name survives reinstall',true,mergeFlat([unrelated],[]).includes(unrelated));
const suggestion='<'+ '!-'+'- plain-english-disable-next-line leverage -->\nWe leverage this approach.';
record('suggested suppression meets reason requirement',false,lintText(suggestion,base).findings.some(f=>f.ruleId==='unexplained-suppression'));
for(const agent of ['cursor','vibe','gemini']){
 const p=byId(agent);const rejected={allow:false,decision:'ask',findings:[],advisory:'Explain the result before naming it.',reason:'Explain the result before naming it.'};
 const pre=p.emit(rejected,'pre').stdout;
 const post=p.emit({allow:true,decision:'allow',findings:[]},'post').stdout;
 record(agent+' semantic advisory reaches pre or post',true,!!(pre||post));
}

for(const r of results)console.log((r.pass?'PASS':'GAP')+' '+r.name+' expected='+JSON.stringify(r.expected)+' actual='+JSON.stringify(r.actual));
console.log(JSON.stringify(results,null,2).replaceAll(root,'{{TMP}}'));
rmSync(root,{recursive:true,force:true});
