"""Isolated upstream protocol adapter. Credentials arrive only through stdin.

The application owns storage, auth, account scheduling, retries, and OSS uploads.
Only the ChatGPT wire protocol is retained from basketikun/chatgpt2api.

Single-shot mode reads one JSON request from stdin and prints one result.
With --worker the process stays alive, reads one {"id", "payload"} line per request,
runs each request on its own thread and writes {"id", ...result} lines back.
"""
from __future__ import annotations
import base64
import contextlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import types
from curl_cffi.requests.exceptions import RequestException

WORKER = '--worker' in sys.argv[1:]
payload = {} if WORKER else json.load(sys.stdin)
account = payload.get('account', {})
token = account.get('access_token', '')
TRANSIENT_CURL_CODES = {5, 6, 7, 18, 28, 35, 52, 55, 56, 92}
CREDENTIAL_KEYS = ['access_token', 'refresh_token', 'id_token', 'client_id', 'token_endpoint', 'expires_at']

def is_network_error(error):
    return isinstance(error, RequestException) and int(error.code or 0) in TRANSIENT_CURL_CODES

def credential_values(values=None):
    values = account if values is None else values
    return {key: values[key] for key in CREDENTIAL_KEYS if values.get(key)}
sys.path.insert(0, str(Path(__file__).parent / 'protocol'))

# Requests in a worker share the protocol modules, so per-request state is looked up
# by access token (accounts) or kept on the request's thread (proxy fallback).
_local = threading.local()
_accounts: dict[str, list] = {}
_accounts_lock = threading.Lock()

def register_account(values):
    value = values.get('access_token', '')
    with _accounts_lock:
        entry = _accounts.setdefault(value, [values, 0])
        entry[0] = values
        entry[1] += 1
    return value

def release_account(value):
    with _accounts_lock:
        entry = _accounts.get(value)
        if entry:
            entry[1] -= 1
            if entry[1] <= 0: del _accounts[value]

_default_timeout = int(payload.get('timeout', 600))

class RuntimeConfig:
    default_upstream_model_name = 'auto'
    default_thinking_effort = 'auto'
    global_system_prompt = ''
    # Each request carries its own timeout; the setting can change while earlier requests are still running.
    @property
    def image_poll_timeout_secs(self): return getattr(_local, 'timeout', None) or _default_timeout
    image_poll_initial_wait_secs = 3
    image_poll_interval_secs = 5
    image_settle_enabled = False
    image_check_before_hit_enabled = False
    image_settle_secs = 0
    image_parallel_generation = False
    image_remove_conversation_after_result = True
    image_remove_conversation_always = False
    log_levels = ['error']
    def get_proxy_settings(self): return (getattr(_local, 'account', None) or account).get('proxy', '')
    def get_proxy_runtime_settings(self): return {'enabled': False, 'egress_mode': 'direct', 'clearance': {'enabled': False}}

class AccountContext:
    def get_account(self, value):
        with _accounts_lock:
            entry = _accounts.get(value)
        return entry[0] if entry else None
    @staticmethod
    def _decode_jwt_payload(value):
        try:
            part = value.split('.')[1]
            return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        except Exception: return {}

def module(name, **values):
    item = types.ModuleType(name)
    item.__dict__.update(values)
    sys.modules[name] = item

config = RuntimeConfig()
module('services.config', config=config)
module('services.account_service', account_service=AccountContext())
module('services.image_storage_service', image_storage_service=None)

def refreshed_account(values=None):
    from curl_cffi import requests
    values = account if values is None else values
    info = AccountContext._decode_jwt_payload(values.get('access_token', ''))
    expires_at = int(values.get('expires_at') or info.get('exp') or 0)
    if values.get('refresh_token') and expires_at < time.time() + 300:
        kwargs = {'proxy': values['proxy']} if values.get('proxy') else {}
        token_endpoint = values.get('token_endpoint') or 'https://auth.openai.com/oauth/token'
        if token_endpoint not in ('https://auth.openai.com/oauth/token', 'https://auth.openai.com/api/accounts/oauth/token'):
            raise RuntimeError('不支持这个凭证刷新地址')
        default_client = 'app_EMoamEEZ73f0CkXaXp7hrann' if values.get('source_type') == 'codex' else 'app_2SKx67EdpoN0G6j64rFvigXD'
        response = requests.post(token_endpoint, data={
            'grant_type': 'refresh_token', 'refresh_token': values['refresh_token'],
            'client_id': values.get('client_id') or default_client,
        }, timeout=30, **kwargs)
        if response.status_code != 200:
            raise RuntimeError(f'登录凭证刷新失败（HTTP {response.status_code}），请重新授权账号')
        result = response.json()
        if not result.get('access_token'): raise RuntimeError('刷新未返回登录凭证')
        for key in ['access_token', 'refresh_token', 'id_token']:
            if result.get(key): values[key] = result[key]
        if result.get('expires_in'):
            values['expires_at'] = int(time.time()) + int(result['expires_in'])
    return values

def reference_image(value, inline):
    # References arrive as local file paths so large images never cross the IPC pipe.
    # The web protocol reads paths itself; Codex requests need the image inline as a data URL.
    if not inline or value.startswith('data:') or len(value) > 4096 or not os.path.isfile(value): return value
    data = Path(value).read_bytes()
    mime = 'image/png' if data[:8] == b'\x89PNG\r\n\x1a\n' else 'image/jpeg' if data[:3] == b'\xff\xd8\xff' else 'image/webp' if data[:4] == b'RIFF' and data[8:12] == b'WEBP' else 'application/octet-stream'
    return f'data:{mime};base64,{base64.b64encode(data).decode("ascii")}'

# Keep the bytes in this process and write one result to the spool; no base64 IPC output.
def format_result(items, prompt, response_format, base_url=None, created=None, message=''):
    return {'created': created or int(time.time()), 'data': items}

def execute(request=None):
    global token
    request = payload if request is None else request
    values = request.get('account') or {}
    if request.get('action') == 'probe':
        from services.openai_backend_api import OpenAIBackendAPI
        from services.protocol import conversation
        return {'ok': True, 'protocol': 'chatgpt2api', 'commit': '92dd80e'}
    _local.account = values
    _local.timeout = int(request['timeout']) if request.get('timeout') else None
    refreshed_account(values)
    current = register_account(values)
    if not WORKER: token = current
    from services.openai_backend_api import OpenAIBackendAPI
    backend = OpenAIBackendAPI(current)
    try:
        if request.get('action') == 'refresh':
            # Only read-only account checks are retried. Never replay image generation.
            for attempt in range(3):
                try:
                    info = backend.get_user_info()
                    break
                except RequestException as error:
                    if not is_network_error(error) or attempt == 2:
                        raise
                    backend.close()
                    time.sleep(0.3 * (attempt + 1))
                    backend = OpenAIBackendAPI(current)
            return {'info': info, 'credentials': credential_values(values)}
        from services.protocol import conversation
        conversation.format_image_result = format_result
        codex = values.get('source_type') == 'codex'
        image_request = conversation.ConversationRequest(
            prompt=request['prompt'], model=request['model'], n=1,
            images=[reference_image(item, codex) for item in request.get('images') or []], size=request.get('size') or '1024x1024',
            quality=request.get('quality') or 'auto', response_format='b64_json', message_as_error=True,
        )
        source = conversation.stream_codex_image_outputs if codex else conversation.stream_image_outputs
        for result in source(backend, image_request):
            if result.kind == 'message': raise RuntimeError('上游未生成图片：' + str(result.text or '')[:200])
            if result.kind != 'result': continue
            for item in result.data:
                if not item.get('b64_json'): continue
                raw = base64.b64decode(item['b64_json'], validate=True)
                target = Path(request['output'])
                temp = target.with_suffix('.part')
                temp.write_bytes(raw)
                temp.replace(target)
                return {'path': str(target), 'bytes': len(raw), 'mime': 'image/png', 'credentials': credential_values(values)}
        raise RuntimeError('上游未返回图片结果')
    finally:
        backend.close()
        release_account(current)
        _local.account = _local.timeout = None

def handle(request):
    values = request.get('account') or {}
    try:
        return {'ok': True, **execute(request)}
    except Exception as exc:
        text = str(exc)
        for key in ['access_token', 'refresh_token', 'id_token', 'proxy']:
            if values.get(key): text = text.replace(values[key], '[redacted]')
        # A token may have rotated before an account check failed. Preserve it through
        # this private IPC channel so a network failure cannot lose the refresh token.
        return {'ok': False, 'error': text[:500], 'error_kind': 'network' if is_network_error(exc) else 'upstream', 'credentials': credential_values(values)}

def serve(lines, output):
    lock, threads = threading.Lock(), []
    def run(box):
        try: message = json.loads(box.pop())
        except ValueError: return
        result = handle(message.pop('payload', None) or {})
        text = json.dumps({'id': message.get('id'), **result}, ensure_ascii=False)
        with lock:
            output.write(text + '\n')
            output.flush()
    for line in lines:
        if not line.strip(): continue
        # Hand the raw line over in a box the thread empties, and drop our reference before blocking on
        # the next read, so an idle worker does not keep the previous request (and its images) alive.
        thread = threading.Thread(target=run, args=([line],), daemon=True)
        del line
        thread.start()
        threads.append(thread)
        threads = [item for item in threads if item.is_alive()]
    for thread in threads: thread.join()

if WORKER:
    # Protocol code may print; keep the real stdout exclusively for result lines.
    channel = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8')
    sys.stdout = sys.stderr
    from services.openai_backend_api import OpenAIBackendAPI
    from services.protocol import conversation
    serve(sys.stdin, channel)
    os._exit(0)
else:
    with contextlib.redirect_stdout(sys.stderr): outcome = handle(payload)
    print(json.dumps(outcome, ensure_ascii=False))
    if not outcome['ok']: sys.exit(1)
