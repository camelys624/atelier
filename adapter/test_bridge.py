import io,json,runpy,contextlib,unittest,base64,tempfile,os,threading,time,sys
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
        backend.session.curl_options = {}
        response = Mock(status_code=200, headers={'content-type': 'text/event-stream'}, content=b'')
        def post(*_, **kwargs):
            from curl_cffi import CurlOpt
            read = backend.session.curl_options[CurlOpt.READFUNCTION]
            backend.sent_payload = json.loads(b''.join(iter(lambda: read(1024), b'')))
            callback = kwargs['content_callback']
            for index in range(0, len(content), 17): callback(content[index:index + 17])
            return response
        backend.session.post.side_effect = post
        backend.session.post.return_value = response
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
        payload = backend.sent_payload
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
        payload = backend.sent_payload
        self.assertEqual(payload['model'], 'custom-account-model')
        self.assertEqual(payload['tools'][0]['model'], 'gpt-image-2.5-sunburst')

    def test_decodes_complete_sse_response_with_configured_client(self):
        event = {'type': 'response.completed', 'response': {'output': [{'type': 'image_generation_call', 'result': 'dGVzdA=='}]}}
        backend = self.backend(('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode())
        self.assertEqual(list(backend.iter_codex_image_response_events(prompt='test')), [event])
        backend.session.post.assert_called_once()

    def test_sse_parser_yields_events_without_reading_the_whole_response(self):
        from services.openai_backend_api import OpenAIBackendAPI
        first = {'type': 'response.output_item.done', 'item': {'type': 'image_generation_call', 'result': 'b2s='}}
        second = {'type': 'response.completed', 'response': {'output': []}}
        class IncrementalBody(io.BytesIO):
            headers = {'content-type': 'text/event-stream'}
            status = 200
            def read(self, size=-1):
                if size < 0: raise AssertionError('full response read retains every image in memory')
                return super().read(size)
        raw = IncrementalBody(('data: ' + json.dumps(first) + '\n\ndata: ' + json.dumps(second) + '\n\n').encode())
        events = OpenAIBackendAPI._iter_codex_response_events(raw)
        self.assertEqual(next(events), first)
        self.assertLess(raw.tell(), len(raw.getvalue()))
        self.assertEqual(list(events), [second])

    def test_streams_local_reference_files_into_the_json_request_in_order(self):
        backend = self.backend()
        data = b'\x89PNG\r\n\x1a\n' + os.urandom(120_007)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'reference.png'
            path.write_bytes(data)
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('must encode reference files in chunks')):
                list(backend.iter_codex_image_response_events(prompt='中文 "prompt"', images=[str(path), 'data:image/png;base64,b2s=']))
        content = backend.sent_payload['input'][0]['content']
        self.assertEqual(content[0]['text'], '中文 "prompt"')
        self.assertEqual(base64.b64decode(content[1]['image_url'].split(',')[1], validate=True), data)
        self.assertEqual(content[2]['image_url'], 'data:image/png;base64,b2s=')
        self.assertEqual(backend.session.curl_options, {})

    def test_sse_multiline_json_errors_and_final_event_without_separator(self):
        from services.openai_backend_api import OpenAIBackendAPI
        raw = io.BytesIO(b': comment\r\nevent: ignored\r\ndata: {"type":\r\ndata: "response.completed"}\r\n\r\ndata: invalid\n\ndata: [DONE]\n\ndata: {"type":"last"}')
        raw.headers = {'content-type': 'text/event-stream'}
        self.assertEqual(list(OpenAIBackendAPI._iter_codex_response_events(raw)), [{'type': 'response.completed'}, {'type': 'last'}])

    def test_accepts_json_response_with_the_same_transport(self):
        event = {'output': [{'type': 'image_generation_call', 'result': 'b2s='}]}
        backend = self.backend(json.dumps(event).encode())
        backend.session.post.return_value.headers = {'content-type': 'application/json'}
        self.assertEqual(list(backend.iter_codex_image_response_events(prompt='test')), [event])

    def test_file_transport_preserves_chunked_http_errors_and_truncation(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from curl_cffi import requests
        from curl_cffi.requests.exceptions import RequestException
        event = {'type': 'response.completed', 'response': {'output': [{'type': 'image_generation_call', 'result': 'b2s='}]}}
        response_body = ('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode()
        received = []
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *_): pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append(payload)
                mode = payload['input'][0]['content'][0]['text']
                self.send_response(400 if mode == 'error' else 200)
                self.send_header('Content-Type', 'application/json' if mode == 'error' else 'text/event-stream')
                self.send_header('Connection', 'close')
                self.close_connection = True
                if mode == 'error':
                    body = b'{"error":{"code":"model_not_found"}}'
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers(); self.wfile.write(body)
                elif mode == 'truncated':
                    self.send_header('Content-Length', str(len(response_body) + 500))
                    self.end_headers(); self.wfile.write(response_body)
                else:
                    self.send_header('Transfer-Encoding', 'chunked')
                    self.end_headers()
                    for index in range(0, len(response_body), 17):
                        chunk = response_body[index:index + 17]
                        self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                    self.wfile.write(b'0\r\n\r\n')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        backend = self.backend()
        backend.session = requests.Session(impersonate='edge101')
        backend.base_url = f'http://127.0.0.1:{server.server_port}'
        try:
            self.assertEqual(list(backend.iter_codex_image_response_events(prompt='success', images=['data:image/png;base64,b2s='])), [event])
            self.assertEqual(received[0]['input'][0]['content'][1]['image_url'], 'data:image/png;base64,b2s=')
            with self.assertRaisesRegex(Exception, 'model_not_found'):
                list(backend.iter_codex_image_response_events(prompt='error'))
            with self.assertRaises(RequestException):
                list(backend.iter_codex_image_response_events(prompt='truncated'))
            self.assertEqual(len(received), 3)  # no automatic generation replay, including incomplete HTTP transfers
            self.assertEqual(backend.session.curl_options, {})
        finally:
            backend.session.close()
            server.shutdown(); server.server_close(); thread.join(2)

    def test_bounds_result_processing_without_serializing_upstream_requests(self):
        from services import openai_backend_api
        release, entered = threading.Event(), threading.Event()
        lock = threading.Lock()
        counts = {'active': 0, 'peak': 0}
        backends = [self.backend() for _ in range(4)]
        errors = []
        def parse(_):
            with lock:
                counts['active'] += 1
                counts['peak'] = max(counts['peak'], counts['active'])
                if counts['active'] == 2: entered.set()
            try:
                if not release.wait(3): raise RuntimeError('test barrier timed out')
                yield {'type': 'image_generation_call', 'result': 'b2s='}
            finally:
                with lock: counts['active'] -= 1
        def run(backend):
            try: list(backend.iter_codex_image_response_events(prompt='test'))
            except Exception as error: errors.append(error)
        with patch.object(openai_backend_api, 'image_processing_slots', threading.BoundedSemaphore(2)):
            for backend in backends: backend._iter_codex_response_events = parse
            threads = [threading.Thread(target=run, args=(backend,)) for backend in backends]
            try:
                for thread in threads: thread.start()
                self.assertTrue(entered.wait(2))
                deadline = time.monotonic() + 2
                while sum(backend.session.post.call_count for backend in backends) < 4 and time.monotonic() < deadline: time.sleep(0.01)
                self.assertTrue(all(backend.session.post.call_count == 1 for backend in backends))
                self.assertEqual(counts['peak'], 2)
            finally:
                release.set()
                for thread in threads: thread.join(3)
        self.assertEqual(errors, [])
        self.assertEqual(counts['active'], 0)

    def test_drops_duplicate_image_events_and_closes_the_transport(self):
        from services.protocol import conversation
        backend = Mock()
        closed = []
        def events(**_):
            try:
                yield {'type': 'response.output_item.done', 'item': {'type': 'image_generation_call', 'result': 'b2s='}}
                raise AssertionError('must not retain duplicate results in response.completed')
            finally: closed.append(True)
        backend.iter_codex_image_response_events.side_effect = events
        results = conversation.stream_codex_image_outputs(backend, conversation.ConversationRequest(model='codex-gpt-image-2', prompt='test'))
        self.assertEqual(next(results).data[0]['b64_json'], 'b2s=')
        self.assertEqual(closed, [])
        results.close()
        self.assertEqual(closed, [True])

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

class WorkerTests(unittest.TestCase):
    def setUp(self):
        with patch('sys.stdin', io.StringIO(json.dumps({'action': 'probe'}))), contextlib.redirect_stdout(io.StringIO()):
            self.ctx = runpy.run_path(str(Path(__file__).with_name('bridge.py')))

    def serve(self, requests, factory):
        from services import openai_backend_api
        lines = ''.join(json.dumps({'id': index, 'payload': request}) + '\n' for index, request in enumerate(requests))
        output = io.StringIO()
        with patch.object(openai_backend_api, 'OpenAIBackendAPI', side_effect=factory):
            self.ctx['serve'](io.StringIO(lines), output)
        return {item['id']: item for item in map(json.loads, output.getvalue().splitlines())}

    def test_runs_requests_concurrently_and_keeps_accounts_apart(self):
        barrier, seen = threading.Barrier(2, timeout=5), {}
        def factory(token):
            # Both requests must be in flight at once, or the barrier times out.
            seen[token] = sys.modules['services.account_service'].account_service.get_account(token)['email']
            backend = Mock()
            def events(**_):
                barrier.wait()
                return iter([{'type': 'image_generation_call', 'result': base64.b64encode(token.encode()).decode()}])
            backend.iter_codex_image_response_events.side_effect = events
            return backend
        with tempfile.TemporaryDirectory() as directory:
            requests = [{'action': 'generate', 'account': {'source_type': 'codex', 'access_token': f'token-{name}', 'email': f'{name}@example.com'}, 'prompt': name, 'model': 'codex-gpt-image-2', 'output': str(Path(directory) / f'{name}.png')} for name in ['a', 'b']]
            results = self.serve(requests, factory)
            for index, name in enumerate(['a', 'b']):
                self.assertTrue(results[index]['ok'], results[index])
                self.assertEqual(results[index]['credentials']['access_token'], f'token-{name}')
                self.assertEqual((Path(directory) / f'{name}.png').read_bytes(), f'token-{name}'.encode())
        self.assertEqual(seen, {'token-a': 'a@example.com', 'token-b': 'b@example.com'})
        self.assertEqual(self.ctx['_accounts'], {})

    def test_one_failed_request_does_not_affect_another(self):
        def factory(token):
            backend = Mock()
            if token == 'token-bad': backend.iter_codex_image_response_events.side_effect = RuntimeError('upstream rejected token-bad')
            else: backend.iter_codex_image_response_events.return_value = iter([{'type': 'image_generation_call', 'result': 'b2s='}])
            return backend
        with tempfile.TemporaryDirectory() as directory:
            requests = [{'action': 'generate', 'account': {'source_type': 'codex', 'access_token': f'token-{name}'}, 'prompt': name, 'model': 'codex-gpt-image-2', 'output': str(Path(directory) / f'{name}.png')} for name in ['bad', 'good']]
            results = self.serve(requests, factory)
        self.assertFalse(results[0]['ok'])
        self.assertNotIn('token-bad', results[0]['error'])
        self.assertTrue(results[1]['ok'])

    def test_each_request_keeps_its_own_timeout(self):
        config = sys.modules['services.config'].config
        second_started, seen = threading.Event(), {}
        def factory(token):
            backend = Mock()
            def events(**_):
                # The first request reads its timeout only after the second one has started.
                if token == 'token-first': second_started.wait(5)
                else: second_started.set()
                seen[token] = config.image_poll_timeout_secs
                return iter([{'type': 'image_generation_call', 'result': 'b2s='}])
            backend.iter_codex_image_response_events.side_effect = events
            return backend
        with tempfile.TemporaryDirectory() as directory:
            requests = [{'action': 'generate', 'timeout': timeout, 'account': {'source_type': 'codex', 'access_token': f'token-{name}'}, 'prompt': name, 'model': 'codex-gpt-image-2', 'output': str(Path(directory) / f'{name}.png')} for name, timeout in [('first', 600), ('second', 60)]]
            self.serve(requests, factory)
        self.assertEqual(seen, {'token-first': 600, 'token-second': 60})

    def test_idle_worker_does_not_keep_the_previous_request(self):
        import gc, tracemalloc
        tracemalloc.start()
        try:
            box, held = [json.dumps({'id': 0, 'payload': {'action': 'probe', 'images': ['data:image/png;base64,' + 'A' * (8 * 1024 * 1024)]}}) + '\n'], []
            def lines():
                yield box.pop()
                time.sleep(0.3); gc.collect()
                held.append(tracemalloc.get_traced_memory()[0])  # request finished, worker waiting for the next line
            self.ctx['serve'](lines(), io.StringIO())
        finally: tracemalloc.stop()
        self.assertLess(held[0], 4 * 1024 * 1024)

    def test_reference_paths_reach_the_protocol_without_inline_copies(self):
        png = b'\x89PNG\r\n\x1a\n' + b'pixels'
        captured = {}
        def factory(token):
            backend = Mock()
            def events(**kwargs):
                captured['images'] = kwargs['images']
                return iter([{'type': 'image_generation_call', 'result': 'b2s='}])
            backend.iter_codex_image_response_events.side_effect = events
            return backend
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / 'reference'
            reference.write_bytes(png)
            results = self.serve([{'action': 'generate', 'account': {'source_type': 'codex', 'access_token': 'token'}, 'prompt': 'x', 'model': 'codex-gpt-image-2', 'images': [str(reference), 'data:image/png;base64,abc'], 'output': str(Path(directory) / 'out.png')}], factory)
            self.assertTrue(results[0]['ok'], results[0])
            self.assertEqual(captured['images'], [str(reference), 'data:image/png;base64,abc'])

if __name__ == '__main__':
    unittest.main()
