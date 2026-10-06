import contextlib
import importlib.util
import io
import json
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'eda.py'
SPEC = importlib.util.spec_from_file_location('eda_helper', SCRIPT)
eda = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(eda)


class FakeResponse:
    def __init__(self, result):
        self.result = result

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.result).encode('utf-8')


class EdaHelperTests(unittest.TestCase):
    def test_cmd_sends_top_level_instance_id_and_preserves_timeout(self):
        with patch.object(eda.urllib.request, 'urlopen', return_value=FakeResponse({'ok': True, 'data': {}})) as open_url:
            result = eda.cmd('project.getInfo', {'x': 1}, 17, instance_id='eda-2')

        request = open_url.call_args.args[0]
        self.assertEqual(json.loads(request.data), {'instanceId': 'eda-2', 'cmd': 'project.getInfo', 'params': {'x': 1}})
        self.assertEqual(open_url.call_args.kwargs['timeout'], 17)
        self.assertTrue(result['ok'])

    def test_macro_sends_top_level_instance_id_and_preserves_timeout(self):
        steps = [{'cmd': 'project.getInfo'}]
        with patch.object(eda.urllib.request, 'urlopen', return_value=FakeResponse({'ok': True, 'data': {'steps': ['done']}})) as open_url:
            result = eda.macro(steps, timeout=19, instance_id='eda-3')

        request = open_url.call_args.args[0]
        self.assertEqual(json.loads(request.data), {
            'instanceId': 'eda-3',
            'cmd': 'macro',
            'params': {'stopOnError': False, 'steps': steps},
        })
        self.assertEqual(open_url.call_args.kwargs['timeout'], 19)
        self.assertEqual(result, ['done'])

    def test_missing_or_empty_instance_id_fails_before_network(self):
        with patch.object(eda.urllib.request, 'urlopen') as open_url:
            with self.assertRaises(TypeError):
                eda.cmd('project.getInfo')
            with self.assertRaises(TypeError):
                eda.macro([])
            with self.assertRaises(ValueError):
                eda.cmd('project.getInfo', instance_id='  ')
            with self.assertRaises(ValueError):
                eda.macro([], instance_id='')
        open_url.assert_not_called()

    def test_cli_requires_explicit_instance_id(self):
        with patch.object(sys, 'argv', [str(SCRIPT)]), patch.object(eda.urllib.request, 'urlopen') as open_url:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                runpy.run_path(str(SCRIPT), run_name='__main__')
        self.assertEqual(raised.exception.code, 2)
        open_url.assert_not_called()

    def test_cli_forwards_explicit_instance_id(self):
        output = io.StringIO()
        response = {'ok': True, 'cmd': 'project.getInfo', 'data': {}}
        with patch.object(sys, 'argv', [str(SCRIPT), '--instance-id', 'eda-cli', 'project.getInfo', '{"x":1}']), \
                patch.object(eda.urllib.request, 'urlopen', return_value=FakeResponse(response)) as open_url, \
                contextlib.redirect_stdout(output):
            runpy.run_path(str(SCRIPT), run_name='__main__')
        self.assertEqual(json.loads(open_url.call_args.args[0].data)['instanceId'], 'eda-cli')
        self.assertEqual(json.loads(open_url.call_args.args[0].data)['params'], {'x': 1})
        self.assertEqual(json.loads(output.getvalue()), response)

    def test_macro_raises_when_top_level_response_failed(self):
        error = {'message': 'target disconnected'}
        with patch.object(eda.urllib.request, 'urlopen', return_value=FakeResponse({'ok': False, 'error': error})):
            with self.assertRaisesRegex(RuntimeError, 'target disconnected'):
                eda.macro([], instance_id='eda-4')


if __name__ == '__main__':
    unittest.main()
