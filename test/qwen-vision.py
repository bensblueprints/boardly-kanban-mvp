import base64
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vision', Path(__file__).resolve().parents[1] / 'scripts/qwen-vision/serve.py')
vision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vision)


class SchedulerTest(unittest.TestCase):
    def setUp(self):
        self.body = {'image_url': 'data:image/jpeg;base64,' + base64.b64encode(b'\xff\xd8\xff\xd9').decode(), 'question': 'Read the heading'}

    def test_active_image_job_is_not_unloaded(self):
        with patch.object(vision, 'call', return_value={'queue_running': [['a']], 'queue_pending': []}) as call, patch.object(vision.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(vision.Unavailable, 'busy generating images'):
                vision.inspect(self.body)
            self.assertEqual([args.args[1] for args in call.call_args_list], ['/queue'])
            spawn.assert_not_called()
            self.assertFalse(vision.LOCK.locked())

    def test_parallel_inference_rejected(self):
        vision.LOCK.acquire()
        try:
            with self.assertRaisesRegex(vision.Unavailable, 'Another local'):
                vision.inspect(self.body)
        finally:
            vision.LOCK.release()

    def test_no_remote_image_fetch(self):
        with self.assertRaises(ValueError):
            vision.inspect({**self.body, 'image_url': 'https://example.com/private.png'})

    def test_bounded_inference_and_output(self):
        with patch.object(vision, 'start_model'), patch.object(vision, 'call', return_value={'choices': [{'message': {'content': 'x' * 2000}}]}) as call:
            result = vision.inspect(self.body)
            payload = call.call_args.args[2]
            self.assertEqual(payload['max_tokens'], 260)
            self.assertEqual(len(result['observation']), 1600)
            self.assertNotIn('image_url', result)
            self.assertFalse(vision.LOCK.locked())

    def test_failure_has_no_fallback(self):
        with patch.object(vision, 'start_model'), patch.object(vision, 'call', side_effect=TimeoutError), patch.object(vision, 'stop_model') as stop:
            with self.assertRaisesRegex(vision.Unavailable, 'No screenshot was sent to GPT'):
                vision.inspect(self.body)
            stop.assert_called_once()
            self.assertFalse(vision.LOCK.locked())


if __name__ == '__main__':
    unittest.main()
