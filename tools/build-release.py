#!/usr/bin/env python3
"""Packs the app into a downloadable ZIP and (with --publish) puts it on
GitHub as a release.

What goes in: the 2D sheet, the 3D mode, three.js, icons, the service worker
— the site as deployed. One file is rebuilt on the way: 3d/index.html. As
deployed it loads the 3D mode as ES modules from separate files, which a
browser refuses to do for a page opened straight from a file on the phone
(file://, CORS). In the ZIP the modules are folded into the page itself
(an import map of data: URLs plus the app inlined), so it opens from a
folder with no server — and still works when served normally.

    python3 tools/build-release.py            # writes dist/creslarnet-<date>.zip
    python3 tools/build-release.py --publish  # ...and creates the GitHub release
"""
import base64
import datetime
import io
import json
import os
import re
import subprocess
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = 'lebichnazar19-create/creslarnet'

FILES = [
    'index.html', 'style.css', 'script.js', 'manifest.json', 'service-worker.js',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
    '3d/style.css', '3d/vendor/three/LICENSE',
]
# modules folded into 3d/index.html: bare name -> file; each file's own
# relative imports are rewritten to these bare names
MODULES = {
    'three': '3d/vendor/three/three.module.min.js',
    'csg': '3d/csg.js',
    'materials': '3d/materials.js',
    'transform-controls': '3d/vendor/three/TransformControls.js',
}
REWRITES = {
    "'./vendor/three/three.module.min.js'": "'three'",
    "'./csg.js'": "'csg'",
    "'./materials.js'": "'materials'",
    "'./vendor/three/TransformControls.js'": "'transform-controls'",
}

README = """Creslarnet — локальна копія

ЯК ВІДКРИТИ НА ТЕЛЕФОНІ
1. Розпакуйте цей архів у будь-яку папку (наприклад, у «Завантаження»).
2. Відкрийте файл index.html у Chrome (через застосунок «Файли»:
   натисніть на index.html → «Відкрити за допомогою» → Chrome).
   Це 2D-режим; кнопка «3D-режим» у ньому відкриває 3d/index.html.
3. Інтернет не потрібен.

Якщо з файлу щось не відкривається, надійніший спосіб — встановити
застосунок із сайту (він теж працює без інтернету):
   https://lebichnazar19-create.github.io/creslarnet/
   → меню Chrome (⋮) → «Встановити застосунок».
"""


def read(rel, binary=False):
    with open(os.path.join(ROOT, rel), 'rb' if binary else 'r', encoding=None if binary else 'utf-8') as f:
        return f.read()


def rewrite_imports(src):
    for old, new in REWRITES.items():
        src = src.replace('from ' + old, 'from ' + new)
    return src


def data_url(src):
    return 'data:text/javascript;base64,' + base64.b64encode(src.encode('utf-8')).decode('ascii')


def build_3d_index():
    html = read('3d/index.html')
    imports = {name: data_url(rewrite_imports(read(path))) for name, path in MODULES.items()}
    importmap = '<script type="importmap">' + json.dumps({'imports': imports}) + '</script>'
    html, n = re.subn(r'<script type="importmap">.*?</script>', lambda m: importmap, html, count=1, flags=re.S)
    assert n == 1, 'import map not found in 3d/index.html'
    app = rewrite_imports(read('3d/app.js'))
    assert '</script' not in app
    html, n = re.subn(r'<script type="module" src="app.js"></script>', lambda m: '<script type="module">\n' + app + '\n</script>', html, count=1)
    assert n == 1, 'app.js script tag not found'
    # the service worker can't run from a file; keep the registration out
    html = re.sub(r'<script>\s*if \(\'serviceWorker\' in navigator\).*?</script>\n', '', html, count=1, flags=re.S)
    # whatever goes wrong while loading is written on the screen instead of a dead page
    html = html.replace('</head>', """<script>
  window.addEventListener('error', function (e) {
    var el = document.getElementById('loadError');
    if (!el) { el = document.createElement('pre'); el.id = 'loadError'; el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99;margin:0;padding:8px;background:#300;color:#fdd;font:12px monospace;white-space:pre-wrap'; document.body.appendChild(el); }
    el.textContent += 'ПОМИЛКА: ' + (e.message || 'не завантажився файл') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '') + '\\n';
  }, true);
</script>
</head>""", 1)
    return html


def build_zip():
    today = datetime.date.today().isoformat()
    name = f'creslarnet-{today}.zip'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in FILES:
            z.writestr('creslarnet/' + rel, read(rel, binary=True))
        z.writestr('creslarnet/3d/index.html', build_3d_index())
        z.writestr('creslarnet/ЧИТАЙ-МЕНЕ.txt', README)
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    out = os.path.join(ROOT, 'dist', name)
    with open(out, 'wb') as f:
        f.write(buf.getvalue())
    return out, today


def github_token():
    cred = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n', capture_output=True, text=True, cwd=ROOT).stdout
    for line in cred.splitlines():
        if line.startswith('password='):
            return line[len('password='):]
    raise SystemExit('no GitHub credentials')


def api(method, url, token, data=None, content_type='application/json'):
    body = data if isinstance(data, bytes) else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(url, data=body, method=method, headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': content_type, 'User-Agent': 'creslarnet-build',
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b'{}')


def publish(path, today):
    token = github_token()
    tag = 'v' + today.replace('-', '.')
    sha = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    body = (
        'Збірка Creslarnet для завантаження на телефон.\n\n'
        f'**{os.path.basename(path)}** — розпакуйте і відкрийте `index.html` у Chrome '
        '(2D-режим; кнопка «3D-режим» відкриває 3D). Інтернет не потрібен. '
        'Детальніше — у файлі ЧИТАЙ-МЕНЕ.txt в архіві.\n\n'
        'Той самий застосунок можна встановити із сайту https://lebichnazar19-create.github.io/creslarnet/ '
        '(меню Chrome → «Встановити застосунок») — він теж працює без інтернету.'
    )
    rel = api('POST', f'https://api.github.com/repos/{REPO}/releases', token, {
        'tag_name': tag, 'target_commitish': sha, 'name': f'Creslarnet {today}', 'body': body, 'draft': False, 'prerelease': False,
    })
    upload_url = rel['upload_url'].split('{')[0] + '?name=' + os.path.basename(path)
    with open(path, 'rb') as f:
        asset = api('POST', upload_url, token, f.read(), content_type='application/zip')
    return rel['html_url'], asset['browser_download_url']


if __name__ == '__main__':
    out, today = build_zip()
    print('built', out, os.path.getsize(out), 'bytes')
    if '--publish' in sys.argv:
        page, download = publish(out, today)
        print('release', page)
        print('download', download)
