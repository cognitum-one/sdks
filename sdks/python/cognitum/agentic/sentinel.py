"""Concrete ``SecretRedactor`` implementation -- the sentinel scan defined
by ADR-0028 D13, driven by ADR-0022 D10 classification and the D12
category list. Closes issue #54.

Faithful to D13's exact mechanism (see
``docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md``):

1. A key-name check against the D12 category list runs first -- a value can
   be sensitive purely because of the field it lives in, regardless of
   shape.
2. Fixed-format matchers (bearer token, JWT, PEM private-key block,
   cloud-provider access-key pattern, pre-signed URL query parameter) run
   next.
3. A Shannon-entropy fallback (>= 4.0 bits/char over a contiguous token of
   >= 20 characters) runs ONLY if no fixed-format matcher hit -- a match is
   classified by pattern first, entropy only as a fallback.
4. Traversal is a bounded-depth-8 DFS: a value reached at depth 9 or deeper
   is replaced with ``[max-depth-exceeded]`` without further recursion.
   Cycles are broken by an object-identity ancestor set and replaced with
   ``[cyclic-reference]``. Matches are replaced with
   ``[redacted:<category>]``, where ``<category>`` is a D12 category name,
   or ``secret-pattern`` / ``high-entropy`` for value-only matches.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any, Literal

from cognitum.agentic.credentials import SecretClassification, SecretRedactor

#: D12/D13 category list consulted by the key-name check.
D12Category = Literal[
    "prompts",
    "messages",
    "tool-arguments-results",
    "source",
    "repository-urls",
    "patches",
    "credentials",
    "environment-values",
    "webhook-bodies",
    "signed-urls",
    "raw-tenant-user-identifiers",
]

_MAX_DEPTH = 8
_ENTROPY_THRESHOLD_BITS_PER_CHAR = 4.0
_ENTROPY_MIN_TOKEN_LEN = 20

_MAX_DEPTH_MARKER = "[max-depth-exceeded]"
_CYCLIC_MARKER = "[cyclic-reference]"

# D12/D13 category list, ADR-0028 D12 and D13's restatement of it: prompts,
# messages, tool arguments/results, source, repository URLs, patches,
# credentials, environment values, webhook bodies, signed URLs, raw
# tenant/user identifiers.
_KEY_NAME_RULES: list[tuple[re.Pattern[str], D12Category, SecretClassification]] = [
    (
        re.compile(r"^(credential|credentials|apikey|clientsecret|secret|token|password|accesskey|authorization)$"),
        "credentials",
        "secret",
    ),
    (
        re.compile(r"^(env|environment|envvars|environmentvalues|environmentvariables)$"),
        "environment-values",
        "secret",
    ),
    (
        re.compile(r"^(signedurl|presignedurl|signedurls)$"),
        "signed-urls",
        "secret",
    ),
    (
        re.compile(r"^(webhookbody|webhookpayload|webhookbodies)$"),
        "webhook-bodies",
        "sensitive",
    ),
    (
        re.compile(r"^(userid|tenantid|rawuserid|rawtenantid|accountid)$"),
        "raw-tenant-user-identifiers",
        "sensitive",
    ),
    (
        re.compile(r"^(prompt|prompts|systemprompt)$"),
        "prompts",
        "sensitive",
    ),
    (
        re.compile(r"^(message|messages|chatmessages)$"),
        "messages",
        "sensitive",
    ),
    (
        re.compile(r"^(toolarguments|toolresults|toolargs|tooloutput)$"),
        "tool-arguments-results",
        "sensitive",
    ),
    (
        re.compile(r"^(source|sourcecode|sourcefiles)$"),
        "source",
        "sensitive",
    ),
    (
        re.compile(r"^(repositoryurl|repourl|repositoryurls)$"),
        "repository-urls",
        "sensitive",
    ),
    (
        re.compile(r"^(patch|patches|diff)$"),
        "patches",
        "sensitive",
    ),
]


def _normalize_field_name(field_name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", field_name.lower())


def _key_name_rule(
    field_name: str | None,
) -> tuple[D12Category, SecretClassification] | None:
    if not field_name:
        return None
    normalized = _normalize_field_name(field_name)
    for pattern, category, classification in _KEY_NAME_RULES:
        if pattern.match(normalized):
            return category, classification
    return None


# Fixed-format matchers (ADR-0028 D13), evaluated before the entropy
# fallback. Each matches a *whole* leaf value, since D13 replaces the leaf
# entirely rather than redacting a substring.
_BEARER_TOKEN_RE = re.compile(r"^bearer\s+[a-z0-9._~+/-]{16,}=*$", re.IGNORECASE)
_JWT_RE = re.compile(r"^[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}$", re.IGNORECASE)
_PEM_PRIVATE_KEY_RE = re.compile(r"-----BEGIN[ A-Z0-9]*PRIVATE KEY-----")
# AWS access/session key IDs (AKIA.../ASIA...) and Google API keys (AIza...).
_CLOUD_ACCESS_KEY_RE = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b")
# Pre-signed URL query parameters (SigV4, generic "Signature=", Azure SAS).
_PRESIGNED_URL_PARAM_RE = re.compile(
    r"[?&](?:X-Amz-Signature|X-Amz-Credential|Signature|se)=", re.IGNORECASE
)

# Maximal runs of token-shaped characters (letters, digits, and the small
# symbol set typical of base64/URL-safe secrets), used to find contiguous
# candidates for the entropy fallback without over-matching plain prose.
_TOKEN_RE = re.compile(r"[A-Za-z0-9+/=_.~-]+")


def _matches_fixed_format(value: str) -> bool:
    return bool(
        _BEARER_TOKEN_RE.match(value)
        or _JWT_RE.match(value)
        or _PEM_PRIVATE_KEY_RE.search(value)
        or _CLOUD_ACCESS_KEY_RE.search(value)
        or _PRESIGNED_URL_PARAM_RE.search(value)
    )


def _shannon_entropy(token: str) -> float:
    """Shannon entropy in bits/char over a string's character distribution."""
    n = len(token)
    if n == 0:
        return 0.0
    counts = Counter(token)
    entropy = 0.0
    for count in counts.values():
        p = count / n
        entropy -= p * math.log2(p)
    return entropy


def _matches_entropy_fallback(value: str) -> bool:
    for token in _TOKEN_RE.findall(value):
        if len(token) >= _ENTROPY_MIN_TOKEN_LEN and _shannon_entropy(token) >= (
            _ENTROPY_THRESHOLD_BITS_PER_CHAR
        ):
            return True
    return False


#: Redacted-leaf category, per D13: a D12 category, or a value-only match.
_LeafCategory = str


def _classify_leaf(field_name: str | None, value: str) -> _LeafCategory | None:
    rule = _key_name_rule(field_name)
    if rule:
        return rule[0]
    if _matches_fixed_format(value):
        return "secret-pattern"
    if _matches_entropy_fallback(value):
        return "high-entropy"
    return None


class SentinelSecretRedactor(SecretRedactor):
    """Concrete ``SecretRedactor`` (ADR-0022 D1/D10) implementing the exact
    sentinel-scan mechanism specified by ADR-0028 D13.
    """

    def classify(self, field_name: str, value: Any) -> SecretClassification:
        rule = _key_name_rule(field_name)
        if rule:
            return rule[1]
        if isinstance(value, str):
            if _matches_fixed_format(value):
                return "secret"
            if _matches_entropy_fallback(value):
                return "secret"
        return "public"

    def redact(self, value: Any) -> Any:
        return self._walk(value, None, 0, set())

    def _walk(
        self,
        value: Any,
        field_name: str | None,
        depth: int,
        ancestors: set[int],
    ) -> Any:
        if depth > _MAX_DEPTH:
            return _MAX_DEPTH_MARKER

        if value is None:
            return value

        if isinstance(value, str):
            category = _classify_leaf(field_name, value)
            return f"[redacted:{category}]" if category else value

        if isinstance(value, bool) or not isinstance(value, (dict, list, tuple)):
            # Numbers, booleans, etc.: D13's matcher set applies to string
            # leaves only.
            return value

        obj_id = id(value)
        if obj_id in ancestors:
            return _CYCLIC_MARKER
        next_ancestors = ancestors | {obj_id}

        if isinstance(value, (list, tuple)):
            walked = [self._walk(item, field_name, depth + 1, next_ancestors) for item in value]
            return walked if isinstance(value, list) else tuple(walked)

        result: dict[Any, Any] = {}
        for key, val in value.items():
            key_name = key if isinstance(key, str) else None
            result[key] = self._walk(val, key_name, depth + 1, next_ancestors)
        return result


__all__ = ["D12Category", "SentinelSecretRedactor"]
