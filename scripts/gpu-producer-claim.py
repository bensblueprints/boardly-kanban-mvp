"""Prompt-edit bridge for an existing manifest producer.

Call claim(root, job) before saving creative.json or building a graph. The editor
uses the same lock and refuses writes after this durable claim exists.
"""
import fcntl, json, os, pathlib, time, uuid


def claim(root, job):
    identity=str(uuid.UUID(job['job_id']))
    edits=pathlib.Path(root)/'.boardly-prompts';edits.mkdir(mode=0o700,exist_ok=True)
    with open(edits/'.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        marker=edits/(identity+'.claimed')
        override=edits/(identity+'.json')
        # Once claimed, use the producer's saved creative instead of applying
        # subsequent edits. Overrides are immutable after this boundary.
        if not marker.exists():
            if override.exists(): job.update(json.loads(override.read_text()).get('changes',{}))
            with open(marker,'x') as saved:
                json.dump({'claimed_at':time.time(),'job_id':identity},saved);saved.flush();os.fsync(saved.fileno())
        elif override.exists():
            # Restart recovery before creative.json was saved still sees the
            # exact immutable override that was present at claim time.
            job.update(json.loads(override.read_text()).get('changes',{}))
    return job
