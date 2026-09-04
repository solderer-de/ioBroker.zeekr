#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def _load_payload() -> dict:
    if len(sys.argv) < 2:
        return {}
    try:
        return json.loads(sys.argv[1])
    except json.JSONDecodeError:
        return {}


def _read_json(path: Path):
    if not path.exists():
        return None
    with path.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def _normalize_secrets(raw: dict) -> dict:
    mapping = {
        'hmacAccessKey': raw.get('hmac_access_key') or raw.get('hmacAccessKey') or raw.get('hmac_access') or '',
        'hmacSecretKey': raw.get('hmac_secret_key') or raw.get('hmacSecretKey') or raw.get('hmac_secret') or '',
        'passwordPublicKey': raw.get('password_public_key') or raw.get('passwordPublicKey') or '',
        'prodSecret': raw.get('prod_secret') or raw.get('prodSecret') or '',
        'vinKey': raw.get('vin_key') or raw.get('vinKey') or '',
        'vinIv': raw.get('vin_iv') or raw.get('vinIv') or '',
    }
    return mapping


def _find_output_json(base_apk: Path, arm64_apk: Path, output_path: str | None) -> Path | None:
    candidate_paths = []
    if output_path:
        candidate_paths.append(Path(output_path))
    candidate_paths.extend([
        Path(base_apk).with_name('zeekr_secrets.json'),
        Path(arm64_apk).with_name('zeekr_secrets.json'),
        Path(base_apk).parent / 'zeekr_secrets.json',
        Path(arm64_apk).parent / 'zeekr_secrets.json',
    ])
    for candidate in candidate_paths:
        if candidate.exists():
            return candidate
    return None


EXTRACTOR_REPO = 'https://github.com/wysie/zeekr_key_extractor.git'
# Pinned for reproducibility; bump deliberately after manual verification.
EXTRACTOR_COMMIT = os.environ.get('ZEEKR_EXTRACTOR_COMMIT') or 'main'
EXTRACTOR_DEPS = ['capstone==5.0.9', 'pyelftools==0.33']


def _clone_extractor(extractor_dir: Path) -> None:
    if (extractor_dir / 'zeekr_extract_secrets.py').exists():
        return
    extractor_dir.mkdir(parents=True, exist_ok=True)
    subprocess.check_call(
        ['git', 'clone', '--depth', '1', '--branch', EXTRACTOR_COMMIT, EXTRACTOR_REPO, str(extractor_dir)]
        if EXTRACTOR_COMMIT not in ('main', 'master', '')
        else ['git', 'clone', '--depth', '1', EXTRACTOR_REPO, str(extractor_dir)],
        timeout=120,
    )


def _ensure_dependencies(python_binary: str, extractor_dir: Path) -> None:
    venv_dir = extractor_dir / '.venv'
    if not venv_dir.exists():
        subprocess.check_call([python_binary, '-m', 'venv', str(venv_dir)], timeout=120)
    python_exe = venv_dir / 'bin' / 'python'
    if os.name == 'nt':
        python_exe = venv_dir / 'Scripts' / 'python.exe'
    if not python_exe.exists():
        raise RuntimeError('Unable to create the extractor virtualenv')
    subprocess.check_call(
        [str(python_exe), '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check'] + EXTRACTOR_DEPS,
        timeout=180,
    )


def main() -> int:
    payload = _load_payload()
    secrets_json_path = payload.get('secretsJsonPath') or ''
    apk_base_path = payload.get('apkBasePath') or ''
    apk_arm64_path = payload.get('apkArm64Path') or ''
    region = payload.get('extractRegion') or 'EM'
    python_binary = payload.get('pythonBinary') or os.environ.get('ZEEKR_PYTHON') or 'python3'

    if secrets_json_path:
        path = Path(secrets_json_path)
        if not path.exists():
            print(json.dumps({'ok': False, 'error': f'Secrets JSON file not found: {secrets_json_path}'}))
            return 0
        data = _read_json(path)
        if not isinstance(data, dict):
            print(json.dumps({'ok': False, 'error': 'Secrets JSON did not contain a JSON object'}))
            return 0
        secrets = _normalize_secrets(data)
        print(json.dumps({'ok': True, 'secrets': secrets, 'source': str(path)}))
        return 0

    if not apk_base_path or not apk_arm64_path:
        print(json.dumps({'ok': False, 'error': 'Provide either a secrets JSON file or both APK paths'}))
        return 0

    base_apk = Path(apk_base_path)
    arm64_apk = Path(apk_arm64_path)
    if not base_apk.is_absolute() or not arm64_apk.is_absolute():
        print(json.dumps({'ok': False, 'error': 'APK paths must be absolute'}))
        return 0
    if not base_apk.exists() or not arm64_apk.exists():
        print(json.dumps({'ok': False, 'error': 'One or both APK files do not exist'}))
        return 0

    extractor_dir = Path(payload.get('extractorDir') or os.path.join(os.path.dirname(__file__), '..', '.tools', 'zeekr_key_extractor'))
    try:
        _clone_extractor(extractor_dir)
        _ensure_dependencies(python_binary, extractor_dir)
    except Exception as exc:  # pragma: no cover - runtime-specific path
        print(json.dumps({'ok': False, 'error': f'Failed to prepare the extractor: {exc}'}))
        return 0

    venv_dir = extractor_dir / '.venv'
    python_exe = venv_dir / 'bin' / 'python'
    if os.name == 'nt':
        python_exe = venv_dir / 'Scripts' / 'python.exe'

    output_path = payload.get('outputPath') or ''
    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix='zeekr-secrets-', dir=str(extractor_dir)))
    try:
        completed = subprocess.run(
            [str(python_exe), str(extractor_dir / 'zeekr_extract_secrets.py'), str(base_apk), str(arm64_apk), '--region', region],
            cwd=str(extractor_dir),
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )
        if completed.returncode != 0:
            print(json.dumps({'ok': False, 'error': completed.stderr.strip() or completed.stdout.strip()}))
            return 0
        output_json = _find_output_json(base_apk, arm64_apk, output_path)
        if output_json is None:
            print(json.dumps({'ok': False, 'error': 'Extractor did not produce a zeekr_secrets.json file'}))
            return 0
        data = _read_json(output_json)
        if not isinstance(data, dict):
            print(json.dumps({'ok': False, 'error': 'Extractor output was not a JSON object'}))
            return 0
        secrets = _normalize_secrets(data)
        print(json.dumps({'ok': True, 'secrets': secrets, 'source': str(output_json)}))
        return 0
    except subprocess.TimeoutExpired:
        print(json.dumps({'ok': False, 'error': 'Extractor timed out after 300s'}))
        return 0
    finally:
        import shutil

        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
