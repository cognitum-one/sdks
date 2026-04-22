"""Unit tests for :class:`TokenBook` / :class:`InMemoryTokenBook` (ADR-0016a §D5)."""

from __future__ import annotations

import pytest

from cognitum.seed import InMemoryTokenBook, SecretString, TokenBook


def test_secret_string_redacts_repr():
    s = SecretString("hunter2")
    assert "hunter2" not in repr(s)
    assert "hunter2" not in str(s)
    # The length is allowed to leak (matches the Rust reference).
    assert "7 bytes" in repr(s) or "7" in repr(s)
    assert s.as_str() == "hunter2"


def test_secret_string_equality():
    assert SecretString("a") == SecretString("a")
    assert SecretString("a") != SecretString("b")


def test_secret_string_rejects_non_str():
    with pytest.raises(TypeError):
        SecretString(123)  # type: ignore[arg-type]


def test_in_memory_get_set_delete():
    book = InMemoryTokenBook()
    assert book.get("https://a:8443") is None

    book.set("https://a:8443", SecretString("tok-a"))
    tok = book.get("https://a:8443")
    assert tok is not None
    assert tok.as_str() == "tok-a"

    book.delete("https://a:8443")
    assert book.get("https://a:8443") is None


def test_in_memory_normalises_trailing_slash():
    book = InMemoryTokenBook()
    book.set("https://a:8443/", SecretString("tok"))
    got = book.get("https://a:8443")
    assert got is not None
    assert got.as_str() == "tok"


def test_in_memory_from_initial_mapping():
    book = InMemoryTokenBook({"https://a:8443": "tok-a", "https://b:8443": "tok-b"})
    assert book.get("https://a:8443").as_str() == "tok-a"  # type: ignore[union-attr]
    assert book.get("https://b:8443").as_str() == "tok-b"  # type: ignore[union-attr]


def test_in_memory_distinct_entries_per_peer():
    book = InMemoryTokenBook()
    book.set("https://a:8443", SecretString("tok-a"))
    book.set("https://b:8443", SecretString("tok-b"))
    ta = book.get("https://a:8443")
    tb = book.get("https://b:8443")
    assert ta is not None and tb is not None
    assert ta.as_str() != tb.as_str()


def test_in_memory_set_requires_secret_string():
    book = InMemoryTokenBook()
    with pytest.raises(TypeError):
        book.set("https://a:8443", "raw-token")  # type: ignore[arg-type]


def test_token_book_protocol_conforms():
    book = InMemoryTokenBook()
    assert isinstance(book, TokenBook)
