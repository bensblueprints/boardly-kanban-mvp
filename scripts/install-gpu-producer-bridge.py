#!/usr/bin/env python3
"""Install the prompt claim bridge into the existing continuous Granny producer.

Stop only its supervisor before running this installer. Do not stop ComfyUI.
Start the supervisor and verify recovery before creating ROOT/.boardly-prompts/enabled.
The installer refuses an unfamiliar producer and preserves an exact backup.
"""
import argparse, ast, hashlib, os, pathlib, shutil

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('producer',type=pathlib.Path)
a=p.parse_args()
source=a.producer.read_text()
marker='boardly_prompt_bridge.claim(OUT,job)'
if marker in source:
    print('Prompt claim bridge already installed')
    raise SystemExit(0)
anchor="            folder=current.parent/job['id'];folder.mkdir(exist_ok=True);save(folder/'creative.json',job)"
assert source.count(anchor)==1,'Unrecognized producer; inspect it before adapting the patch'
assert source.count('save = daily.save')==1,'Missing producer import anchor'
modified=source.replace('save = daily.save',"save = daily.save\nbridge_spec = importlib.util.spec_from_file_location('boardly_prompt_bridge', Path(__file__).with_name('gpu-producer-claim.py'))\nboardly_prompt_bridge = importlib.util.module_from_spec(bridge_spec); bridge_spec.loader.exec_module(boardly_prompt_bridge)")
modified=modified.replace(anchor,'            '+marker+'\n'+anchor)
ast.parse(modified)
backup=a.producer.with_name(a.producer.name+'.before-boardly-'+hashlib.sha256(source.encode()).hexdigest()[:12])
if not backup.exists(): shutil.copy2(a.producer,backup)
shutil.copy2(pathlib.Path(__file__).with_name('gpu-producer-claim.py'),a.producer.with_name('gpu-producer-claim.py'))
temp=a.producer.with_suffix('.tmp');temp.write_text(modified);temp.chmod(a.producer.stat().st_mode);os.replace(temp,a.producer)
print('Installed prompt bridge; backup: '+str(backup))
