use crate::client::Client;
use crate::error::Error;
use crate::types::CatalogResponse;

/// Operations on the Cognitum product catalog.
pub struct CatalogResource<'a> {
    pub(crate) client: &'a Client,
}

impl<'a> CatalogResource<'a> {
    /// Browse all products in the catalog.
    pub async fn browse(&self) -> Result<CatalogResponse, Error> {
        self.client.get("/listTemplates").await
    }

    /// Browse products filtered by a specific category.
    pub async fn browse_with_category(&self, category: &str) -> Result<CatalogResponse, Error> {
        let path = format!("/listTemplates?category={}", encode_query_value(category));
        self.client.get(&path).await
    }
}

/// Percent-encode a query parameter value (RFC 3986).
///
/// Every byte outside the unreserved set `A-Z a-z 0-9 - . _ ~` is encoded,
/// so `+` stays a literal plus (servers decode a bare `+` as a space) and
/// `%` cannot start a bogus escape. Non-ASCII text is encoded as UTF-8.
pub(crate) fn encode_query_value(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
