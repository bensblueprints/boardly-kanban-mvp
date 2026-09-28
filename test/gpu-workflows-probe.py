import importlib.util, json, pathlib, tempfile, unittest, uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('probe', pathlib.Path(__file__).resolve().parents[1] / 'scripts/gpu-workflows-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ReceiptTests(unittest.TestCase):
    def test_lost_ack_and_restart_never_duplicate(self):
        config = {'ports': [8188, 8199]}
        identity = str(uuid.uuid4())
        data = {'id': identity, 'run_id': str(uuid.uuid4()), 'port': 8188, 'workflow': {'1': {'class_type': 'SaveImage', 'inputs': {}}}}
        posted = []
        active = [False]
        def call(port, route, body=None, timeout=4):
            if route.startswith('/history/'): return {}
            if route == '/queue': return {'queue_running': [[0, identity if active[0] else 'foreign-render', {}]] if port == 8199 and active[0] else [], 'queue_pending': []}
            if route == '/prompt': posted.append(body); raise OSError('Acknowledgement lost')
            raise AssertionError(route)
        with tempfile.TemporaryDirectory() as folder, patch.object(pathlib.Path, 'home', return_value=pathlib.Path(folder)), patch.object(probe, 'local_jobs', return_value=([],[])), patch.object(probe, 'call', side_effect=call):
            with self.assertRaises(OSError): probe.render(config, data)
            self.assertEqual(len(posted), 1)
            self.assertEqual(probe.render(config, data)['status'], 'blocked')
            self.assertEqual(len(posted), 1)
            active[0] = True
            self.assertEqual(probe.render(config, data)['status'], 'running')
            self.assertEqual(len(posted), 1)

    def test_existing_engine_and_durable_queue_take_priority(self):
        data = {'id': str(uuid.uuid4()), 'run_id': str(uuid.uuid4()), 'port':8188, 'workflow':{}}
        with tempfile.TemporaryDirectory() as folder, patch.object(pathlib.Path, 'home', return_value=pathlib.Path(folder)), patch.object(probe, 'local_jobs', return_value=([],[])), patch.object(probe, 'call', side_effect=lambda port,route: {} if route.startswith('/history/') else {'queue_running':[[0,'existing-granny',{}]] if port==8199 else [],'queue_pending':[]}):
            self.assertEqual(probe.render({'ports':[8188,8199]},data)['status'],'queued')
            self.assertFalse((pathlib.Path(folder)/'.local/share/boardly-gpu-workflows/receipts'/ (data['id']+'.json')).exists())
        with tempfile.TemporaryDirectory() as folder, patch.object(pathlib.Path, 'home', return_value=pathlib.Path(folder)), patch.object(probe, 'local_jobs', return_value=([{'status':'queued'}],[])), patch.object(probe, 'call', return_value={}):
            self.assertEqual(probe.render({'ports':[8188]},data)['status'],'queued')

    def test_history_outputs_and_failure(self):
        identity=str(uuid.uuid4());data={'id':identity,'port':8188}
        for state,expected in [('success','completed'),('error','blocked')]:
            history={identity:{'status':{'status_str':state},'outputs':{'9':{'images':[{'filename':'output.png','subfolder':'run','type':'output'}]}}}}
            with tempfile.TemporaryDirectory() as folder, patch.object(pathlib.Path,'home',return_value=pathlib.Path(folder)), patch.object(probe,'call',return_value=history):
                result=probe.render({'ports':[8188]},data)
                self.assertEqual(result['status'],expected)
                self.assertEqual(result['outputs'][0]['filename'],'output.png')


class ProducerOutputTests(unittest.TestCase):
    def test_finished_output_keeps_its_time_and_project_video(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(pathlib.Path,'home',return_value=pathlib.Path(folder)):
            root=pathlib.Path(folder)/'Continuous';batch=root/'batch-000001';job=batch/'G002';job.mkdir(parents=True)
            identity=str(uuid.uuid4());finished=1789600433.79
            (batch/'manifest.json').write_text(json.dumps([{'id':'G002','job_id':identity,'status':'rendered','location':'Tower climbing','flavor':'Garlic','finished_at':finished}]))
            (job/'boardly-file.json').write_text(json.dumps({'id':858,'name':'garlic-finished.mp4','size':18976211,'mime':'video/mp4'}))
            with patch.object(probe,'engine',return_value={'port':8199,'online':True,'jobs':[{'id':identity,'status':'completed','outputs':[{'filename':'raw.mp4'}]}]}),patch.object(probe.subprocess,'check_output',return_value=''):
                result=probe.snapshot({'manifest_dir':str(root),'ports':[8199]})
            saved=result['jobs'][0];self.assertEqual(saved['status'],'completed');self.assertEqual(saved['finished_at'],finished)
            self.assertEqual(saved['outputs'][0]['url'],'/api/project-files/858/download');self.assertEqual(saved['outputs'][0]['size'],18976211)
            self.assertEqual(saved['outputs'][0]['name'],'garlic-finished.mp4','The verified final export takes precedence over the raw engine render')


class PromptEditTests(unittest.TestCase):
    def test_producer_edit_claim_and_restart(self):
        spec=importlib.util.spec_from_file_location('claim',pathlib.Path(__file__).resolve().parents[1]/'scripts/gpu-producer-claim.py');bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);batch=root/'batch-000001';batch.mkdir();edits=root/'.boardly-prompts';edits.mkdir();(edits/'enabled').write_text('1')
            identity=str(uuid.uuid4());job={'job_id':identity,'status':'queued','dialogue':'Original script','visual':'Original scene','location':'Tower'}
            manifest=batch/'manifest.json';manifest.write_text(json.dumps([job]));config={'manifest_dir':folder,'ports':[8188]}
            detail=probe.job_detail(config,{'action':'job_detail','id':identity});self.assertTrue(detail['editable'])
            changed=probe.job_detail(config,{'action':'edit_job','id':identity,'revision':detail['revision'],'changes':{'visual':'Photographic skydiving scene'}})
            with self.assertRaises(ValueError): probe.job_detail(config,{'action':'edit_job','id':identity,'revision':detail['revision'],'changes':{'visual':'Stale edit'}})
            self.assertEqual(json.loads(manifest.read_text())[0]['visual'],'Original scene','Running producer owns its manifest; edits use a durable sidecar')
            self.assertEqual(bridge.claim(root,dict(job))['visual'],'Photographic skydiving scene')
            self.assertEqual(bridge.claim(root,dict(job))['visual'],'Photographic skydiving scene','Restart sees the same claimed edit')
            self.assertFalse(probe.job_detail(config,{'action':'job_detail','id':identity})['editable'])
            with self.assertRaises(ValueError):probe.job_detail(config,{'action':'edit_job','id':identity,'revision':changed['revision'],'changes':{'visual':'Too late'}})

    def test_durable_edit_racing_submission(self):
        spec=importlib.util.spec_from_file_location('queue',pathlib.Path(__file__).resolve().parents[1]/'scripts/gpu-queue.py');queue=importlib.util.module_from_spec(spec);spec.loader.exec_module(queue)
        with tempfile.TemporaryDirectory() as folder,patch.object(pathlib.Path,'home',return_value=pathlib.Path(folder)):
            file=pathlib.Path(folder)/'.local/share/boardly-gpu/queue.db';db=queue.connect(str(file));pathlib.Path(str(file)+'.prompt-edit-v1').write_text('1')
            identity=str(uuid.uuid4());queue.submit(db,identity,{'1':{'class_type':'CLIPTextEncode','inputs':{'text':'Old'}}})
            posted=[];edited=[False];worker=queue.Worker(db,'http://fixture')
            def call(route,body=None):
                if route.startswith('/history/'):return {}
                if route=='/queue':
                    if not edited[0]:
                        detail=probe.job_detail({'ports':[8188]},{'action':'job_detail','id':identity})
                        probe.job_detail({'ports':[8188]},{'action':'edit_job','id':identity,'revision':detail['revision'],'changes':{'1:text':'New'}});edited[0]=True
                    return {'queue_running':[],'queue_pending':[]}
                posted.append(body);return {'prompt_id':identity}
            worker.call=call;worker.tick();self.assertEqual(posted,[],'CAS rejects the stale graph read before the edit')
            worker.tick();self.assertEqual(posted[0]['prompt']['1']['inputs']['text'],'New')
            self.assertFalse(probe.job_detail({'ports':[8188]},{'action':'job_detail','id':identity})['editable']);db.close()

if __name__ == '__main__': unittest.main()
