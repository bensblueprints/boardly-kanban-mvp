#!/usr/bin/env python3
"""Private SSH adapter for Boardly. No listening port, model loading or shell actions.

Read existing queues; submit explicitly requested ComfyUI graphs with a durable
receipt before sending. A lost acknowledgement is reconciled, never resubmitted.
"""
import base64, concurrent.futures, contextlib, fcntl, hashlib, json, os, pathlib, sqlite3, subprocess, sys, time, urllib.error, urllib.request, uuid


def prompt_fields(graph):
    found = []
    for identity, node in graph.items():
        for key in ('prompt', 'text'):
            value = node.get('inputs', {}).get(key)
            if isinstance(value, str):
                found.append({'key': str(identity) + ':' + key, 'label': node.get('_meta', {}).get('title', node.get('class_type', 'Prompt')) + ' · ' + key, 'value': value})
    return found[:30]


def revision(fields):
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def changed_fields(fields, data):
    if data.get('revision') != revision(fields):
        raise ValueError('The prompt changed. Reload it before saving your edit.')
    changes = data.get('changes', {})
    if not changes or any(k not in {f['key'] for f in fields} for k in changes):
        raise ValueError('Choose an existing prompt field')
    if any(not isinstance(v, str) or not v.strip() or len(v) > 14000 for v in changes.values()):
        raise ValueError('Each prompt must contain 1–14,000 characters')
    return changes


def job_detail(config, data):
    identity = str(uuid.UUID(data['id']))
    editing = data['action'] == 'edit_job'
    directory = config.get('manifest_dir')
    if directory:
        root = pathlib.Path(directory)
        edits = root / '.boardly-prompts'
        for manifest in sorted(root.glob('*/manifest.json'), reverse=True)[:3]:
            rows = json.loads(manifest.read_text())
            job = next((j for j in rows if j.get('job_id') == identity), None)
            if not job: continue
            # Producer and editor share this lock. A durable claim closes the
            # edit window before the producer snapshots or submits the graph.
            supported = (edits / 'enabled').exists()
            if supported: lock = open(edits / '.lock', 'a')
            else: lock = contextlib.nullcontext()
            with lock as handle:
                if supported: fcntl.flock(handle, fcntl.LOCK_EX)
                row = next(j for j in json.loads(manifest.read_text()) if j.get('job_id') == identity)
                override = edits / (identity + '.json')
                if override.exists(): row.update(json.loads(override.read_text()).get('changes', {}))
                fields = [{'key':k,'label':label,'value':row.get(k,'')} for k,label in [('dialogue','Spoken script'),('visual','Scene and action'),('location','Adventure / location')]]
                editable = supported and row.get('status') == 'queued' and not (edits / (identity + '.claimed')).exists()
                if editing:
                    if not editable: raise ValueError('This producer job has already started, or its producer does not support prompt editing.')
                    changes = changed_fields(fields, data)
                    if 'dialogue' in changes and len(changes['dialogue'].split()) > 40: raise ValueError('Keep the 15-second spoken script to 40 words or fewer.')
                    previous = json.loads(override.read_text()).get('changes', {}) if override.exists() else {}
                    temp = edits / (identity + '.tmp')
                    with open(temp, 'w') as f:
                        json.dump({'changes':{**previous,**changes},'updated_at':time.time()},f);f.flush();os.fsync(f.fileno())
                    os.replace(temp,override)
                    for f in fields: f['value'] = changes.get(f['key'], f['value'])
                return {'id':identity,'source':'Granny producer','editable':editable,'fields':fields,'revision':revision(fields),'reason':None if editable else 'This job is already claimed for rendering.'}
    file = pathlib.Path.home() / '.local/share/boardly-gpu/queue.db'
    if file.exists():
        with sqlite3.connect(file.as_uri() + ('?mode=rw' if editing else '?mode=ro'), uri=True, timeout=3) as db:
            db.row_factory = sqlite3.Row
            if editing: db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM jobs WHERE id=?',(identity,)).fetchone()
            if row:
                graph=json.loads(row['workflow']);fields=prompt_fields(graph)
                editable=row['status'] in ('queued','waiting') and row['attempts']==0 and pathlib.Path(str(file)+'.prompt-edit-v1').exists()
                if editing:
                    if not editable: raise ValueError('This job has already been submitted to ComfyUI. Its prompt is locked.')
                    for key,value in changed_fields(fields,data).items():
                        node,name=key.split(':',1);graph[node]['inputs'][name]=value
                    raw=json.dumps(graph,sort_keys=True)
                    db.execute('UPDATE jobs SET workflow=?,fingerprint=?,updated_at=? WHERE id=?',(raw,hashlib.sha256(raw.encode()).hexdigest(),time.time(),identity))
                    fields=prompt_fields(graph)
                return {'id':identity,'source':'GPU queue','editable':editable,'fields':fields,'revision':revision(fields),'reason':None if editable else 'Already submitted; the render keeps its original prompt.'}
    if editing: raise ValueError('ComfyUI already owns this render; its prompt is locked after submission.')
    for port in config['ports']:
        try:
            queue=call(port,'/queue')
            item=next((j for j in queue.get('queue_running',[])+queue.get('queue_pending',[]) if j[1]==identity),None)
            if not item: item=call(port,'/history/'+identity).get(identity,{}).get('prompt')
            if item:
                fields=prompt_fields(item[2])
                return {'id':identity,'source':'ComfyUI','editable':False,'fields':fields,'revision':revision(fields),'reason':'ComfyUI already owns this render. Edit jobs before submission to keep an active render unchanged.'}
        except Exception: continue
    raise ValueError('This job is no longer in the recent queue or history.')


def call(port, route, body=None, timeout=4):
    request = urllib.request.Request('http://127.0.0.1:%d%s' % (port, route),
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(8_000_000))


def outputs(history):
    found = []
    for node in history.get('outputs', {}).values():
        for key in ('images', 'gifs', 'videos', 'audio'):
            for item in node.get(key, []):
                if isinstance(item, dict) and item.get('filename'):
                    found.append({k: item.get(k, '') for k in ('filename', 'subfolder', 'type')})
    return found[:12]


def engine(port):
    try:
        queue = call(port, '/queue')
        jobs = []
        for key, status in [('queue_running', 'running'), ('queue_pending', 'queued')]:
            for position, item in enumerate(queue.get(key, [])[:100]):
                jobs.append({'id': item[1], 'title': 'ComfyUI render', 'status': status,
                    'source': 'ComfyUI', 'port': port, 'position': position + 1, 'outputs': []})
        with contextlib.suppress(Exception):
            for identity, item in call(port, '/history?max_items=20').items():
                state = item.get('status', {})
                jobs.append({'id': identity, 'title': 'ComfyUI render',
                    'status': 'completed' if state.get('status_str') == 'success' else 'failed',
                    'source': 'ComfyUI', 'port': port, 'outputs': outputs(item)})
        return {'port': port, 'online': True, 'jobs': jobs}
    except Exception:
        return {'port': port, 'online': False, 'jobs': [], 'error': 'ComfyUI is not reachable on this port.'}


def local_jobs(config):
    jobs, errors = [], []
    file = pathlib.Path.home() / '.local/share/boardly-gpu/queue.db'
    if file.exists():
        try:
            with sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=2) as db:
                db.row_factory = sqlite3.Row
                for row in db.execute('SELECT id,status,error,created_at,updated_at,result FROM jobs ORDER BY created_at DESC LIMIT 100'):
                    job = dict(row)
                    result = json.loads(job.pop('result') or '{}')
                    jobs.append({**job, 'title': 'Saved GPU job', 'source': 'GPU queue', 'port': 8188, 'outputs': outputs(result)})
        except Exception:
            errors.append('The existing GPU queue database could not be read.')
    directory = config.get('manifest_dir')
    if directory:
        root = pathlib.Path(directory).expanduser()
        try:
            if not root.is_dir():
                raise ValueError('Missing directory')
            for file in sorted(root.glob('*/manifest.json'), reverse=True)[:3]:
                if file.stat().st_size > 2_000_000:
                    continue
                for position, row in enumerate(json.loads(file.read_text())[:100]):
                    override=root/'.boardly-prompts'/(row.get('job_id','')+'.json')
                    if override.exists(): row.update(json.loads(override.read_text()).get('changes',{}))
                    saved_outputs=[]
                    receipt=(file.parent/row['id']/'boardly-file.json').resolve()
                    if receipt.is_relative_to(file.parent.resolve()) and receipt.is_file():
                        saved=json.loads(receipt.read_text())
                        if isinstance(saved.get('id'),int) and isinstance(saved.get('name'),str):
                            saved_outputs=[{'name':saved['name'],'id':saved['id'],'url':'/api/project-files/'+str(saved['id'])+'/download'}]
                    jobs.append({'id': row.get('job_id', file.parent.name + row['id']),
                        'title': row.get('location', row['id']) + ' · ' + row.get('flavor', ''),
                        'status': 'published' if row.get('published') else {'rendering': 'running', 'rendered': 'completed', 'held': 'blocked'}.get(row.get('status'), row.get('status', 'queued')),
                        'source': 'Granny producer', 'position': position + 1, 'batch': file.parent.name,
                        'started_at': row.get('started_at'), 'outputs': saved_outputs, 'prompt': row.get('dialogue', ''),
                        'error': str(row.get('error', ''))[:500]})
        except Exception:
            errors.append('The producer manifest folder could not be read.')
    return jobs, errors


def snapshot(config):
    gpus = []
    try:
        raw = subprocess.check_output(['nvidia-smi', '--query-gpu=uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'], text=True, timeout=5)
        for line in raw.splitlines():
            values = [v.strip() for v in line.split(',')]
            def number(value):
                try: return float(value)
                except ValueError: return None
            gpus.append(dict(zip(['uuid', 'name', 'memory_total', 'memory_used', 'utilization', 'temperature'], values[:2] + [number(v) for v in values[2:]])))
    except Exception:
        pass
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        engines = list(pool.map(engine, config['ports']))
    jobs = {j['id']: j for e in engines for j in e['jobs']}
    local, errors = local_jobs(config)
    for job in local:
        prior = jobs.get(job['id'], {})
        jobs[job['id']] = {**prior, **job, 'port': prior.get('port', job.get('port')), 'outputs': job.get('outputs') or prior.get('outputs', [])}
    result = {'observed_at': int(time.time() * 1000), 'gpus': gpus, 'engines': [{k: v for k, v in e.items() if k != 'jobs'} for e in engines], 'jobs': list(jobs.values())[:180], 'warnings': errors}
    while len(json.dumps(result).encode()) > 65000 and result['jobs']:
        result['jobs'].pop()
        result['truncated'] = True
    return result


def render(config, data):
    identity = str(uuid.UUID(data['id']))
    port = data['port']
    if port not in config['ports']:
        raise ValueError('Choose a configured ComfyUI port')
    root = pathlib.Path.home() / '.local/share/boardly-gpu-workflows/receipts'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt = root / (identity + '.json')
    with open(root / '.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'queued', 'message': 'Another workflow is checking this GPU.'}
        history = call(port, '/history/' + identity).get(identity)
        if history:
            success = history.get('status', {}).get('status_str') == 'success'
            messages = history.get('status', {}).get('messages', [])
            error = next((m[1].get('exception_message', 'ComfyUI could not finish this step.') for m in messages if m[0] == 'execution_error'), None)
            return {'status': 'completed' if success else 'blocked', 'outputs': outputs(history), 'error': str(error or '')[:500]}
        all_items = []
        for other in config['ports']:
            try:
                queue = call(other, '/queue')
            except Exception:
                if other == port: raise
                continue
            for kind in ['queue_running', 'queue_pending']:
                for item in queue.get(kind, []):
                    if item[1] == identity:
                        return {'status': 'running' if kind == 'queue_running' else 'submitted', 'outputs': []}
                    all_items.append(item)
        if receipt.exists() or data.get('submitted'):
            return {'status': 'blocked', 'error': 'This submitted render is missing from ComfyUI. Check its output files before explicitly starting a new run; it has not been submitted again.'}
        pending, _ = local_jobs({})
        if all_items or any(j['status'] in ('queued', 'waiting', 'running', 'submitting') for j in pending):
            return {'status': 'queued', 'message': 'Waiting for existing GPU jobs to finish.'}
        workflow = data.get('workflow')
        if not isinstance(workflow, dict) or not workflow:
            raise ValueError('A ComfyUI API workflow is required')
        # Atomic durable receipt is committed before the external side effect.
        with open(receipt, 'x') as saved:
            json.dump({'id': identity, 'port': port, 'submitted_at': time.time()}, saved)
            saved.flush()
            os.fsync(saved.fileno())
        try:
            result = call(port, '/prompt', {'prompt_id': identity, 'prompt': workflow, 'client_id': 'boardly-gpu-workflows', 'extra_data': {'boardly_workflow_run': data['run_id']}}, timeout=12)
            if result.get('prompt_id') != identity:
                return {'status': 'blocked', 'error': 'ComfyUI returned another prompt ID. Inspect its queue before starting a new run.'}
            return {'status': 'submitted', 'outputs': []}
        except urllib.error.HTTPError as error:
            return {'status': 'blocked', 'error': 'ComfyUI rejected this template (HTTP %d). Check its models, nodes and inputs.' % error.code}


def main(data):
    os.umask(0o077)
    config = data['config']
    if data['action'] == 'snapshot': return snapshot(config)
    if data['action'] == 'render': return render(config, data)
    if data['action'] in ('job_detail', 'edit_job'): return job_detail(config,data)
    raise ValueError('Unknown GPU action')


if __name__ == '__main__':
    try:
        print(base64.b64encode(json.dumps(main(json.loads(base64.b64decode(sys.argv[1]))), separators=(',', ':')).encode()).decode())
    except Exception as error:
        print(base64.b64encode(json.dumps({'error': str(error)[:400]}).encode()).decode())
        sys.exit(1)
