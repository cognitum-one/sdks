"""ADR-0019 "Compliance and verification" #5 (issue #74): deny-list test.

> A deny-list test fails if a product module imports another product
> module.

ADR-0019 §D4: "Product modules MUST NOT import one another." The one
documented exception is §D7: "Meta LLM and Meta Proxy share OpenAI and
Anthropic wire primitives where their capability sets agree. They do not
share a client class." In this codebase that carve-out is exercised by
``cognitum/meta_proxy/{client,stream/chat_completions_stream,stream/envelope}.py``
importing ``cognitum.meta_llm.types``, ``cognitum.meta_llm.stream``, and
``cognitum.meta_llm.parsing`` -- wire-shape and wire-parsing helpers only,
never ``cognitum.meta_llm.client`` (the client class). This test denies any
import from one product's package into another's, with a narrow allowlist
for exactly that carve-out.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_PYTHON_ROOT = Path(__file__).resolve().parent.parent
_COGNITUM_ROOT = _PYTHON_ROOT / "cognitum"
_PRODUCTS = ("meta_llm", "meta_proxy", "metaharness", "harnessaas")

# ADR-0019 §D7's one documented wire-type/wire-parsing carve-out.
_ALLOWED_CROSS_IMPORTS: dict[str, tuple[str, ...]] = {
    "meta_llm": (),
    "meta_proxy": (
        "cognitum.meta_llm.types",
        "cognitum.meta_llm.stream",
        "cognitum.meta_llm.parsing",
    ),
    "metaharness": (),
    "harnessaas": (),
}


def _python_files(package_dir: Path) -> list[Path]:
    return sorted(package_dir.rglob("*.py"))


def _module_names_imported(source: str) -> list[str]:
    """Every module dotted-path referenced by an ``import``/``from ... import`` statement."""
    tree = ast.parse(source)
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.append(node.module)
    return names


def _points_into_product(module_name: str, other_product: str) -> bool:
    prefix = f"cognitum.{other_product}"
    return module_name == prefix or module_name.startswith(f"{prefix}.")


def _matches_any_prefix(module_name: str, prefixes: tuple[str, ...]) -> bool:
    return any(module_name == p or module_name.startswith(f"{p}.") for p in prefixes)


@pytest.mark.parametrize("product", _PRODUCTS)
def test_product_imports_no_other_product_module(product: str) -> None:
    package_dir = _COGNITUM_ROOT / product
    files = _python_files(package_dir)
    assert files, f"expected to find .py files under {package_dir}"

    violations: list[str] = []
    for file in files:
        source = file.read_text(encoding="utf-8")
        for module_name in _module_names_imported(source):
            for other_product in _PRODUCTS:
                if other_product == product:
                    continue
                if not _points_into_product(module_name, other_product):
                    continue
                allowed_prefixes = _ALLOWED_CROSS_IMPORTS[product]
                if _matches_any_prefix(module_name, allowed_prefixes):
                    continue
                violations.append(
                    f"{file.relative_to(_COGNITUM_ROOT)} imports {module_name!r} "
                    f"(product {other_product!r}) -- forbidden by ADR-0019 §D4, "
                    "no §D7 wire-type carve-out matches"
                )

    assert violations == [], "\n".join(violations)


def test_meta_proxy_wire_type_carve_out_is_exercised() -> None:
    """The documented §D7 allowlist entry is not a dead allowance."""
    package_dir = _COGNITUM_ROOT / "meta_proxy"
    allowed_prefixes = _ALLOWED_CROSS_IMPORTS["meta_proxy"]
    used = False
    for file in _python_files(package_dir):
        source = file.read_text(encoding="utf-8")
        for module_name in _module_names_imported(source):
            if _matches_any_prefix(module_name, allowed_prefixes):
                used = True
    assert used, (
        "expected at least one cognitum.meta_proxy file to import cognitum.meta_llm.types/"
        "stream/parsing (ADR-0019 §D7) -- if this no longer holds, remove the dead allowlist entry"
    )
