"""Keep image transfer buffers bounded while upstream requests remain concurrent."""
import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile
import threading


def _processing_limit():
    try: return max(1, min(32, int(os.environ.get('ADAPTER_IMAGE_PROCESSING', '2'))))
    except ValueError: return 2


image_processing_slots = threading.BoundedSemaphore(_processing_limit())


def _write_image(output, value):
    path = Path(value) if len(value) <= 4096 and not value.startswith('data:') and os.path.isfile(value) else None
    if path is None:
        inline = value if value.startswith('data:image/') else 'data:image/png;base64,' + value
        output.write(json.dumps(inline).encode('utf-8'))
        return
    with path.open('rb') as image:
        head = image.read(12)
        mime = 'image/png' if head[:8] == b'\x89PNG\r\n\x1a\n' else 'image/jpeg' if head[:3] == b'\xff\xd8\xff' else 'image/webp' if head[:4] == b'RIFF' and head[8:12] == b'WEBP' else 'application/octet-stream'
        image.seek(0)
        output.write(('"data:' + mime + ';base64,').encode('ascii'))
        # A multiple of three keeps every block except the last free of base64 padding.
        for chunk in iter(lambda: image.read(48 * 1024), b''):
            output.write(base64.b64encode(chunk))
        output.write(b'"')


@contextmanager
def codex_request_body(payload, images):
    """Serialize JSON and local references to an anonymous file, without inline image copies in RAM."""
    with tempfile.TemporaryFile() as body:
        body.write(b'{')
        for index, (key, value) in enumerate(payload.items()):
            if index: body.write(b',')
            body.write(json.dumps(key).encode('utf-8') + b':')
            if key != 'input':
                body.write(json.dumps(value, separators=(',', ':')).encode('utf-8'))
                continue
            content = value[0]['content']
            body.write(b'[{"role":"user","content":[')
            body.write(json.dumps(content[0], separators=(',', ':')).encode('utf-8'))
            for image in images:
                body.write(b',{"type":"input_image","image_url":')
                _write_image(body, image)
                body.write(b'}')
            body.write(b']}]')
        body.write(b'}')
        size = body.tell()
        body.seek(0)
        yield body, size
