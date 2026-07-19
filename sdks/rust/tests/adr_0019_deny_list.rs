//! ADR-0019 "Compliance and verification" #5 (issue #74): deny-list test.
//!
//! > A deny-list test fails if a product module imports another product
//! > module.
//!
//! ADR-0019 §D4: "Product modules MUST NOT import one another." The one
//! documented exception is §D7: "Meta LLM and Meta Proxy share OpenAI and
//! Anthropic wire primitives where their capability sets agree. They do
//! not share a client class." In this crate that carve-out is exercised by
//! `src/meta_proxy/{client,stream/chat_completions_stream,stream/envelope}.rs`
//! importing `crate::meta_llm::types::*` and `crate::meta_llm::stream::*` --
//! wire-shape and wire-parsing helpers only, never `crate::meta_llm::client`
//! (the client class). This test runs unconditionally (source-scan only,
//! no feature gate) and denies any `use crate::<other-product>` from one
//! product's source directory into another's, with a narrow allowlist for
//! exactly that carve-out.

use std::fs;
use std::path::{Path, PathBuf};

const PRODUCTS: [&str; 4] = ["meta_llm", "meta_proxy", "metaharness", "harnessaas"];

/// ADR-0019 §D7's one documented wire-type carve-out.
fn allowed_cross_imports(product: &str) -> &'static [&'static str] {
    match product {
        "meta_proxy" => &["crate::meta_llm::types", "crate::meta_llm::stream"],
        _ => &[],
    }
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(rust_files(&path));
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// Every actual CODE line (doc comments and regular comments excluded --
/// this file is full of legitimate cross-references like "mirrors
/// `crate::meta_proxy::config`'s conventions" in prose, which are not
/// imports) referencing `crate::<other_product>`, whether via a `use`
/// statement or an inline fully-qualified path (e.g.
/// `crate::meta_llm::types::openai::Foo`).
fn references_product_prefix(source: &str, other_product: &str) -> Vec<String> {
    let needle = format!("crate::{other_product}");
    source
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("//")) // excludes `//`, `///`, `//!`
        .filter(|line| line.contains(&needle))
        .map(str::to_owned)
        .collect()
}

fn src_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

#[test]
fn no_product_module_imports_another_product_module() {
    let root = src_root();
    let mut violations: Vec<String> = Vec::new();

    for product in PRODUCTS {
        let product_dir = root.join(product);
        let files = rust_files(&product_dir);
        assert!(!files.is_empty(), "expected .rs files under {}", product_dir.display());

        for file in &files {
            let source = fs::read_to_string(file).expect("readable source file");
            for other_product in PRODUCTS {
                if other_product == product {
                    continue;
                }
                let hits = references_product_prefix(&source, other_product);
                if hits.is_empty() {
                    continue;
                }
                let allowed = allowed_cross_imports(product);
                for hit in hits {
                    let is_allowed = allowed.iter().any(|prefix| hit.contains(prefix));
                    if !is_allowed {
                        violations.push(format!(
                            "{}: {:?} references product {:?} -- forbidden by ADR-0019 §D4, \
                             no §D7 wire-type carve-out matches",
                            file.strip_prefix(&root).unwrap_or(file).display(),
                            hit,
                            other_product,
                        ));
                    }
                }
            }
        }
    }

    assert!(violations.is_empty(), "\n{}", violations.join("\n"));
}

#[test]
fn meta_proxy_wire_type_carve_out_is_exercised() {
    let root = src_root();
    let files = rust_files(&root.join("meta_proxy"));
    let allowed = allowed_cross_imports("meta_proxy");
    let mut used = false;
    for file in &files {
        let source = fs::read_to_string(file).expect("readable source file");
        let hits = references_product_prefix(&source, "meta_llm");
        if hits.iter().any(|hit| allowed.iter().any(|prefix| hit.contains(prefix))) {
            used = true;
        }
    }
    assert!(
        used,
        "expected at least one src/meta_proxy file to reference crate::meta_llm::types or \
         crate::meta_llm::stream (ADR-0019 §D7) -- if this no longer holds, remove the dead \
         allowlist entry in allowed_cross_imports()"
    );
}
