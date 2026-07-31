#!/usr/bin/env python3
"""Post-publish smoke test for the Python distribution as end users get it.

Counterpart to smoke-published-package.mjs. Digest verification proves PyPI
holds the bytes we built; it says nothing about whether those bytes import.

The subtlety worth stating: this SDK genuinely does ship optional extras
(mdns pulls in zeroconf, which is absent from a bare `pip install
cognitum-sdk`), so *some* ImportErrors are expected and correct. But
tolerating every ImportError turns the check into a no-op -- a module whose
own internals are broken raises ImportError too, and would be counted as a
"skip". So absence is only tolerated when the missing module is a known
optional third-party dependency; anything else fails the release.
"""

from __future__ import annotations

import importlib
import pkgutil
import re
import sys

# Third-party packages that are deliberately NOT installed by the base
# distribution. Keep in sync with pyproject.toml's [project.optional-dependencies].
OPTIONAL_DEPENDENCIES = frozenset({"zeroconf"})

# This SDK does not let the raw dependency error escape: modules behind an
# extra raise their own ImportError with install guidance (see
# cognitum/seed/discovery/mdns.py), which carries no `name` attribute. That
# convention is the signal, so match it precisely rather than tolerating every
# ImportError -- a broken internal import raises ImportError too.
EXTRA_GUIDANCE_RE = re.compile(r"requires the '([^']+)' extra")


def optional_extra_reason(error: ImportError) -> str | None:
    """Why this ImportError is an expected optional-extra absence, or None."""
    root = (getattr(error, "name", None) or "").split(".")[0]
    if root in OPTIONAL_DEPENDENCIES:
        return f"needs optional '{root}'"
    guidance = EXTRA_GUIDANCE_RE.search(str(error))
    if guidance:
        return f"needs '{guidance.group(1)}' extra"
    return None


def smoke(package_name: str = "cognitum") -> int:
    package = importlib.import_module(package_name)
    print(f"{package_name} version: {getattr(package, '__version__', '(none)')}")

    imported: list[str] = []
    skipped: list[str] = []
    broken: list[tuple[str, str]] = []

    for module in pkgutil.walk_packages(package.__path__, f"{package_name}."):
        # Private modules are not part of the published surface.
        if any(part.startswith("_") for part in module.name.split(".")):
            continue
        try:
            importlib.import_module(module.name)
            imported.append(module.name)
        except ImportError as error:
            reason = optional_extra_reason(error)
            if reason:
                skipped.append(f"{module.name} ({reason})")
            else:
                broken.append((module.name, f"{type(error).__name__}: {error}"))
        except Exception as error:  # noqa: BLE001 - any import-time failure is a release defect
            broken.append((module.name, f"{type(error).__name__}: {error}"))

    for name in imported:
        print(f"ok   {name}")
    for note in skipped:
        print(f"skip {note}")
    for name, reason in broken:
        print(f"FAIL {name}: {reason}", file=sys.stderr)

    if broken:
        print(f"\n{len(broken)}/{len(imported) + len(broken)} public module(s) failed to import", file=sys.stderr)
        return 1
    if not imported:
        print("\nno public modules were imported -- the smoke test proved nothing", file=sys.stderr)
        return 1
    print(f"\nsmoked {len(imported)} public module(s); {len(skipped)} optional-extra skip(s)")
    return 0


if __name__ == "__main__":
    sys.exit(smoke(*sys.argv[1:]))
