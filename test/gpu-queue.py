import importlib.util,pathlib,tempfile,uuid,unittest,json,urllib.error
spec=importlib.util.spec_from_file_location('queue_worker',pathlib.Path(__file__).parents[1]/'scripts/gpu-queue.py');q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
class QueueTest(unittest.TestCase):
 def test_restart_outage_and_lost_ack(self):
  with tempfile.TemporaryDirectory() as root:
   file=root+'/jobs.db';db=q.connect(file);id=str(uuid.uuid4());workflow={'1':{'class_type':'SaveImage','inputs':{'filename_prefix':'fixture'}}}
   q.submit(db,id,workflow);q.submit(db,id,workflow)
   self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0],1)
   with self.assertRaises(ValueError):q.submit(db,id,{'different':{}})
   w=q.Worker(db,'http://127.0.0.1');state={'offline':True,'queue':[],'history':{},'submitted':0}
   def call(path,body=None):
    if state['offline']:raise OSError('offline')
    if path.startswith('/history/'):return state['history']
    if path=='/queue':return {'queue_running':state['queue'],'queue_pending':[]}
    state['submitted']+=1;state['queue']=[[0,body['prompt_id']]];raise OSError('ack lost')
   w.call=call;w.tick();self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()[0],'waiting')
   state['offline']=False;w.tick();self.assertEqual(state['submitted'],1)
   db.close();db=q.connect(file);w=q.Worker(db,'http://127.0.0.1');w.call=call;w.tick()
   self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()[0],'running');self.assertEqual(state['submitted'],1)
   state['queue']=[];state['history']={id:{'status':{'status_str':'success'},'outputs':{'1':{'images':[{'filename':'done.png'}]}}}};w.tick()
   self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()[0],'completed');self.assertIn('done.png',db.execute('SELECT result FROM jobs').fetchone()[0]);db.close()
 def test_missing_upstream_result_is_not_blindly_repeated(self):
  with tempfile.TemporaryDirectory() as root:
   db=q.connect(root+'/jobs.db');id=str(uuid.uuid4());q.submit(db,id,{'1':{}});db.execute("UPDATE jobs SET status='running'");db.commit();w=q.Worker(db,'http://127.0.0.1');w.call=lambda path,body=None:{'queue_running':[],'queue_pending':[]} if path=='/queue' else {};w.tick();self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()[0],'blocked');db.close()
if __name__=='__main__':unittest.main()
