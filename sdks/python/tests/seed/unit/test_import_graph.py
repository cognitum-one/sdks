"""Cold-start import graph regression guard (issue #20).

Importing ``cognitum.seed`` MUST NOT transitively load the cloud surface.
Before the PEP 562 lazy ``__getattr__`` fix on ``cognitum/__init__.py``,
``from cognitum.seed import SeedClient`` pulled in ~11 cloud modules
(``cognitum._http``, ``cognitum.catalog``, ``cognitum.orders`` and
friends), adding ~32 ms of eager import cost to seed-only callers.

This test runs a sibling Python interpreter so ``sys.modules`` is clean,
then asserts the cloud modules are absent after the seed import. A
second check verifies backward compat — ``from cognitum import
SeedClient`` still resolves (just lazily).
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

# Concrete list of cloud modules that used to be pulled in eagerly. If
# any of these appears in sys.modules after ``from cognitum.seed import
# SeedClient``, we've regressed.
_CLOUD_MODULES = (
    "cognitum._http",
    "cognitum.async_client",
    "cognitum.client",
    "cognitum.catalog",
    "cognitum.orders",
    "cognitum.leads",
    "cognitum.contact",
    "cognitum.devices",
    "cognitum.mcp",
    "cognitum.brain",
    "cognitum.types",
)


def _run_snippet(snippet: str) -> str:
    """Run ``snippet`` in a fresh interpreter, return stdout (trimmed)."""
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(snippet)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


class TestSeedImportGraph:
    """``from cognitum.seed import SeedClient`` is cloud-free."""

    def test_cloud_modules_not_loaded_after_seed_import(self) -> None:
        snippet = f"""
            import sys
            from cognitum.seed import SeedClient  # noqa: F401
            leaked = [m for m in {_CLOUD_MODULES!r} if m in sys.modules]
            print(','.join(leaked) if leaked else 'CLEAN')
        """
        output = _run_snippet(snippet)
        assert output == "CLEAN", (
            "Cloud modules leaked into sys.modules after "
            f"`from cognitum.seed import SeedClient`: {output}. "
            "Check cognitum/__init__.py — it must stay PEP 562 lazy so "
            "importing a subpackage does not trigger cloud loads."
        )

    def test_async_seed_client_import_also_clean(self) -> None:
        """Covers the other seed entry point."""
        snippet = f"""
            import sys
            from cognitum.seed import AsyncSeedClient  # noqa: F401
            leaked = [m for m in {_CLOUD_MODULES!r} if m in sys.modules]
            print(','.join(leaked) if leaked else 'CLEAN')
        """
        output = _run_snippet(snippet)
        assert output == "CLEAN", (
            f"Cloud modules leaked after AsyncSeedClient import: {output}"
        )

    def test_seed_errors_and_models_are_available(self) -> None:
        """The seed surface itself must still work after the refactor."""
        snippet = """
            from cognitum.seed import (
                SeedClient,
                AsyncSeedClient,
                ConfigError,
                Status,
            )
            print('|'.join([
                SeedClient.__name__,
                AsyncSeedClient.__name__,
                ConfigError.__name__,
                Status.__name__,
            ]))
        """
        output = _run_snippet(snippet)
        assert output == "SeedClient|AsyncSeedClient|ConfigError|Status"


class TestCloudBackwardCompat:
    """Top-level ``cognitum`` re-exports still resolve (just lazily)."""

    def test_from_cognitum_import_cognitum_still_works(self) -> None:
        snippet = """
            from cognitum import Cognitum, AsyncCognitum
            print(Cognitum.__name__, AsyncCognitum.__name__)
        """
        output = _run_snippet(snippet)
        assert output == "Cognitum AsyncCognitum"

    def test_from_cognitum_import_seedclient_still_works(self) -> None:
        snippet = """
            from cognitum import SeedClient, AsyncSeedClient
            print(SeedClient.__name__, AsyncSeedClient.__name__)
        """
        output = _run_snippet(snippet)
        assert output == "SeedClient AsyncSeedClient"

    def test_from_cognitum_import_errors_still_works(self) -> None:
        snippet = """
            from cognitum import (
                CognitumError, AuthError, AuthReason, ConfigError,
                RateLimitError, NetworkError, ValidationError,
            )
            print(CognitumError.__name__, AuthError.__name__, AuthReason.__name__)
        """
        output = _run_snippet(snippet)
        assert output == "CognitumError AuthError AuthReason"

    def test_unknown_attribute_raises_attribute_error(self) -> None:
        snippet = """
            import cognitum
            try:
                cognitum.DoesNotExist  # noqa: B018
            except AttributeError as exc:
                print('ATTR_ERR:', str(exc))
            else:
                print('NO_ERROR')
        """
        output = _run_snippet(snippet)
        assert output.startswith("ATTR_ERR: "), output
        assert "DoesNotExist" in output

    def test_dir_includes_lazy_attrs_for_repl(self) -> None:
        """``dir(cognitum)`` surfaces lazy names so REPL tab-completion works."""
        snippet = """
            import cognitum
            names = set(dir(cognitum))
            print('OK' if {'Cognitum', 'SeedClient', 'CognitumError'} <= names else 'MISSING')
        """
        output = _run_snippet(snippet)
        assert output == "OK"
