"""Linux-only, no-network-upstream memory benchmark for Bun + four real Python workers.

Run with the adapter venv: python scripts/benchmark-memory.py --max-mib 1024
The loopback server sends two SSE events containing the same 3 MiB PNG, as in a completed image response.
PSS excludes this fixture server and OS file cache; this is not a container memory-limit test.
"""
import argparse, base64, hashlib, io, json, os, pathlib, select, shutil, signal, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON = sys.executable
BUN = shutil.which('bun')
if not BUN or not pathlib.Path('/proc/self/smaps_rollup').exists():
    raise SystemExit('Requires Bun, Linux /proc, and the adapter Python dependencies.')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--max-mib', type=float, default=1024, help='Fail when sampled worker+Bun PSS exceeds this value.')
args = parser.parse_args()
failed = False
workspace = tempfile.TemporaryDirectory(prefix='atelier-memory-check-')
DIR = pathlib.Path(workspace.name)
image = Image.frombytes('RGB', (1024, 1024), os.urandom(1024 * 1024 * 3))
encoded = io.BytesIO()
image.save(encoded, format='PNG')
png = encoded.getvalue()
(DIR / 'reference.png').write_bytes(png)
b64 = base64.b64encode(png).decode('ascii')
item = {'type': 'image_generation_call', 'result': b64}
events = [{'type': 'response.output_item.done', 'item': item}, {'type': 'response.completed', 'response': {'output': [item]}}]
body = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode() + b'data: [DONE]\n\n'
gate, lock = threading.Event(), threading.Lock()
accepted = 0

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def do_POST(self):
        global accepted
        count = int(self.headers.get('Content-Length', '0'))
        while count:
            chunk = self.rfile.read(min(count, 65536))
            if not chunk: break
            count -= len(chunk)
        with lock: accepted += 1
        gate.wait(100)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass

class Server(ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True

server = Server(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
(DIR / 'review_backend.py').write_text('from services.openai_backend_api import OpenAIBackendAPI as Original\nclass OpenAIBackendAPI(Original):\n    def __init__(self, token):\n        super().__init__(token)\n        self.base_url = "http://127.0.0.1:%d"\n' % server.server_port)
(DIR / 'python-worker').write_text('#!' + PYTHON + '\nimport pathlib, sys\np = pathlib.Path(sys.argv[1]); sys.argv = sys.argv[1:]\nsource = p.read_text()\nneedle = "from services.openai_backend_api import OpenAIBackendAPI"\nif needle not in source: raise RuntimeError("Cannot install loopback backend; refusing to run")\nsource = source.replace(needle, "from review_backend import OpenAIBackendAPI")\nexec(compile(source, str(p), "exec"), {"__file__": str(p), "__name__": "__main__"})\n')
(DIR / 'python-worker').chmod(0o700)
(DIR / 'harness.ts').write_text('''
const {bridge,stopAdapters,adapterStats}=await import(__ADAPTER_PATH__)
await Promise.all(Array.from({length:4},()=>bridge({action:'probe'},60)))
console.log(JSON.stringify({phase:'warm',workers:adapterStats().workers.map(w=>w.pid)}))
await Bun.sleep(200)
const promises=Array.from({length:100},(_,i)=>bridge({action:'generate',account:{access_token:'fake-test-token-'+i,source_type:'codex'},prompt:'memory benchmark',model:'codex-gpt-image-2',size:'1024x1024',quality:'auto',images:process.env.WITH_REF==='1'?[process.env.REF_FILE]:[],output:process.env.DATA_DIR+'/'+i+'.png',timeout:90},90).then(r=>r.ok, e=>String(e)))
const results=await Promise.all(promises)
console.log(JSON.stringify({phase:'done',ok:results.filter(r=>r===true).length,errors:results.filter(r=>r!==true).slice(0,3)}))
await Bun.sleep(2000)
stopAdapters()
if (results.some(r=>r!==true)) process.exitCode=1
'''.replace('__ADAPTER_PATH__', json.dumps(str(ROOT / 'server' / 'adapter.ts'))))

def memory(pids):
    values = {'rss': 0, 'pss': 0}
    for pid in pids:
        try:
            for line in pathlib.Path('/proc/%s/smaps_rollup' % pid).read_text().splitlines():
                if line.startswith('Rss:'): values['rss'] += int(line.split()[1])
                elif line.startswith('Pss:'): values['pss'] += int(line.split()[1])
        except (FileNotFoundError, ProcessLookupError): pass
    return {k: round(v / 1024, 1) for k,v in values.items()}

print(json.dumps({'commit':subprocess.check_output(['git','rev-parse','--short','HEAD'],cwd=ROOT,text=True).strip(),'python':subprocess.check_output([PYTHON,'--version'],text=True).strip(),'png_mib':round(len(png)/1048576,2),'sse_mib':round(len(body)/1048576,2),'output_dir':str(DIR)}), flush=True)
for with_ref in (False, True):
    accepted = 0
    gate.clear()
    env = {**os.environ,'DATA_DIR':str(DIR/('refs' if with_ref else 'plain')),'ADMIN_KEY':'memory-test-fake-admin-key-000000','MASTER_KEY':'00'*32,'PYTHON_BIN':str(DIR/'python-worker'),'ADAPTER_WORKERS':'4','ADAPTER_POOL':'1','PYTHONDONTWRITEBYTECODE':'1','WITH_REF':'1' if with_ref else '0','REF_FILE':str(DIR/'reference.png'),'NO_PROXY':'*'}
    process = subprocess.Popen([BUN,str(DIR/'harness.ts')],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
    pids = [process.pid]
    peak = {'rss':0,'pss':0}
    sample_count = 0
    wait_reported = False
    started = time.monotonic()
    try:
        while process.poll() is None and time.monotonic()-started < 100:
            ready,_,_=select.select([process.stdout],[],[],0.02)
            if ready:
                line = process.stdout.readline().strip()
                if line:
                    result = json.loads(line)
                    print(json.dumps({'refs':with_ref,**result}),flush=True)
                    if result['phase']=='warm':
                        pids += result['workers']
                        print(json.dumps({'refs':with_ref,'phase':'baseline','memory_mib':memory(pids)}),flush=True)
            sample = memory(pids)
            sample_count += 1
            for key in peak: peak[key] = max(peak[key],sample[key])
            if accepted==100 and not wait_reported:
                time.sleep(0.2)
                print(json.dumps({'refs':with_ref,'phase':'waiting-100','memory_mib':memory(pids)}),flush=True)
                wait_reported=True
                gate.set()
        if process.poll() is None: process.terminate()
        _,err=process.communicate(timeout=10)
        files = list(pathlib.Path(env['DATA_DIR']).glob('*.png'))
        expected = hashlib.sha256(png).digest()
        valid = sum(hashlib.sha256(path.read_bytes()).digest() == expected for path in files)
        passed = process.returncode == 0 and accepted == valid == 100 and peak['pss'] <= args.max_mib
        failed |= not passed
        print(json.dumps({'refs':with_ref,'phase':'summary','peak_mib':peak,'accepted':accepted,'valid_images':valid,'samples':sample_count,'exit':process.returncode,'passed':passed,'stderr':err[:500]}),flush=True)
    finally:
        gate.set()
        if process.poll() is None: process.kill()
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
server.shutdown()
workspace.cleanup()
raise SystemExit(1 if failed else 0)
