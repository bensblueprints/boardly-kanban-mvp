#!/usr/bin/env python3
"""Durable queue for trusted local ComfyUI workflows, independent of AI credits.

Submit over the machine's existing SSH connection. No public listener, model
credentials or paid provider integration. The worker polls even without a chat.
"""
import argparse, contextlib, fcntl, hashlib, json, os, pathlib, signal, sqlite3, time, urllib.request, urllib.error, uuid

def connect(file):
    pathlib.Path(file).parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(file,timeout=30);db.row_factory=sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,workflow TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at REAL NOT NULL,updated_at REAL NOT NULL)')
    return db

def submit(db,job_id,workflow):
    if str(uuid.UUID(job_id))!=job_id:raise ValueError('Use a canonical UUID for the job')
    if not isinstance(workflow,dict) or not workflow or len(json.dumps(workflow))>2_000_000:raise ValueError('A ComfyUI API workflow is required (up to 2 MB)')
    raw=json.dumps(workflow,sort_keys=True);fingerprint=hashlib.sha256(raw.encode()).hexdigest()
    with db:
        prior=db.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
        if prior:
            if prior['fingerprint']!=fingerprint:raise ValueError('This job ID already belongs to another workflow')
            return dict(prior)
        now=time.time();db.execute("INSERT INTO jobs(id,workflow,fingerprint,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)",(job_id,raw,fingerprint,now,now))
    return dict(db.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone())

class Worker:
    def __init__(self,db,origin):self.db,self.origin=db,origin.rstrip('/')
    def call(self,path,body=None):
        req=urllib.request.Request(self.origin+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=30) as r:return json.loads(r.read(8_000_000))
    def update(self,id,status,**fields):
        fields.update(status=status,updated_at=time.time())
        with self.db:self.db.execute('UPDATE jobs SET '+','.join(k+'=?' for k in fields)+' WHERE id=?',(*fields.values(),id))
    def tick(self):
        job=self.db.execute("SELECT * FROM jobs WHERE status IN ('queued','submitting','running','waiting') ORDER BY created_at,id LIMIT 1").fetchone()
        if not job:return
        id=job['id']
        try:
            # Check durable identity before any submit, including an acknowledged
            # job whose queue-worker process was restarted during execution.
            history=self.call('/history/'+id).get(id)
            if history:
                success=history.get('status',{}).get('status_str')=='success'
                self.update(id,'completed' if success else 'blocked',result=json.dumps(history),error=None if success else 'ComfyUI reported a workflow failure; inspect the saved result before retrying.')
                return
            queue=self.call('/queue');items=queue.get('queue_running',[])+queue.get('queue_pending',[])
            if any(item[1]==id for item in items):self.update(id,'running',error=None);return
            if job['status'] in ('running','submitting'):
                if job['status']=='submitting' and time.time()-job['updated_at']<90:return
                # An upstream restart clears ComfyUI's RAM queue/history. A
                # missing result needs reconciliation, never a duplicate render.
                self.update(id,'blocked',error='ComfyUI lost this submitted job after restart. Check output files, then explicitly retry the same saved workflow if no output exists.');return
            if items:
                self.update(id,'queued',error='Waiting for the GPU: another ComfyUI job is active.');return
            self.update(id,'submitting',attempts=job['attempts']+1,error=None)
            value=self.call('/prompt',{'prompt_id':id,'prompt':json.loads(job['workflow']),'client_id':'boardly-gpu-queue','extra_data':{'boardly_job_id':id}})
            if value.get('prompt_id')!=id:raise ValueError('ComfyUI did not retain the stable job ID; inspect its queue')
            self.update(id,'running',error=None)
        except urllib.error.HTTPError as e:
            current=self.db.execute('SELECT status FROM jobs WHERE id=?',(id,)).fetchone()['status']
            self.update(id,'blocked' if 400<=e.code<500 else current if current in ('submitting','running') else 'waiting',error='ComfyUI HTTP '+str(e.code)+'. Inspect model/workflow compatibility.' if 400<=e.code<500 else 'ComfyUI temporarily unavailable; waiting to reconnect.')
        except (OSError,ValueError):
            current=self.db.execute('SELECT status FROM jobs WHERE id=?',(id,)).fetchone()['status']
            # Keep submitting state after a lost acknowledgment so recovery
            # reconciles that UUID rather than silently submitting it twice.
            self.update(id,current if current in ('submitting','running') else 'waiting',error='GPU connection interrupted. Saved workflow retained; reconnecting automatically.')

def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--db',default=str(pathlib.Path.home()/'.local/share/boardly-gpu/queue.db'));p.add_argument('--origin',default='http://127.0.0.1:8188')
    p.add_argument('command',choices=['submit','status','run','retry','cancel']);p.add_argument('--id');p.add_argument('--workflow');a=p.parse_args();db=connect(a.db)
    if a.command=='submit':
        value=submit(db,a.id,json.loads(pathlib.Path(a.workflow).read_text()));value.pop('workflow');print(json.dumps(value));return
    if a.command=='status':
        rows=db.execute('SELECT id,status,error,attempts,created_at,updated_at,result FROM jobs'+(' WHERE id=?' if a.id else ' ORDER BY created_at DESC LIMIT 100'),(a.id,) if a.id else ()).fetchall();print(json.dumps([dict(x) for x in rows]));return
    if a.command in ('retry','cancel'):
        # A running workflow keeps its GPU-level cancellation control. Never
        # interrupt another user's render on this shared physical device.
        if a.command=='retry':
            job=db.execute('SELECT status FROM jobs WHERE id=?',(a.id,)).fetchone()
            if not job or job['status'] not in ('blocked','queued','waiting'):raise SystemExit('Choose a queued/blocked job.')
            # The operator explicitly reconciled the outcome. Remove only this
            # UUID's old failure history so it cannot mask the new attempt.
            Worker(db,a.origin).call('/history',{'delete':[a.id]})
        with db:
            result=db.execute("UPDATE jobs SET status=?,error=NULL,updated_at=? WHERE id=? AND status IN ('blocked','queued','waiting')",('queued' if a.command=='retry' else 'cancelled',time.time(),a.id))
        if not result.rowcount:raise SystemExit('Choose a queued/blocked job. Use ComfyUI to cancel a running render.')
        return
    lock=open(a.db+'.worker.lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    worker=Worker(db,a.origin);stopped=False
    def stop(*_):
        nonlocal stopped
        stopped=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    while not stopped:
        worker.tick()
        for _ in range(10):
            if stopped:break
            time.sleep(.5)
if __name__=='__main__':main()
