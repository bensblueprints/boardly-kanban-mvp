"""Deploy the tested company AI release over the observed Boardly production image."""
import fcntl
import hashlib
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import time

os.umask(0o077)
root = pathlib.Path('/opt/boardly-clerk')
stage = pathlib.Path(sys.argv[1]).resolve()
assert stage.parent == root and stage.name.startswith('company-ai-')
manifest = json.loads((stage / 'release.json').read_text())
sha = manifest['sha']
assert len(sha) == 40 and all(c in '0123456789abcdef' for c in sha)
lock = open(root / 'release.lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

def run(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=240)

def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]

def file_hashes(container, paths):
    code = 'const fs=require("fs"),c=require("crypto");console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(p=>[p,c.createHash("sha256").update(fs.readFileSync("/app/"+p)).digest("hex")]))));'
    return json.loads(run(['docker', 'exec', container, 'node', '-e', code, json.dumps(paths)]))

base = inspect('boardly-clerk')
assert base['Config']['Image'] == manifest['base_image']
assert inspect(manifest['base_image'])['Id'] == base['Image'], 'Base image tag changed'
assert file_hashes('boardly-clerk', list(manifest['baseline'])) == manifest['baseline']
for name, digest in manifest['files'].items():
    assert hashlib.sha256((stage / name).read_bytes()).hexdigest() == digest, name
for name, digest in manifest['test_files'].items():
    assert hashlib.sha256((stage / name).read_bytes()).hexdigest() == digest, name
preserved = {name: inspect(name)['Id'] for name in ['boardly-chatgpt', 'boardly-cloud-worker', 'boardly-tailnet', 'boardly-clerk-tunnel']}
candidate = 'boardly-cloud:company-ai-' + sha[:7]
build = run(['docker', 'build', '--label', 'org.opencontainers.image.revision=' + sha, '-t', candidate, '-f', str(stage / 'Dockerfile.company-ai'), str(stage)])
(stage / 'build.log').write_text(build)
smoke = 'require("./server/company-ai");require("./server/cloud");const {createAIProviders}=require("./server/ai-providers");const D=require("better-sqlite3"),db=new D(":memory:");const p=createAIProviders({db,key:Buffer.alloc(32),account:()=>({mode:"none"}),setMode:()=>{}});if(p.publicState("probe","deepseek").label!=="DeepSeek")throw Error("DeepSeek missing");db.close();console.log("company AI candidate loaded");'
run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', candidate, '-e', smoke])
print('Built and smoke-tested company AI candidate.', flush=True)
for test in ['company-ai.js', 'ai-providers.js', 'chatgpt.js', 'swarms.js', 'runtime-recovery.js']:
    output = run(['docker', 'run', '--rm', '--network', 'none', '--mount', 'type=bind,src=' + str(stage / 'qa-test') + ',dst=/app/test,readonly', '--entrypoint', 'node', candidate, 'test/' + test])
    (stage / (test + '.log')).write_text(output)
    print(output.strip(), flush=True)

def recoverable_jobs():
    jobs = []
    for file in (root / 'data/workspaces').glob('*/app.db'):
        with sqlite3.connect(file.as_uri() + '?mode=ro', uri=True) as db:
            for table in ['chat_jobs', 'discussion_jobs']:
                if not db.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone():
                    continue
                if table == 'discussion_jobs':
                    assert not db.execute("SELECT 1 FROM discussion_jobs WHERE status IN ('queued','running','recovering') LIMIT 1").fetchone(), 'Active discussion; postpone deployment'
                    continue
                for jid, status, runtime, mode in db.execute('SELECT id,status,runtime,mode FROM ' + table + " WHERE status IN ('queued','running','recovering')"):
                    assert table == 'chat_jobs' and runtime == 'api' and mode == 'work', 'Non-recoverable active job; postpone deployment'
                    saved = db.execute('SELECT input_json FROM chat_run_checkpoints WHERE job_id=?', (jid,)).fetchone()
                    assert saved and saved[0], 'Active job has no checkpoint'
                    items = json.loads(saved[0])
                    outputs = {x.get('call_id') for x in items if x.get('type') == 'function_call_output'}
                    assert not any(x.get('type') == 'function_call' and x.get('call_id') not in outputs for x in items), 'Unfinished tool action; postpone deployment'
                    jobs.append({'id': jid, 'status': status, 'checkpoint_bytes': len(saved[0])})
    return jobs

jobs = recoverable_jobs()
compose = root / 'compose.yml'
before = compose.read_text()
assert before.count(manifest['base_image']) == 1
assert inspect('boardly-clerk')['Id'] == base['Id'], 'Production changed during build'
assert all(inspect(name)['Id'] == value for name, value in preserved.items())
backup = root / 'private-backups' / ('before-company-ai-' + sha[:7] + '-' + str(time.time_ns()))
backup.mkdir(mode=0o700)
for file in [*(root / 'data').glob('*.db'), *(root / 'data/workspaces').glob('*/app.db')]:
    destination = backup / file.relative_to(root / 'data')
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with sqlite3.connect(file.as_uri() + '?mode=ro', uri=True) as original, sqlite3.connect(destination) as saved:
        original.backup(saved)
(backup / 'compose.yml').write_text(before)
updated = before.replace(manifest['base_image'], candidate, 1)

def up():
    return run(['docker', 'compose', '-f', str(compose), 'up', '-d', '--no-deps', '--timeout', '90', 'boardly'])

def healthy():
    for _ in range(55):
        app = inspect('boardly-clerk')
        if app['State'].get('Health', {}).get('Status') == 'healthy':
            return app
        time.sleep(1)
    raise RuntimeError('Boardly health check timed out')

recoverable_jobs()
assert compose.read_text() == before
try:
    compose.write_text(updated)
    up()
    app = healthy()
    assert app['Config']['Image'] == candidate
    assert file_hashes('boardly-clerk', list(manifest['files'])) == manifest['files']
    assert all(inspect(name)['Id'] == value for name, value in preserved.items())
    result = {'sha': sha, 'image': candidate, 'healthy': True, 'backup': str(backup), 'checkpointed_jobs': jobs, 'other_services_preserved': True}
    (stage / 'deployment.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
except Exception:
    if compose.read_text() == updated:
        compose.write_text(before)
        up()
        healthy()
    raise
