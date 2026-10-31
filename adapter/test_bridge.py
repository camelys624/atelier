import io,json,runpy,contextlib,unittest,base64,tempfile,os,threading,time
from pathlib import Path
from unittest.mock import patch,Mock

class RefreshMetadataTests(unittest.TestCase):
    def context(self, credentials):
        with patch('sys.stdin',io.StringIO(json.dumps({'action':'probe','account':credentials}))),contextlib.redirect_stdout(io.StringIO()):
            return runpy.run_path(str(Path(__file__).with_name('bridge.py')))
    def test_refresh_uses_recorded_client_and_endpoint(self):
        ctx=self.context({'access_token':'opaque-old-token','refresh_token':'old-refresh','source_type':'codex','client_id':'recorded-client','token_endpoint':'https://auth.openai.com/api/accounts/oauth/token','expires_at':1})
        response=Mock(status_code=200)
        response.json.return_value={'access_token':'new-access','refresh_token':'new-refresh','expires_in':7200}
        with patch('curl_cffi.requests.post',return_value=response) as post:
            result=ctx['refreshed_account']()
        self.assertEqual(post.call_args.args[0],'https://auth.openai.com/api/accounts/oauth/token')
        self.assertEqual(post.call_args.kwargs['data']['client_id'],'recorded-client')
        self.assertEqual(result['refresh_token'],'new-refresh')
        self.assertGreater(result['expires_at'],1)
    def test_cannot_refresh_at_an_untrusted_endpoint(self):
        ctx=self.context({'access_token':'opaque-old-token','refresh_token':'old-refresh','token_endpoint':'https://untrusted.example/token','expires_at':1})
        with patch('curl_cffi.requests.post') as post:
            with self.assertRaises(RuntimeError):ctx['refreshed_account']()
            post.assert_not_called()
    def test_keeps_unexpired_opaque_tokens(self):
        ctx=self.context({'access_token':'opaque-valid-token','refresh_token':'refresh','expires_at':9999999999})
        with patch('curl_cffi.requests.post') as post:
            self.assertEqual(ctx['refreshed_account']()['access_token'],'opaque-valid-token')
            post.assert_not_called()
class ImageEditProtocolTests(unittest.TestCase):
    def setUp(self):
        with patch('sys.stdin', io.StringIO(json.dumps({'action': 'probe'}))), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(Path(__file__).with_name('bridge.py')))

    def backend(self, content=b''):
        from services.openai_backend_api import OpenAIBackendAPI
        backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
        backend.access_token = 'fake-test-token'
        backend.base_url = 'https://chatgpt.com'
        backend._ensure_codex_source_account = Mock()
        backend.session = Mock()
        backend.session.post.return_value = Mock(status_code=200, headers={'content-type': 'text/event-stream'}, content=content)
        return backend

    def test_bridge_preserves_model_size_quality_and_order(self):
        from services import openai_backend_api
        images = ['data:image/png;base64,first', 'data:image/png;base64,second', 'data:image/png;base64,third']
        raw = b'fake PNG bytes for protocol test'
        backend = Mock()
        backend.iter_codex_image_response_events.return_value = iter([{'type': 'image_generation_call', 'result': base64.b64encode(raw).decode()}])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'result.png'
            payload = {'action': 'generate', 'account': {'source_type': 'codex', 'access_token': 'fake-test-token'}, 'model': 'gpt-image-2.5-sunburst', 'prompt': 'combine three references', 'size': '1536x1024', 'quality': 'high', 'images': images, 'output': str(output)}
            with patch.object(openai_backend_api, 'OpenAIBackendAPI', return_value=backend), patch('sys.stdin', io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(io.StringIO()) as stdout:
                runpy.run_path(str(Path(__file__).with_name('bridge.py')))
            result = json.loads(stdout.getvalue())
            self.assertTrue(result['ok'])
            self.assertEqual(output.read_bytes(), raw)
        backend.iter_codex_image_response_events.assert_called_once_with(prompt='combine three references', images=images, size='1536x1024', quality='high', model='gpt-image-2.5-sunburst')
        backend.close.assert_called_once()

    def test_tool_payload_uses_requested_model_and_edit_settings(self):
        backend = self.backend()
        backend._iter_codex_response_events = Mock(return_value=iter([]))
        with patch.dict(os.environ, {'CODEX_RESPONSES_MODEL': ''}):
            list(backend.iter_codex_image_response_events(prompt='combine', images=['data:image/png;base64,first', 'data:image/png;base64,second'], size='1536x1024', quality='high', model='gpt-image-2.5-sunburst'))
        payload = backend.session.post.call_args.kwargs['json']
        self.assertEqual(payload['model'], 'gpt-6.1-sol')
        self.assertEqual(payload['tools'][0], {'type': 'image_generation', 'model': 'gpt-image-2.5-sunburst', 'action': 'edit', 'size': '1536x1024', 'quality': 'high', 'output_format': 'png'})
        self.assertEqual([part['image_url'] for part in payload['input'][0]['content'][1:]], ['data:image/png;base64,first', 'data:image/png;base64,second'])
        self.assertFalse(backend.session.post.call_args.kwargs['allow_redirects'])
        backend.session.post.return_value.close.assert_called_once()

    def test_internal_model_can_be_configured_without_changing_the_image_model(self):
        backend = self.backend()
        backend._iter_codex_response_events = Mock(return_value=iter([]))
        with patch.dict(os.environ, {'CODEX_RESPONSES_MODEL': ' custom-account-model '}):
            list(backend.iter_codex_image_response_events(prompt='test', model='gpt-image-2.5-sunburst'))
        payload = backend.session.post.call_args.kwargs['json']
        self.assertEqual(payload['model'], 'custom-account-model')
        self.assertEqual(payload['tools'][0]['model'], 'gpt-image-2.5-sunburst')

    def test_decodes_complete_sse_response_with_configured_client(self):
        event = {'type': 'response.completed', 'response': {'output': [{'type': 'image_generation_call', 'result': 'dGVzdA=='}]}}
        backend = self.backend(('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode())
        self.assertEqual(list(backend.iter_codex_image_response_events(prompt='test')), [event])
        backend.session.post.assert_called_once()

    def test_preserves_upstream_errors_without_automatically_retrying(self):
        backend = self.backend()
        response = backend.session.post.return_value
        response.status_code = 400
        response.text = 'model not available'
        response.json.return_value = {'error': {'code': 'model_not_found'}}
        with self.assertRaisesRegex(Exception, 'model_not_found'):
            list(backend.iter_codex_image_response_events(prompt='test'))
        backend.session.post.assert_called_once()
        response.close.assert_called_once()

    def test_legacy_codex_alias_keeps_original_upstream_model(self):
        from services.protocol import conversation
        backend = Mock()
        backend.iter_codex_image_response_events.return_value = iter([{'type': 'image_generation_call', 'result': 'dGVzdA=='}])
        list(conversation.stream_codex_image_outputs(backend, conversation.ConversationRequest(model='codex-gpt-image-2', prompt='legacy')))
        self.assertEqual(backend.iter_codex_image_response_events.call_args.kwargs['model'], 'gpt-image-2')

    def test_retries_transient_tls_only_for_account_validation(self):
        from services import openai_backend_api
        from curl_cffi.requests.exceptions import RequestException
        backend = Mock()
        backend.get_user_info.side_effect = [RequestException('TLS connect error', code=35), {'type': 'prolite'}]
        payload = {'action': 'refresh', 'account': {'access_token': 'test-access-token'}}
        with patch.object(openai_backend_api, 'OpenAIBackendAPI', return_value=backend), patch('time.sleep'), patch('sys.stdin', io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(io.StringIO()) as stdout:
            runpy.run_path(str(Path(__file__).with_name('bridge.py')))
        self.assertTrue(json.loads(stdout.getvalue())['ok'])
        self.assertEqual(backend.get_user_info.call_count, 2)
        self.assertEqual(backend.close.call_count, 2)

    def test_keeps_rotated_credentials_when_validation_exhausts_network_retries(self):
        from services import openai_backend_api
        from curl_cffi.requests.exceptions import RequestException
        backend = Mock()
        backend.get_user_info.side_effect = RequestException('TLS connect error', code=35)
        response = Mock(status_code=200)
        response.json.return_value = {'access_token': 'rotated-access', 'refresh_token': 'rotated-refresh', 'expires_in': 7200}
        payload = {'action': 'refresh', 'account': {'source_type': 'codex', 'access_token': 'expired-access', 'refresh_token': 'initial-refresh', 'expires_at': 1}}
        with patch.object(openai_backend_api, 'OpenAIBackendAPI', return_value=backend), patch('curl_cffi.requests.post', return_value=response) as refresh, patch('time.sleep'), patch('sys.stdin', io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(io.StringIO()) as stdout:
            with self.assertRaises(SystemExit):
                runpy.run_path(str(Path(__file__).with_name('bridge.py')))
        result = json.loads(stdout.getvalue())
        self.assertFalse(result['ok']); self.assertEqual(result['error_kind'], 'network')
        self.assertEqual(result['credentials']['refresh_token'], 'rotated-refresh')
        self.assertEqual(backend.get_user_info.call_count, 3)
        refresh.assert_called_once()

    def test_does_not_retry_account_auth_errors_or_image_generation(self):
        from services import openai_backend_api
        from curl_cffi.requests.exceptions import RequestException
        for action in ['refresh', 'generate']:
            backend = Mock()
            backend.get_user_info.side_effect = RuntimeError('HTTP 401 credentials rejected')
            backend.iter_codex_image_response_events.side_effect = RequestException('TLS connect error', code=35)
            payload = {'action': action, 'account': {'source_type': 'codex', 'access_token': 'test-access-token'}, 'prompt': 'test', 'model': 'codex-gpt-image-2'}
            with patch.object(openai_backend_api, 'OpenAIBackendAPI', return_value=backend), patch('sys.stdin', io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    runpy.run_path(str(Path(__file__).with_name('bridge.py')))
            if action == 'refresh': backend.get_user_info.assert_called_once()
            else: backend.iter_codex_image_response_events.assert_called_once()

    def test_account_check_waits_for_other_reads_before_the_tls_session_is_closed(self):
        from services.openai_backend_api import OpenAIBackendAPI
        from curl_cffi.requests.exceptions import RequestException
        backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
        backend.access_token = 'test-access-token'
        barrier = threading.Barrier(3)
        finished = []
        def fail():
            barrier.wait(timeout=2)
            raise RequestException('TLS connect error', code=35)
        def sibling():
            barrier.wait(timeout=2)
            time.sleep(0.02)
            finished.append(True)
            return {}
        backend._get_me = fail
        backend._get_conversation_init = sibling
        backend._get_default_account = sibling
        with self.assertRaises(RequestException): backend.get_user_info()
        self.assertEqual(len(finished), 2)

if __name__ == '__main__':
    unittest.main()
