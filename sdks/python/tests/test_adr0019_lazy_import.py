"""ADR-0019 "Compliance and verification" #4 (issue #74): Python lazy-import tests.

> Python import tests prove product modules are lazy.

ADR-0019 §D2: "Python modules MUST remain lazy imports." Audited before
writing this file: ``cognitum/__init__.py``'s ``_LAZY_ATTRS`` table (the
PEP 562 ``__getattr__`` mechanism from issue #20) does not list
``meta_llm``/``meta_proxy``/``metaharness``/``harnessaas`` at all -- so
``import cognitum`` does not even define a lazy *pointer* to them, let
alone eagerly import them. Each product's own ``__init__.py`` docstring
confirms this explicitly ("is NOT imported by ``cognitum/__init__.py``
itself"). This test makes that property executable, using the same fresh-
interpreter technique as ``tests/seed/unit/test_import_graph.py`` (issue
#20) and ``test_adr0019_import_smoke.py`` (#1 above).
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

_PRODUCTS = ("meta_llm", "meta_proxy", "metaharness", "harnessaas")

# ADR-0019 §D7's one documented wire-type carve-out: importing meta_proxy
# legitimately loads meta_llm too (wire types/parsing only -- see
# test_adr0019_deny_list.py). Matches test_adr0019_import_smoke.py.
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


def _leak_check_snippet(body: str, deny_list: list[str]) -> str:
    """A fresh-interpreter snippet: run ``body``, then print the
    comma-joined subset of ``deny_list`` module names present in
    ``sys.modules`` afterward (or ``CLEAN`` if none leaked).
    """
    deny_repr = repr(deny_list)
    return f"""
        import sys
        {body}
        deny = {deny_repr}
        leaked = [m for m in deny if m in sys.modules]
        print(','.join(leaked) if leaked else 'CLEAN')
    """


class TestProductModulesAreLazy:
    def test_import_cognitum_alone_does_not_load_any_product_module(self) -> None:
        deny_list = [f"cognitum.{p}" for p in _PRODUCTS]
        snippet = _leak_check_snippet("import cognitum  # noqa: F401", deny_list)
        output = _run_snippet(snippet)
        assert output == "CLEAN", (
            f"`import cognitum` alone must not eagerly load any product module "
            f"(ADR-0019 §D2) -- leaked: {output}"
        )

    def test_each_product_is_only_loaded_on_explicit_import(self) -> None:
        for product in _PRODUCTS:
            allowed = _ALLOWED_TRANSITIVE_LOADS[product]
            denied_others = [
                f"cognitum.{p}" for p in _PRODUCTS if p != product and p not in allowed
            ]
            body = (
                "import cognitum  # noqa: F401\n"
                f'        assert "cognitum.{product}" not in sys.modules\n'
                f"        import cognitum.{product}  # noqa: F401\n"
                f'        assert "cognitum.{product}" in sys.modules'
            )
            snippet = _leak_check_snippet(body, denied_others)
            output = _run_snippet(snippet)
            assert output == "CLEAN", (
                f"explicitly importing cognitum.{product} must not also load "
                f"{denied_others} -- leaked: {output}"
            )

    def test_accessing_an_unrelated_lazy_cognitum_attribute_does_not_load_any_product(self) -> None:
        """``cognitum.Cognitum``/``cognitum.SeedClient`` etc. resolve via the
        PEP 562 ``__getattr__`` table -- accessing one of those must not
        incidentally load a product module either.
        """
        deny_list = [f"cognitum.{p}" for p in _PRODUCTS]
        body = "import cognitum\n        _ = cognitum.Cognitum\n        _ = cognitum.SeedClient"
        snippet = _leak_check_snippet(body, deny_list)
        output = _run_snippet(snippet)
        assert output == "CLEAN", f"accessing lazy attrs leaked a product module: {output}"

    def test_product_modules_are_absent_from_lazy_attrs_table(self) -> None:
        """Belt-and-suspenders static check: none of the four product names
        (or their client classes) appear as a top-level lazy re-export in
        ``cognitum/__init__.py``'s ``_LAZY_ATTRS`` table -- the table only
        ever pointing at cloud/seed/error/type names is *why* this stays
        lazy without any special-casing.
        """
        import cognitum

        lazy_attrs = cognitum._LAZY_ATTRS  # noqa: SLF001 - intentional white-box check
        product_client_names = {
            "MetaLlmClient",
            "MetaProxyClient",
            "MetaHarnessClient",
            "HarnessaaSClient",
        }
        assert not (set(lazy_attrs) & product_client_names), (
            "a product client class must not be added to cognitum/__init__.py's "
            "_LAZY_ATTRS table -- doing so would still be *lazy* per PEP 562, but "
            "it would blur the ADR-0019 §D3 boundary that product clients are "
            "reached only via their own subpackage, never via the root package"
        )
