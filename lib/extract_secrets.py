#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def _load_payload() -> dict:
    # Payload arrives via stdin (see runPythonScript); argv[1] is kept as a
    # fallback for direct CLI use.
    raw = ''
    if len(sys.argv) > 1:
        raw = sys.argv[1]
    elif not sys.stdin.isatty():
        try:
            raw = sys.stdin.read() or ''
        except Exception:
            raw = ''
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
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


def _run_extractor_once(python_exe, extractor_dir, base_apk, arm64_apk, region, output_path, temp_parent):
    """Run the upstream extractor once. Returns (secrets_dict_or_None, error_str_or_None)."""
    temp_dir = Path(tempfile.mkdtemp(prefix='zeekr-secrets-', dir=str(temp_parent)))
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
            return None, (completed.stderr.strip() or completed.stdout.strip() or 'extractor failed')
        output_json = _find_output_json(base_apk, arm64_apk, output_path)
        if output_json is None:
            return None, 'Extractor did not produce a zeekr_secrets.json file'
        data = _read_json(output_json)
        if not isinstance(data, dict):
            return None, 'Extractor output was not a JSON object'
        return _normalize_secrets(data), None
    except subprocess.TimeoutExpired:
        return None, 'Extractor timed out after 300s'
    finally:
        import shutil

        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)


def _read_utf16_string(data: bytes, offset: int):
    length = int.from_bytes(data[offset:offset + 2], 'little')
    start = offset + 2
    return data[start:start + length * 2].decode('utf-16-le', errors='replace')


def _read_utf8_string(data: bytes, offset: int):
    first = data[offset]
    if first & 0x80:
        length = ((first & 0x7F) << 8) | data[offset + 1]
        start = offset + 2
    else:
        length = first
        start = offset + 1
    return data[start:start + length].decode('utf-8', errors='replace')


def _read_axml_info(manifest: bytes):
    """Minimal binary AndroidManifest parser. Returns (package, versionName)."""
    import struct

    try:
        if len(manifest) < 8 or struct.unpack_from('<H', manifest, 0)[0] != 0x0003:
            return '', ''
        pos = 8
        pool = []
        is_utf8 = False
        while pos + 8 <= len(manifest):
            chunk_type, _header_size, chunk_size = struct.unpack_from('<HHI', manifest, pos)
            if chunk_size < 8 or pos + chunk_size > len(manifest):
                break
            if chunk_type == 0x0001:  # string pool
                (string_count, _style_count, flags, strings_start, _styles_start) = struct.unpack_from(
                    '<IIIII', manifest, pos + 8
                )
                is_utf8 = bool(flags & 0x100)
                offsets = struct.unpack_from(f'<{string_count}I', manifest, pos + 28)
                base = pos + strings_start
                for off in offsets:
                    if is_utf8:
                        pool.append(_read_utf8_string(manifest, base + off))
                    else:
                        pool.append(_read_utf16_string(manifest, base + off))
            elif chunk_type == 0x0102:  # start element (first one is <manifest>)
                name_idx = struct.unpack_from('<i', manifest, pos + 12)[0]
                attr_count = struct.unpack_from('<H', manifest, pos + 20)[0]
                result = {}
                for i in range(attr_count):
                    a_off = pos + 28 + i * 20
                    _ns, name_i, _raw, _size, _res0, data_type, data = struct.unpack_from(
                        '<iiihBBi', manifest, a_off
                    )
                    name = pool[name_i] if 0 <= name_i < len(pool) else ''
                    if data_type == 0x03 and 0 <= data < len(pool):
                        value = pool[data]
                    else:
                        value = str(data)
                    if name:
                        result[name] = value
                return result.get('package', ''), result.get('versionName', '')
            pos += chunk_size
    except Exception:
        pass
    return '', ''


def _inspect_apk(base_apk: Path, arm64_apk: Path) -> dict:
    """Dependency-free APK checks: package/version from the manifest, libenv presence."""
    import zipfile

    info = {'package': '', 'version': '', 'hasLibenv': False}
    try:
        with zipfile.ZipFile(base_apk) as archive:
            names = archive.namelist()
            if 'lib/arm64-v8a/libenv.so' in names:
                info['hasLibenv'] = True
            try:
                manifest = archive.read('AndroidManifest.xml')
            except KeyError:
                manifest = b''
            if manifest:
                package, version = _read_axml_info(manifest)
                info['package'] = package
                info['version'] = version
    except Exception:
        pass
    if not info['hasLibenv']:
        try:
            with zipfile.ZipFile(arm64_apk) as archive:
                if 'lib/arm64-v8a/libenv.so' in archive.namelist():
                    info['hasLibenv'] = True
        except Exception:
            pass
    return info


def _version_at_least(version: str, major: int, minor: int) -> bool:
    try:
        parts = [int(piece) for piece in version.strip().split('.')[:2]]
        while len(parts) < 2:
            parts.append(0)
        return (parts[0], parts[1]) >= (major, minor)
    except (ValueError, AttributeError):
        return False


def _missing_secret_keys(secrets: dict) -> list:
    return [key for key in ('hmacAccessKey', 'hmacSecretKey', 'passwordPublicKey', 'prodSecret', 'vinKey', 'vinIv')
            if not secrets.get(key)]


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

    apk_info = _inspect_apk(base_apk, arm64_apk)
    apk_warnings = []
    if not apk_info['hasLibenv']:
        apk_warnings.append(
            'Neither APK contains lib/arm64-v8a/libenv.so — the second file is probably the wrong split '
            '(e.g. xxhdpi instead of arm64_v8a). Re-pull split_config.arm64_v8a.apk from the device.'
        )
    if apk_info['package'] == 'com.zeekr.overseas' and region != 'EU':
        apk_warnings.append(
            'The APK is the EU build (com.zeekr.overseas) but the region is not EU — set extractRegion to EU.'
        )
    if _version_at_least(apk_info['version'], 3, 1):
        apk_warnings.append(
            f"Detected app version {apk_info['version']}: static extraction is limited on 3.1.0 and newer "
            '(KiwiVM, upstream issue #14). Provide an older APK pair (e.g. app 3.0.x) to fill missing keys.'
        )

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

    apk_old_base_path = payload.get('apkOldBasePath') or ''
    apk_old_arm64_path = payload.get('apkOldArm64Path') or ''
    output_path = payload.get('outputPath') or ''
    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

    secrets, error = _run_extractor_once(python_exe, extractor_dir, base_apk, arm64_apk, region, output_path, extractor_dir)
    if secrets is None:
        print(json.dumps({'ok': False, 'error': error}))
        return 0
    sources = ['current APK']
    warnings = list(apk_warnings)
    missing = _missing_secret_keys(secrets)
    if 'hmacAccessKey' in missing or 'hmacSecretKey' in missing:
        warnings.append(
            'HMAC keys missing — on app 3.1.0+ (KiwiVM) they cannot be extracted statically '
            '(upstream issue #14); otherwise check the arm64 split APK and the region.'
        )
    if 'vinKey' in missing or 'vinIv' in missing:
        warnings.append(
            'VIN key/IV missing — expected on app 1.5.7 and newer (iWall). '
            'Use a legacy JSON, an older APK pair, or a Frida runtime JSON.'
        )
    # Legacy JSON merges VIN only (the 1.5.5 trick does not hold for overseas 3.0.6+).
    if apk_legacy_path and ('vinKey' in missing or 'vinIv' in missing):
        legacy_data = _read_json(Path(apk_legacy_path)) if Path(apk_legacy_path).is_file() else None
        if isinstance(legacy_data, dict):
            legacy_secrets = _normalize_secrets(legacy_data)
            before = _missing_secret_keys(secrets)
            secrets = _merge_secrets(secrets, legacy_secrets, only_keys=['vinKey', 'vinIv'])
            filled = [key for key in before if key not in _missing_secret_keys(secrets)]
            if filled:
                warnings.append(f'Merged {", ".join(filled)} from the legacy JSON (verify with testConnection).')
        else:
            warnings.append('apkLegacyPath is set but is not a JSON file — extract it separately or use a runtime JSON (Frida).')
    # Older APK pair (e.g. app 3.0.x while the current app is 3.1.0+): fill every
    # still-missing secret from it, since server-side keys often stay valid.
    missing = _missing_secret_keys(secrets)
    old_base = Path(apk_old_base_path) if apk_old_base_path else None
    old_arm64 = Path(apk_old_arm64_path) if apk_old_arm64_path else None
    if missing and old_base and old_arm64 and old_base.exists() and old_arm64.exists():
        old_secrets, old_error = _run_extractor_once(
            python_exe, extractor_dir, old_base, old_arm64, region, output_path, extractor_dir
        )
        if old_secrets is None:
            warnings.append(f'Older APK extraction failed: {old_error}')
        else:
            before = list(missing)
            secrets = _merge_secrets(secrets, old_secrets, only_keys=before)
            filled = [key for key in before if key not in _missing_secret_keys(secrets)]
            if filled:
                sources.append('older APK')
                warnings.append(
                    f'Merged {", ".join(filled)} from the older APK (verify with testConnection — '
                    'keys may differ between app versions).'
                )
    elif missing and (apk_old_base_path or apk_old_arm64_path):
        warnings.append('Older APK paths are incomplete or do not exist — provide both base and arm64 files.')
    # Runtime JSON (Frida, App 3.x) takes precedence for prod/vin.
    if runtime_json_path and Path(runtime_json_path).exists():
        runtime_data = _read_json(Path(runtime_json_path))
        if isinstance(runtime_data, dict):
            runtime_secrets = _normalize_secrets(runtime_data)
            secrets = _merge_secrets(secrets, runtime_secrets, only_keys=['prodSecret', 'prodSecretCandidates', 'vinKey', 'vinIv'])
            sources.append('runtime JSON')
    missing = _missing_secret_keys(secrets)
    if missing:
        warnings.append(f'Still missing: {", ".join(missing)}. See the README section on app 3.1.0 and newer.')
    print(json.dumps({
        'ok': True,
        'secrets': secrets,
        'sources': sources,
        'warnings': warnings,
        'apkVersion': apk_info['version'],
        'apkPackage': apk_info['package'],
    }))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
