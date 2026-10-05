"""Fail before any file is written when the interpreter is older than the supported Python.

The build, generators and verifiers are developed and verified on Python 3.12
(see `.python-version` and the workflows). Older interpreters can parse some
modules differently or only partway, which used to leave generated files
half-regenerated. Every script that writes repository artifacts calls
`require_supported_python()` before it imports anything else from this repo.

`HUIWEN_PYTHON_MINIMUM` (for example `99.0`) can only RAISE the minimum. Tests use
it to prove each entry point stops before writing; it can never lower the guard.
"""
import os
import sys

MINIMUM = (3, 12)
OVERRIDE_ENV = 'HUIWEN_PYTHON_MINIMUM'


def _parse(text):
    try:
        major, _, minor = str(text).strip().partition('.')
        return int(major), int(minor or 0)
    except ValueError:
        return None


def effective_minimum(minimum=MINIMUM, environ=None):
    raised = _parse((os.environ if environ is None else environ).get(OVERRIDE_ENV, ''))
    return max(minimum, raised) if raised else minimum


def require_supported_python(version=None, minimum=None, stream=None, environ=None):
    """Return normally on a supported interpreter; otherwise explain and exit with status 2."""
    version = tuple(version if version is not None else sys.version_info[:3])
    required = effective_minimum(minimum or MINIMUM, environ)
    if version[:2] >= required:
        return
    needed = '.'.join(map(str, required))
    found = '.'.join(map(str, version))
    print(f'Unsupported Python {found}: this repository requires Python {needed} or newer '
          f'(see .python-version). No files were written.\n'
          f'不支援的 Python {found}：需要 {needed} 以上版本；尚未寫入任何檔案。',
          file=stream or sys.stderr)
    raise SystemExit(2)
