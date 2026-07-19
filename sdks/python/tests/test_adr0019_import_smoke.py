"""ADR-0019 "Compliance and verification" #1 (issue #74): import smoke tests.

> Import smoke tests prove each product namespace loads without
> constructing or probing any other product.

ADR-0019 §D4: "Product modules MUST NOT import one another." This test
runs each product import in a FRESH sibling interpreter (mirroring
``tests/seed/unit/test_import_graph.py``'s issue #20 cold-start-import-graph
technique, rather than mutating ``sys.modules`` in-process) and asserts
that none of the OTHER three product packages appears in ``sys.modules``
afterward.

The one documented exception is §D7: ``cognitum.meta_proxy`` imports
``cognitum.meta_llm.types``/``stream``/``parsing`` (wire shapes and wire
parsing only, never the client class -- see
``test_adr0019_deny_list.py``), which necessarily runs
``cognitum/meta_llm/__init__.py`` and therefore adds ``cognitum.meta_llm``
to ``sys.modules`` as a side effect of Python's import system. That is
allowed here explicitly; ``metaharness`` and ``harnessaas`` must still
never be loaded by importing ``meta_proxy``.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

_PRODUCTS = ("meta_llm", "meta_proxy", "metaharness", "harnessaas")

# ADR-0019 §D7's one documented wire-type carve-out: importing meta_proxy
# legitimately loads meta_llm too. Matches test_adr0019_deny_list.py.
_ALLOWED_TRANSITIVE_LOADS: dict[str, tuple[str, ...]] = {
    "meta_llm": (),
    "meta_proxy": ("meta_llm",),
    "metaharness": (),
    "harnessaas": (),
}


def _run_snippet(snippet: str) -> str:
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(snippet)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _leak_check_snippet(import_stmt: str, deny_list: list[str]) -> str:
    """A fresh-interpreter snippet: run ``import_stmt``, then print the
    comma-joined subset of ``deny_list`` module names present in
    ``sys.modules`` afterward (or ``CLEAN`` if none leaked).
    """
    deny_repr = repr(deny_list)
    return f"""
        import sys
        {import_stmt}
        deny = {deny_repr}
        leaked = [m for m in deny if m in sys.modules]
        print(','.join(leaked) if leaked else 'CLEAN')
    """


class TestProductImportSmoke:
    """Importing one product's namespace loads no other product's namespace."""

    def test_each_product_imports_without_loading_the_others(self) -> None:
        for product in _PRODUCTS:
            allowed = _ALLOWED_TRANSITIVE_LOADS[product]
            denied_others = [
                f"cognitum.{p}" for p in _PRODUCTS if p != product and p not in allowed
            ]
            snippet = _leak_check_snippet(f"import cognitum.{product}  # noqa: F401", denied_others)
            output = _run_snippet(snippet)
            assert output == "CLEAN", (
                f"importing cognitum.{product} must not load any of {denied_others} "
                f"(ADR-0019 §D4) -- leaked: {output}"
            )

    def test_agentic_alone_loads_no_product_module(self) -> None:
        deny_list = [f"cognitum.{p}" for p in _PRODUCTS]
        snippet = _leak_check_snippet("import cognitum.agentic  # noqa: F401", deny_list)
        output = _run_snippet(snippet)
        assert output == "CLEAN", f"importing agentic leaked a product module: {output}"

    def test_each_product_import_performs_no_network_probe(self) -> None:
        """Importing a product module must not attempt any socket connection
        (ADR-0019 §D3: "Constructing one client MUST NOT ... probe another
        product"; the same zero-I/O expectation applies to import itself).
        """
        for product in _PRODUCTS:
            snippet = f"""
                import socket

                def _no_connect(*args, **kwargs):
                    raise AssertionError("import-time socket connection attempted")

                socket.socket.connect = _no_connect
                import cognitum.{product}  # noqa: F401
                print('OK')
            """
            output = _run_snippet(snippet)
            msg = f"importing cognitum.{product} attempted network I/O at import time"
            assert output == "OK", msg
