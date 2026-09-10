from pathlib import Path
import subprocess

base=Path('/opt/boardly-clerk')
compose=base/'compose.yml'
raw=compose.read_text()
old='    image: boardly-cloud:stripe-20260910'
new='    image: boardly-cloud:complimentary-seats-20260910'
if raw.count(old)!=1:
    raise SystemExit('Production image changed; inspect before deploying')
backup=base/'private-backups'/'complimentary-seats-20260910'
backup.mkdir(mode=0o700,parents=True,exist_ok=True)
saved=backup/'compose.yml'
if not saved.exists():
    saved.write_text(raw)
    saved.chmod(0o600)
candidate=base/'compose.complimentary-candidate.yml'
candidate.write_text(raw.replace(old,new,1))
subprocess.run(['docker','compose','-f',str(candidate),'config','--quiet'],cwd=base,check=True)
candidate.replace(compose)
subprocess.run(['docker','compose','-f',str(compose),'up','-d','--no-deps','boardly'],cwd=base,check=True)
print('Complimentary-seat support deployed to the web service only.')
