"""Isolated upstream protocol adapter. Credentials arrive only through stdin.

The application owns storage, auth, account scheduling, retries, and OSS uploads.
Only the ChatGPT wire protocol is retained from basketikun/chatgpt2api.
"""
from __future__ import annotations
import base64
import contextlib
import json
import os
from pathlib import Path
import sys
import time
import types
from curl_cffi.requests.exceptions import RequestException

payload = json.load(sys.stdin)
account = payload.get('account', {})
token = account.get('access_token', '')
TRANSIENT_CURL_CODES = {5, 6, 7, 18, 28, 35, 52, 55, 56, 92}

def is_network_error(error):
    return isinstance(error, RequestException) and int(error.code or 0) in TRANSIENT_CURL_CODES

def credential_values():
    return {key: account[key] for key in ['access_token', 'refresh_token', 'id_token', 'client_id', 'token_endpoint', 'expires_at'] if account.get(key)}
sys.path.insert(0, str(Path(__file__).parent / 'protocol'))

class RuntimeConfig:
    default_upstream_model_name = 'auto'
    default_thinking_effort = 'auto'
    global_system_prompt = ''
    image_poll_timeout_secs = int(payload.get('timeout', 600))
    image_poll_initial_wait_secs = 3
    image_poll_interval_secs = 5
    image_settle_enabled = False
    image_check_before_hit_enabled = False
    image_settle_secs = 0
    image_parallel_generation = False
    image_remove_conversation_after_result = True
    image_remove_conversation_always = False
    log_levels = ['error']
    def get_proxy_settings(self): return account.get('proxy', '')
    def get_proxy_runtime_settings(self): return {'enabled': False, 'egress_mode': 'direct', 'clearance': {'enabled': False}}

class AccountContext:
    def get_account(self, value): return account if value == token else None
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

module('services.config', config=RuntimeConfig())
module('services.account_service', account_service=AccountContext())
module('services.image_storage_service', image_storage_service=None)

def refreshed_account():
    from curl_cffi import requests
    info = AccountContext._decode_jwt_payload(account.get('access_token', ''))
    expires_at = int(account.get('expires_at') or info.get('exp') or 0)
    if account.get('refresh_token') and expires_at < time.time() + 300:
        kwargs = {'proxy': account['proxy']} if account.get('proxy') else {}
        token_endpoint = account.get('token_endpoint') or 'https://auth.openai.com/oauth/token'
        if token_endpoint not in ('https://auth.openai.com/oauth/token', 'https://auth.openai.com/api/accounts/oauth/token'):
            raise RuntimeError('不支持这个凭证刷新地址')
        default_client = 'app_EMoamEEZ73f0CkXaXp7hrann' if account.get('source_type') == 'codex' else 'app_2SKx67EdpoN0G6j64rFvigXD'
        response = requests.post(token_endpoint, data={
            'grant_type': 'refresh_token', 'refresh_token': account['refresh_token'],
            'client_id': account.get('client_id') or default_client,
        }, timeout=30, **kwargs)
        if response.status_code != 200:
            raise RuntimeError(f'登录凭证刷新失败（HTTP {response.status_code}），请重新授权账号')
        values = response.json()
        if not values.get('access_token'): raise RuntimeError('刷新未返回登录凭证')
        for key in ['access_token', 'refresh_token', 'id_token']:
            if values.get(key): account[key] = values[key]
        if values.get('expires_in'):
            account['expires_at'] = int(time.time()) + int(values['expires_in'])
    return account

def execute():
    global token
    if payload.get('action') == 'probe':
        from services.openai_backend_api import OpenAIBackendAPI
        from services.protocol import conversation
        return {'ok': True, 'protocol': 'chatgpt2api', 'commit': '92dd80e'}
    refreshed_account()
    token = account['access_token']
    from services.openai_backend_api import OpenAIBackendAPI
    backend = OpenAIBackendAPI(token)
    try:
        if payload.get('action') == 'refresh':
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
                    backend = OpenAIBackendAPI(token)
            return {'info': info, 'credentials': credential_values()}
        from services.protocol import conversation
        # Keep the bytes in this process and write one result to the spool; no base64 IPC output.
        def format_result(items, prompt, response_format, base_url=None, created=None, message=''):
            return {'created': created or int(time.time()), 'data': items}
        conversation.format_image_result = format_result
        request = conversation.ConversationRequest(
            prompt=payload['prompt'], model=payload['model'], n=1,
            images=payload.get('images') or [], size=payload.get('size') or '1024x1024',
            quality=payload.get('quality') or 'auto', response_format='b64_json', message_as_error=True,
        )
        source = conversation.stream_codex_image_outputs if account.get('source_type') == 'codex' else conversation.stream_image_outputs
        for result in source(backend, request):
            if result.kind == 'message': raise RuntimeError('上游未生成图片：' + str(result.text or '')[:200])
            if result.kind != 'result': continue
            for item in result.data:
                if not item.get('b64_json'): continue
                raw = base64.b64decode(item['b64_json'], validate=True)
                target = Path(payload['output'])
                temp = target.with_suffix('.part')
                temp.write_bytes(raw)
                temp.replace(target)
                return {'path': str(target), 'bytes': len(raw), 'mime': 'image/png',
                        'credentials': {key: account[key] for key in ['access_token', 'refresh_token', 'id_token', 'client_id', 'token_endpoint', 'expires_at'] if account.get(key)}}
        raise RuntimeError('上游未返回图片结果')
    finally:
        backend.close()

try:
    with contextlib.redirect_stdout(sys.stderr): result = execute()
    print(json.dumps({'ok': True, **result}, ensure_ascii=False))
except Exception as exc:
    text = str(exc)
    for key in ['access_token', 'refresh_token', 'id_token', 'proxy']:
        if account.get(key): text = text.replace(account[key], '[redacted]')
    # A token may have rotated before an account check failed. Preserve it through
    # this private IPC channel so a network failure cannot lose the refresh token.
    print(json.dumps({'ok': False, 'error': text[:500], 'error_kind': 'network' if is_network_error(exc) else 'upstream', 'credentials': credential_values()}, ensure_ascii=False))
    sys.exit(1)
