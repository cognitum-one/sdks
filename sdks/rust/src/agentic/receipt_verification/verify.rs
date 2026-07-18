//! Verification entry points for `ExecutionReceipt` (§D8 levels) and
//! `LineageReference` chains (§D9 structural checks). Split out of
//! `receipt_verification.rs` to stay under the repo's 500-line-per-file
//! rule; shares primitives (canonicalization, digests, timestamp parsing)
//! with its parent module via `use super::*`.

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

/// Resolves a trusted key for `(issuer, key_id)`; `None` means "no proof
/// possible" (unknown key / issuer).
pub type KeyResolver<'a> = dyn Fn(&str, &str) -> Option<Vec<u8>> + 'a;

// ---------------------------------------------------------------------------
// Verification (§D8 verification levels)
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct VerifyReceiptOptions<'a> {
    pub min_level: VerificationLevel,
    /// Independently obtained expected digest, for `digest`-level checks.
    pub expected_digest: Option<String>,
    pub resolve_key: Option<&'a KeyResolver<'a>>,
    /// Optional external durability/anchor check for `anchored`.
    pub check_anchor: Option<&'a dyn Fn(&str) -> bool>,
    pub now: Option<&'a dyn Fn() -> String>,
}

/// Verifies a receipt against a minimum required [`VerificationLevel`]
/// (fail-closed).
pub fn verify_execution_receipt(
    receipt: &ExecutionReceipt,
    opts: &VerifyReceiptOptions<'_>,
) -> VerificationResult {
    let checked_at = opts.now.map_or_else(now_iso, |f| f());
    let mut warnings: Vec<String> = Vec::new();

    if let Some(failure) = shape_check_execution_receipt(receipt) {
        return fail_result(checked_at, failure);
    }

    let mut achieved = VerificationLevel::Shape;
    let canonical_bytes = canonical_json(&receipt_signable_value(receipt));
    let subject_digest = sha256_hex(&canonical_bytes);
    let mut algorithm: Option<String> = None;

    if let Some(expected) = &opts.expected_digest {
        if expected == &subject_digest {
            achieved = VerificationLevel::Digest;
        } else {
            warnings.push("expected digest mismatch".to_string());
        }
    }

    if let (Some(sig), Some(issuer), Some(key_id)) =
        (&receipt.signature, &receipt.issuer, &receipt.key_id)
    {
        match opts.resolve_key {
            None => warnings.push("no key resolver supplied; cannot verify signature".to_string()),
            Some(resolver) => match resolver(issuer, key_id) {
                None => warnings.push(format!("unknown key '{key_id}' for issuer '{issuer}'")),
                Some(key) => {
                    let expected_sig = hmac_sha256_hex(&key, &canonical_bytes);
                    if constant_time_hex_eq(&expected_sig, sig) {
                        achieved = VerificationLevel::Cryptographic;
                        algorithm = Some("hmac-sha256".to_string());
                    } else {
                        return VerificationResult {
                            level: VerificationLevel::None,
                            valid: false,
                            algorithm: None,
                            key_id: None,
                            checked_at,
                            subject_digest: Some(subject_digest),
                            warnings: None,
                            failure: Some("signature does not match canonical bytes".to_string()),
                        };
                    }
                }
            },
        }
    } else if opts.min_level >= VerificationLevel::Cryptographic {
        warnings.push("receipt carries no signature/issuer/keyId claim".to_string());
    }

    if achieved == VerificationLevel::Cryptographic {
        if let (Some(root), Some(check_anchor)) = (&receipt.lineage_root, opts.check_anchor) {
            if check_anchor(root) {
                achieved = VerificationLevel::Anchored;
            } else {
                warnings.push("anchor check did not confirm durable checkpoint".to_string());
            }
        }
    }

    let valid = achieved >= opts.min_level;
    VerificationResult {
        level: achieved,
        valid,
        algorithm,
        key_id: receipt.key_id.clone(),
        checked_at,
        subject_digest: Some(subject_digest),
        warnings: if warnings.is_empty() { None } else { Some(warnings) },
        failure: if valid {
            None
        } else {
            Some(format!(
                "minimum level '{}' not reached (achieved '{}')",
                level_label(opts.min_level),
                level_label(achieved)
            ))
        },
    }
}

// ---------------------------------------------------------------------------
// Lineage chain (§D9) — structural chain validation
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct VerifyLineageChainOptions<'a> {
    pub min_level: VerificationLevel,
    pub resolve_key: Option<&'a KeyResolver<'a>>,
    pub max_checkpoint_age_ms: Option<i64>,
    pub now: Option<&'a dyn Fn() -> String>,
}

pub struct LineageChainVerification {
    pub valid: bool,
    pub level: VerificationLevel,
    pub broken_at_index: Option<usize>,
    pub results: Vec<VerificationResult>,
    pub failure: Option<String>,
}

/// Verifies a `LineageReference` chain is well-formed: each entry's
/// `previous_checkpoint` resolves to the prior entry's `root`, sequence
/// numbers strictly increase, and no `root` digest repeats (cycle
/// detection). This is a structural check (§D9), not a full Merkle/anchored
/// proof.
pub fn verify_lineage_chain(
    chain: &[LineageReference],
    opts: &VerifyLineageChainOptions<'_>,
) -> LineageChainVerification {
    let checked_at = opts.now.map_or_else(now_iso, |f| f());
    let mut results: Vec<VerificationResult> = Vec::new();

    if chain.is_empty() {
        return LineageChainVerification {
            valid: false,
            level: VerificationLevel::None,
            broken_at_index: None,
            results,
            failure: Some("lineage chain is empty".to_string()),
        };
    }

    let mut seen_roots: HashSet<&str> = HashSet::new();
    let mut min_achieved = VerificationLevel::Anchored;
    // The genesis entry (i == 0) has no predecessor to link against, so it
    // can never reach `digest` on its own — that's not a weak link, it's
    // simply not applicable. It only counts toward the chain's overall
    // level when the chain has exactly one entry (nothing else to fold in).
    let mut genesis_achieved: Option<VerificationLevel> = None;

    for (i, entry) in chain.iter().enumerate() {
        if let Some(failure) = shape_check_lineage_reference(entry) {
            results.push(fail_result(checked_at.clone(), failure.clone()));
            return LineageChainVerification {
                valid: false,
                level: VerificationLevel::None,
                broken_at_index: Some(i),
                results,
                failure: Some(failure),
            };
        }

        if let Some(root) = &entry.root {
            if seen_roots.contains(root.as_str()) {
                let failure = format!("cycle detected at index {i} (root already seen)");
                results.push(fail_result(checked_at.clone(), failure.clone()));
                return LineageChainVerification {
                    valid: false,
                    level: VerificationLevel::None,
                    broken_at_index: Some(i),
                    results,
                    failure: Some(failure),
                };
            }
            seen_roots.insert(root.as_str());
        }

        let mut achieved = VerificationLevel::Shape;
        let mut warnings: Vec<String> = Vec::new();

        if i > 0 {
            let prev = &chain[i - 1];
            let links = matches!(
                (&entry.previous_checkpoint, &prev.root),
                (Some(pc), Some(pr)) if pc == pr
            );
            if !links {
                let failure = format!(
                    "entry {i} previousCheckpoint does not resolve to entry {} root",
                    i - 1
                );
                results.push(fail_result(checked_at.clone(), failure.clone()));
                return LineageChainVerification {
                    valid: false,
                    level: VerificationLevel::None,
                    broken_at_index: Some(i),
                    results,
                    failure: Some(failure),
                };
            }
            if let (Some(seq), Some(prev_seq)) = (entry.sequence, prev.sequence) {
                if seq <= prev_seq {
                    let failure =
                        format!("entry {i} sequence ({seq}) is not strictly increasing");
                    results.push(fail_result(checked_at.clone(), failure.clone()));
                    return LineageChainVerification {
                        valid: false,
                        level: VerificationLevel::None,
                        broken_at_index: Some(i),
                        results,
                        failure: Some(failure),
                    };
                }
            }
            achieved = VerificationLevel::Digest;
        }

        if let Some(ts) = &entry.checkpoint_time {
            match parse_rfc3339_unix(ts) {
                None => warnings.push("checkpointTime not parseable".to_string()),
                Some(t) => {
                    if let Some(max_age) = opts.max_checkpoint_age_ms {
                        let now_unix = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);
                        if (now_unix - t) * 1000 > max_age {
                            warnings.push("checkpoint is stale".to_string());
                        }
                    }
                }
            }
        }

        if let (Some(sig), Some(issuer), Some(key_id)) =
            (&entry.signature, &entry.issuer, &entry.key_id)
        {
            match opts.resolve_key {
                None => {
                    warnings.push("no key resolver supplied; cannot verify signature".to_string())
                }
                Some(resolver) => match resolver(issuer, key_id) {
                    None => warnings.push(format!("unknown key '{key_id}'")),
                    Some(key) => {
                        let payload = canonical_json(&lineage_signable_value(entry));
                        let expected = hmac_sha256_hex(&key, &payload);
                        if constant_time_hex_eq(&expected, sig) {
                            achieved = VerificationLevel::Cryptographic;
                        } else {
                            let failure =
                                format!("entry {i} signature does not match canonical bytes");
                            results.push(fail_result(checked_at.clone(), failure.clone()));
                            return LineageChainVerification {
                                valid: false,
                                level: VerificationLevel::None,
                                broken_at_index: Some(i),
                                results,
                                failure: Some(failure),
                            };
                        }
                    }
                },
            }
        }

        results.push(VerificationResult {
            level: achieved,
            valid: true,
            algorithm: None,
            key_id: entry.key_id.clone(),
            checked_at: checked_at.clone(),
            subject_digest: None,
            warnings: if warnings.is_empty() { None } else { Some(warnings) },
            failure: None,
        });
        if i == 0 {
            genesis_achieved = Some(achieved);
        } else if achieved < min_achieved {
            min_achieved = achieved;
        }
    }

    if chain.len() == 1 {
        min_achieved = genesis_achieved.unwrap_or(VerificationLevel::Shape);
    }

    let valid = min_achieved >= opts.min_level;
    LineageChainVerification {
        valid,
        level: min_achieved,
        broken_at_index: None,
        results,
        failure: if valid {
            None
        } else {
            Some(format!(
                "minimum level '{}' not reached across chain (achieved '{}')",
                level_label(opts.min_level),
                level_label(min_achieved)
            ))
        },
    }
}
