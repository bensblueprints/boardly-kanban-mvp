import base64
import importlib.util
from pathlib import Path
import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('vision', Path(__file__).resolve().parents[1] / 'scripts/qwen-vision/serve.py')
vision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vision)
detect_spec = importlib.util.spec_from_file_location('detector', Path(__file__).resolve().parents[1] / 'scripts/qwen-vision/detect.py')
detector = importlib.util.module_from_spec(detect_spec)
detect_spec.loader.exec_module(detector)
install_spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'scripts/qwen-vision/install.py')
installer = importlib.util.module_from_spec(install_spec)
install_spec.loader.exec_module(installer)


class DetectionTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.command = self.enterContext(patch.object(detector, 'command', return_value='Fixture RTX, 16384, 13000'))
        self.system = self.enterContext(patch.object(detector.platform, 'system', return_value='Linux'))
        self.enterContext(patch.object(detector.platform, 'machine', return_value='x86_64'))
        self.enterContext(patch.object(detector.sys, 'version_info', (3, 12)))
        self.drivers = self.enterContext(patch.object(detector.ctypes.util, 'find_library', return_value='libvulkan.so.1'))
        self.enterContext(patch.object(detector.shutil, 'which', return_value='/usr/bin/tool'))
        self.disk = self.enterContext(patch.object(detector.shutil, 'disk_usage', return_value=SimpleNamespace(free=20000000000)))
        self.health = self.enterContext(patch.object(detector.urllib.request, 'urlopen', side_effect=OSError))

    def test_missing_models_and_compatible_gpu(self):
        result = detector.detect(self.root)
        self.assertTrue(result['can_install'])
        self.assertTrue(result['needs_install'])
        self.assertGreater(result['download_bytes'], 6000000000)
        self.assertEqual(result['gpus'][0]['memory_mib'], 16384)
        self.assertFalse(result['model_files_present'])
        self.assertEqual(self.command.call_count, 1)
        self.assertEqual(self.command.call_args.args[0][0], 'nvidia-smi')

    def test_existing_models_require_no_download(self):
        for name, size in detector.FILES.items():
            with (self.root / name).open('wb') as stream:
                stream.truncate(size)  # Sparse fixture; no weights or download.
        binary = self.root / 'runtime-b10930/llama-b10930/llama-server'
        binary.parent.mkdir(parents=True)
        binary.touch()
        self.command.side_effect = ['Fixture RTX, 16384, 13000', '  Vulkan0: Fixture RTX (16384 MiB, 13000 MiB free)']
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"protocol":1,"model":"Qwen3-VL-8B-Instruct-Q4_K_M"}'
        self.health.side_effect = None
        self.health.return_value = response
        result = detector.detect(self.root)
        self.assertFalse(result['needs_install'])
        self.assertEqual(result['download_bytes'], 0)
        self.assertEqual(result['gpus'][0]['device'], 'Vulkan0')

    def test_low_memory_missing_drivers_disk_and_unsupported_os(self):
        self.command.return_value = 'Small GPU, 8192, 7000'
        self.assertFalse(detector.detect(self.root)['can_install'])
        self.command.return_value = 'Fixture RTX, 16384, 13000'
        self.drivers.return_value = None
        self.assertFalse(detector.detect(self.root)['can_install'])
        self.drivers.return_value = 'libvulkan.so.1'
        self.disk.return_value = SimpleNamespace(free=1000000)
        self.assertFalse(detector.detect(self.root)['can_install'])
        self.disk.return_value = SimpleNamespace(free=20000000000)
        self.system.return_value = 'Windows'
        self.assertFalse(detector.detect(self.root)['can_install'])

    def test_selects_capable_gpu_after_integrated_card(self):
        self.assertEqual(installer.select_device('Vulkan0: Integrated (2048 MiB, 1000 MiB free)\nVulkan1: RTX (16384 MiB, 13000 MiB free)'), 'Vulkan1')
        with self.assertRaisesRegex(RuntimeError, 'No compatible Vulkan GPU'):
            installer.select_device('Vulkan0: Small GPU (8192 MiB, 7000 MiB free)')


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
