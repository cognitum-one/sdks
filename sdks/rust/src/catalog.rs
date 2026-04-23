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
        let path = format!("/listTemplates?category={}", urlencoding_minimal(category));
        self.client.get(&path).await
    }
}

/// Minimal percent-encoding for query parameter values.
pub(crate) fn urlencoding_minimal(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '&' => out.push_str("%26"),
            '=' => out.push_str("%3D"),
            '?' => out.push_str("%3F"),
            '#' => out.push_str("%23"),
            other => out.push(other),
        }
    }
    out
}
