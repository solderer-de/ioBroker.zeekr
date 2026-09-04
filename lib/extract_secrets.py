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
    prod_candidates = (
        raw.get('prod_secret_candidates')
        or raw.get('prodSecretCandidates')
        or raw.get('prod_secrets')
        or []
    )
    if isinstance(prod_candidates, str):
        prod_candidates = [c.strip() for c in prod_candidates.split(',') if c.strip()]
    primary = raw.get('prod_secret') or raw.get('prodSecret') or ''
    if not primary and prod_candidates:
        primary = prod_candidates[0]
    mapping = {
        'hmacAccessKey': raw.get('hmac_access_key') or raw.get('hmacAccessKey') or raw.get('hmac_access') or '',
        'hmacSecretKey': raw.get('hmac_secret_key') or raw.get('hmacSecretKey') or raw.get('hmac_secret') or '',
        'passwordPublicKey': raw.get('password_public_key') or raw.get('passwordPublicKey') or '',
        'prodSecret': primary,
        'prodSecretCandidates': ','.join(prod_candidates) if isinstance(prod_candidates, list) else (prod_candidates or ''),
        'vinKey': raw.get('vin_key') or raw.get('vinKey') or '',
        'vinIv': raw.get('vin_iv') or raw.get('vinIv') or '',
    }
    return mapping


def _merge_secrets(base: dict, override: dict, only_keys=None) -> dict:
    merged = dict(base)
    for key, value in override.items():
        if only_keys and key not in only_keys:
            continue
        if value:
            merged[key] = value
    return merged


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
    runtime_json_path = payload.get('runtimeSecretsJsonPath') or ''
    apk_base_path = payload.get('apkBasePath') or ''
    apk_arm64_path = payload.get('apkArm64Path') or ''
    apk_legacy_path = payload.get('apkLegacyPath') or ''
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
        # Runtime-JSON (Frida, App 3.x) überschreibt prod/vin wenn vorhanden.
        if runtime_json_path and Path(runtime_json_path).exists():
            runtime_data = _read_json(Path(runtime_json_path))
            if isinstance(runtime_data, dict):
                runtime_secrets = _normalize_secrets(runtime_data)
                secrets = _merge_secrets(secrets, runtime_secrets, only_keys=['prodSecret', 'prodSecretCandidates', 'vinKey', 'vinIv'])
                print(json.dumps({'ok': True, 'secrets': secrets, 'source': str(path), 'runtimeSource': str(runtime_json_path)}))
                return 0
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
        warnings = []
        if not secrets.get('hmacAccessKey') or not secrets.get('hmacSecretKey'):
            warnings.append('HMAC keys missing — App 1.6+ oder falsches Split? Siehe Upstream-Issue #12. Region prüfen.')
        if not secrets.get('vinKey') or not secrets.get('vinIv'):
            warnings.append('VIN Key/IV fehlen — normal ab App ≥1.5.7 (iWall). Legacy-1.5.5-APK oder Frida-Runtime-JSON nutzen.')
        # Legacy-1.5.5-APK nur für VIN mergen (gilt nicht für overseas 3.0.6+, dort Frida nötig).
        if apk_legacy_path and (not secrets.get('vinKey') or not secrets.get('vinIv')):
            legacy_data = _read_json(Path(apk_legacy_path)) if Path(apk_legacy_path).is_file() else None
            # apkLegacyPath kann JSON oder APK sein: JSON direkt mergen, APK-Hinweis geben.
            if isinstance(legacy_data, dict):
                legacy_secrets = _normalize_secrets(legacy_data)
                secrets = _merge_secrets(secrets, legacy_secrets, only_keys=['vinKey', 'vinIv'])
                warnings.append('VIN aus Legacy-JSON gemerged (1.5.5-Trick, nicht gültig für overseas 3.0.6+).')
            else:
                warnings.append('apkLegacyPath ist gesetzt, aber kein JSON — bitte Legacy-APK separat extrahieren und als JSON hierher mergen, oder Runtime-JSON (Frida) nutzen.')
        # Runtime-JSON (Frida, App 3.x) hat Vorrang für prod/vin.
        if runtime_json_path and Path(runtime_json_path).exists():
            runtime_data = _read_json(Path(runtime_json_path))
            if isinstance(runtime_data, dict):
                runtime_secrets = _normalize_secrets(runtime_data)
                secrets = _merge_secrets(secrets, runtime_secrets, only_keys=['prodSecret', 'prodSecretCandidates', 'vinKey', 'vinIv'])
        print(json.dumps({'ok': True, 'secrets': secrets, 'source': str(output_json), 'warnings': warnings}))
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
