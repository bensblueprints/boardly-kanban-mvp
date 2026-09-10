const assert = require('node:assert/strict');
const { fixture } = require('./member-fixture');

(async () => {
  const f = await fixture();
  try {
    const a = await f.project('Concurrent chats', 'Shared project');
    const other = await f.project('Private company', 'Private project');
    const store = require('../server/connections').createConnections(f.root);
    const key = store.issue('user_owner', 'Concurrent chat worker', 'worker'); store.close();
    const worker = async (route, body = {}) => {
      const response = await fetch(f.base + route, { method: 'POST', headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(response.ok, await response.clone().text()); return response.json();
    };
    const claim = async () => (await worker('/api/worker/claim')).job;
    const enqueue = async (mode, project = a.project.id) => {
      const thread = await f.api(`/api/boards/${project}/chat/threads`, { method: 'POST', body: {} });
      const job = await f.api(`/api/chat/threads/${thread.id}/messages`, { method: 'POST', body: { mode, content: `${mode} conversation` } });
      return { thread, job };
    };
    const read = t => f.api(`/api/chat/threads/${t.thread.id}`);
    const finish = (job, status = 'completed') => worker(`/api/worker/jobs/${job.id}`, { status, text: 'Finished' });
    const work = await enqueue('work'); assert.equal((await claim()).id, work.job.id);
    const waiting = await enqueue('work');
    assert.equal((await read(waiting)).job.queue.reason, 'project_work');
    assert.equal((await read(waiting)).job.queuePosition, undefined, 'no misleading global queue position');
    assert.equal(await claim(), null);
    const ask = await enqueue('ask'), plan = await enqueue('plan');
    assert.equal((await read(ask)).job.queue.reason, 'ready');
    assert.equal((await claim()).id, ask.job.id, 'Ask bypasses the older queued Work');
    assert.equal((await claim()).id, plan.job.id, 'Plan overlaps Work and Ask in the same project');
    assert.equal((await f.request(`/api/chat/threads/${ask.thread.id}/messages`, { method: 'POST', body: { mode: 'ask', content: 'Another message' } })).status, 409, 'same conversation stays ordered');
    const privateWork = await enqueue('work', other.project.id); assert.equal((await claim()).id, privateWork.job.id);
    const fifth = await enqueue('ask');
    assert.deepEqual((await read(fifth)).job.queue, { reason: 'capacity' }, 'capacity explanation exposes no other company details');
    assert.equal(await claim(), null, 'four-agent limit remains enforced');
    await f.api(`/api/chat/jobs/${ask.job.id}/cancel`, { method: 'POST', body: {} });
    await finish(ask.job, 'cancelled');
    assert.equal((await claim()).id, fifth.job.id);
    for (const active of [work, plan, privateWork]) assert.equal((await read(active)).job.status, 'running', 'cancelling one preserves the others');
    await f.api(`/api/chat/jobs/${work.job.id}/cancel`, { method: 'POST', body: {} });
    assert.equal((await read(waiting)).job.queue.reason, 'stopping');
    assert.equal(await claim(), null, 'cancelled writer must settle before the next starts');
    await finish(work.job, 'cancelled');
    assert.equal((await read(waiting)).job.queue.reason, 'ready');
    assert.equal((await claim()).id, waiting.job.id);
    const history = await f.api(`/api/boards/${a.project.id}/chat/threads`);
    assert.equal(history.find(t => t.id === waiting.thread.id).job_status, 'running');
    assert.equal(history.find(t => t.id === plan.thread.id).job_mode, 'plan');
    for (const active of [waiting, plan, privateWork, fifth]) await finish(active.job);
    console.log('PASS: same-project Work + Ask + Plan overlap, queued writer bypass, four slots, scoped wait reasons, cancellation settlement and live history');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
