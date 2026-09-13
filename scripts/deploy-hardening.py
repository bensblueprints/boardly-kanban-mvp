from pathlib import Path
import json, shutil, subprocess, time, urllib.request

base=Path('/opt/boardly-clerk')
backup=base/'private-backups'/'billing-hardening-20260910'
backup.mkdir(mode=0o700,parents=True,exist_ok=True)
def run(*args):
    return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT)
def healthy(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz',timeout=5) as response:
        if response.status!=200: raise RuntimeError('Origin is not healthy')
def registered(name):
    for attempt in range(30):
        logs=run('docker','logs','--since','60s',name)
        if 'Registered tunnel connection' in logs: return
        time.sleep(1)
    raise RuntimeError('Tunnel did not register; existing replica retained')

mode=__import__('sys').argv[1]
if mode=='origin':
    healthy(5318)
    tunnel=base/'tunnel.yml';raw=tunnel.read_text()
    if raw.count('service: http://127.0.0.1:5317')!=1: raise RuntimeError('Origin configuration changed; inspect before applying')
    if not (backup/'tunnel.yml').exists(): shutil.copy2(tunnel,backup/'tunnel.yml')
    tunnel.write_text(raw.replace('service: http://127.0.0.1:5317','service: http://127.0.0.1:5318',1))
    print(run('docker','compose','-f',str(base/'compose.yml'),'run','-d','--no-deps','--name','boardly-tunnel-rollout','tunnel','tunnel','--config','/etc/cloudflared/config.yml','--no-autoupdate','--metrics','127.0.0.1:2151','run'),flush=True)
    registered('boardly-tunnel-rollout')
    print('Second tunnel replica registered against stable origin.',flush=True)
    print(run('docker','compose','-f',str(base/'compose.yml'),'up','-d','--no-deps','--force-recreate','tunnel'),flush=True)
    registered('boardly-clerk-tunnel')
    print(run('docker','stop','boardly-tunnel-rollout'),flush=True)
    print(run('docker','rm','boardly-tunnel-rollout'),flush=True)
    healthy(5318)
    print('Stable localhost proxy is now the public tunnel origin.',flush=True)
elif mode in ('app','account-status'):
    compose=base/'compose.yml';raw=compose.read_text()
    old='    image: boardly-cloud:'+('complimentary-seats-20260910' if mode=='app' else 'hardening-20260910');new='    image: boardly-cloud:'+('hardening-20260910' if mode=='app' else 'hardening-v2-20260910')
    if raw.count(old)!=1: raise RuntimeError('Production image changed; inspect before deploying')
    if not (backup/'compose.yml').exists(): shutil.copy2(compose,backup/'compose.yml')
    candidate=base/'compose.hardening-candidate.yml';candidate.write_text(raw.replace(old,new,1))
    run('docker','compose','-f',str(candidate),'config','--quiet')
    # Last check immediately before replacement. Do not interrupt user AI work.
    data=json.loads(run('docker','run','--rm','--read-only','-v',str(base/'data')+':/data:ro','-v',str(base/'hardening-20260910/scripts/billing-data-check.cjs')+':/app/check.cjs:ro','boardly-cloud:hardening-20260910','node','check.cjs'))
    if any(data['active_or_queued'].values()): raise RuntimeError('Active jobs found; defer deployment')
    candidate.replace(compose)
    print(run('docker','compose','-f',str(compose),'up','-d','--no-deps','boardly'),flush=True)
    for attempt in range(40):
        try: healthy(5318);break
        except Exception: time.sleep(1)
    else: raise RuntimeError('New app did not become healthy; rollback required')
    print('Billing and computer-assignment update is serving through the stable origin.',flush=True)
else: raise RuntimeError('Choose origin or app')
