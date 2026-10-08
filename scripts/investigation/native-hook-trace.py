import hashlib,json,os,pathlib,subprocess,sys,time

raw=sys.stdin.read()
try: payload=json.loads(raw)
except ValueError: payload={}
event=sys.argv[1]
root=pathlib.Path(os.environ['PE_NATIVE_FIXTURE'])
record={'event':event,'keys':sorted(payload),'tool':payload.get('tool_name') or payload.get('toolName'),'payload_hash':hashlib.sha256(raw.encode()).hexdigest()}
if len(sys.argv)>2:
 result=subprocess.run(sys.argv[2],shell=True,input=raw,capture_output=True,text=True)
 record['exit_code']=result.returncode
 try:
  reply=json.loads(result.stdout) if result.stdout.strip() else {}
 except ValueError: reply={}
 record['reply_keys']=sorted(reply)
 specific=reply.get('hookSpecificOutput',reply.get('hook_specific_output',{}))
 record['decision']=reply.get('decision',reply.get('permissionDecision',reply.get('permission',specific.get('permissionDecision'))))
 record['additional_context']=bool(reply.get('additionalContext') or reply.get('additional_context') or specific.get('additionalContext') or specific.get('additional_context'))
 record['rewrite_requested']=bool(reply.get('followup_message') or (event in ['Stop','stop','post_agent'] and reply.get('decision') in ['block','continue','deny']))
 record['has_reason']=bool(reply.get('reason') or reply.get('permissionDecisionReason') or specific.get('permissionDecisionReason'))
 record['stderr_hash']=hashlib.sha256(result.stderr.encode()).hexdigest() if result.stderr else None
 sys.stdout.write(result.stdout)
 sys.stderr.write(result.stderr)
directory=root/'event-metadata'
directory.mkdir(exist_ok=True)
(directory/f'{time.time_ns()}.json').write_text(json.dumps(record))
sys.exit(record.get('exit_code',0))
