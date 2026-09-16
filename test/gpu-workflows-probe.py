import importlib.util, pathlib, tempfile, unittest, uuid
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


if __name__ == '__main__': unittest.main()
