from pathlib import Path
import subprocess

base = Path('/opt/boardly-clerk')
compose = base / 'compose.yml'
old = '    image: boardly-cloud:chatgpt-722810b'
new = '    image: boardly-cloud:stripe-20260910'
raw = compose.read_text()
if raw.count(old) != 1:
    raise SystemExit('Production image changed; inspect before deploying')
candidate = compose.with_name('compose.stripe-candidate.yml')
candidate.write_text(raw.replace(old, new, 1))
subprocess.run(['docker','compose','-f',str(candidate),'config','--quiet'], cwd=base, check=True)
candidate.replace(compose)
subprocess.run(['docker','compose','-f',str(compose),'up','-d','--no-deps','boardly'], cwd=base, check=True)
print('Only the Boardly web service was recreated with Stripe configuration.')
