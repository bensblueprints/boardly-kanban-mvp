#!/usr/bin/env python3
"""Install a user-owned, tailnet-only Ollama service without changing app models."""
import os, pathlib, plistlib, subprocess
root=pathlib.Path.home()/'.local/share/boardly-ai'
root.mkdir(parents=True,exist_ok=True)
(root/'models').mkdir(exist_ok=True)
plist=pathlib.Path.home()/'Library/LaunchAgents/com.boardly.local-ai.plist'
plist.parent.mkdir(parents=True,exist_ok=True)
data={'Label':'com.boardly.local-ai','ProgramArguments':['/Applications/Ollama.app/Contents/Resources/ollama','serve'],
 'EnvironmentVariables':{'OLLAMA_HOST':'100.102.175.73:11435','OLLAMA_MODELS':str(root/'models'),
 'OLLAMA_NO_CLOUD':'true','OLLAMA_CONTEXT_LENGTH':'16384','OLLAMA_NUM_PARALLEL':'2',
 'OLLAMA_MAX_LOADED_MODELS':'1','OLLAMA_KEEP_ALIVE':'30m','OLLAMA_FLASH_ATTENTION':'1'},
 'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,
 'StandardOutPath':str(root/'server.log'),'StandardErrorPath':str(root/'server-error.log')}
if plist.exists(): raise SystemExit('Existing Boardly local AI service found; inspect before changing it')
plist.write_bytes(plistlib.dumps(data));plist.chmod(0o600)
subprocess.run(['launchctl','bootstrap','gui/'+str(os.getuid()),str(plist)],check=True)
print('Installed com.boardly.local-ai; original Ollama model path preserved')
