"""Build allowlisted DSH release files with Python standard library; never uploads.

Run from the project: python scripts/build-release.py [--node /path/to/node]
All checks run before packaging. Existing different artifacts are never overwritten.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
RUNTIME_FILES = [
    'package.json', 'cordis.patch.yml', 'dsh-plugin.json', 'icon.png',
    'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE.md',
    'lib/index.js', 'lib/client.js', 'lib/client/widget.js', 'lib/state.mjs',
    'lib/session-core.mjs', 'lib/plan-availability.mjs', 'lib/inject.mjs', 'lib/request-policy.mjs',
    'docs/state-core.md', 'docs/images/轮盘.png',
    'assets/标准模式.png', 'assets/标准模式激活中.png',
    'assets/plan模式.png', 'assets/plan模式激活中.png',
    'assets/grill模式.png', 'assets/grill模式激活中.png',
    'assets/限制模式.png', 'assets/限制模式激活中.png',
]
SOURCE_EXTRAS = [
    'CONTEXT.md', 'RELEASE_NOTES.md', '.github/workflows/ci.yml', '.gitignore',
    'scripts/verify.mjs', 'scripts/build-release.py', 'scripts/test-client-contract.mjs',
    'scripts/test-plan-availability.mjs', 'scripts/test-session-core.mjs',
    'scripts/test-host-core.mjs', 'scripts/test-client-state.mjs',
    'scripts/test-release-safety.mjs', 'scripts/test-slot-server.mjs',
    'scripts/test-planning-policy.mjs', 'scripts/test-manual-core.mjs', 'scripts/test-manual-client.mjs',
    'scripts/check-live-client.mjs', 'test/fixtures/dsh-slot-core.js', 'test/fixtures/LICENSE.dsh',
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_allowed(name):
    path = ROOT / name
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(ROOT) or path.is_symlink() or not path.is_file():
        raise RuntimeError('Unsafe or missing release input: ' + name)
    return path.read_bytes()


def save_new(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise RuntimeError('Refusing to overwrite a different existing artifact: ' + str(path))
        return
    with path.open('xb') as stream:
        stream.write(data)


def build_tar(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo('package/' + name)
            member.size = len(data)
            member.mtime = 0
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
    return gzip.compress(stream.getvalue(), compresslevel=9, mtime=0)


def build_zip(files, prefix):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            member = zipfile.ZipInfo(prefix + '/' + name, date_time=(2020, 1, 1, 0, 0, 0))
            member.compress_type = zipfile.ZIP_DEFLATED
            member.create_system = 3
            member.external_attr = 0o100644 << 16
            archive.writestr(member, data)
    return stream.getvalue()


def inspect_tar(data, expected):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        assert all(m.isfile() for m in members), 'No links, devices or unexpected directories'
        actual = {m.name: archive.extractfile(m).read() for m in members}
    assert len(actual) == len(members)
    assert actual == {'package/' + n: b for n, b in expected.items()}


def inspect_zip(data, expected, prefix):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == len(set(archive.namelist()))
        actual = {name: archive.read(name) for name in archive.namelist()}
    assert actual == {prefix + '/' + n: b for n, b in expected.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    pkg = json.loads(read_allowed('package.json'))
    manifest = json.loads(read_allowed('dsh-plugin.json'))
    version = pkg['version']
    assert re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version)
    assert pkg['name'] == 'dsh-mode-widget' and manifest['version'] == version
    # Inherited stdio avoids captured child-process pipes in confined Windows hosts.
    subprocess.run([args.node, 'scripts/verify.mjs'], cwd=ROOT, check=True)
    runtime = {name: read_allowed(name) for name in RUNTIME_FILES}
    source = {**runtime, **{name: read_allowed(name) for name in SOURCE_EXTRAS}}
    for name, content in source.items():
        if name.endswith(('.js', '.mjs', '.json', '.md', '.yml', '.py')):
            text = content.decode('utf-8')
            assert not re.search(r'[A-Za-z]:[\\/](?:Users|WBplace|Desktop|XZyyy)[\\/]', text), 'Private local path: ' + name
    prefix = 'dsh-mode-widget-' + version
    tar_bytes, zip_bytes = build_tar(runtime), build_zip(source, prefix)
    inspect_tar(tar_bytes, runtime)
    inspect_zip(zip_bytes, source, prefix)
    artifacts = {
        prefix + '.tgz': tar_bytes,
        prefix + '-source.zip': zip_bytes,
        'RELEASE_NOTES.md': read_allowed('RELEASE_NOTES.md'),
    }
    metadata = {
        'name': pkg['name'], 'version': version, 'releaseType': 'prerelease' if '-' in version else 'release',
        'protocolVersion': 3, 'coreBuild': 'session-core-v3-planning-manual',
        'verification': {'command': 'node scripts/verify.mjs', 'result': 'passed',
                         'realDshRestartedEndToEnd': 'pending', 'uploaded': False},
        'artifacts': {name: {'bytes': len(data), 'sha256': sha(data)} for name, data in artifacts.items()},
        'files': [{'path': name, 'bytes': len(data), 'sha256': sha(data), 'runtime': name in runtime}
                  for name, data in sorted(source.items())],
    }
    artifacts['RELEASE_MANIFEST.json'] = (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    artifacts['SHA256SUMS.txt'] = ''.join(sha(data) + '  ' + name + '\n' for name, data in artifacts.items()).encode('ascii')
    output = ROOT / 'dist' / (prefix + '-release')
    output.mkdir(parents=True, exist_ok=True)
    for name, data in artifacts.items():
        save_new(output / name, data)
    for name, data in artifacts.items():
        assert (output / name).read_bytes() == data
    print(json.dumps({'output': str(output), 'runtimeFileCount': len(runtime), 'sourceFileCount': len(source),
                      'artifacts': {n: {'bytes': len(b), 'sha256': sha(b)} for n, b in artifacts.items()}}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
