//! Pairing resource — `/api/v1/pair{,/status,/:client_name}`.

use crate::error::Error;
use crate::seed::client::SeedClient;
use crate::seed::config::CallOptions;
use crate::seed::models::{PairCreate, PairCreateResponse, PairStatus};

/// Pairing endpoints.
pub struct PairResource<'c> {
    pub(crate) client: &'c SeedClient,
}

impl<'c> PairResource<'c> {
    /// `GET /api/v1/pair/status` — read current pairing state (allowlisted).
    pub async fn status(&self) -> Result<PairStatus, Error> {
        self.client.request_get("/pair/status").await
    }

    /// [`Self::status`] with per-call [`CallOptions`] overrides.
    pub async fn status_with(&self, opts: CallOptions) -> Result<PairStatus, Error> {
        self.client.request_get_opts("/pair/status", &opts).await
    }

    /// `POST /api/v1/pair` — create a new pairing inside the 30s window.
    pub async fn create(&self, req: PairCreate) -> Result<PairCreateResponse, Error> {
        self.client.request_post("/pair", &req, false).await
    }

    /// [`Self::create`] with per-call [`CallOptions`] overrides.
    pub async fn create_with(
        &self,
        req: PairCreate,
        opts: CallOptions,
    ) -> Result<PairCreateResponse, Error> {
        self.client
            .request_post_opts("/pair", &req, false, &opts)
            .await
    }

    /// `DELETE /api/v1/pair/{client_name}` — unpair by name.
    pub async fn delete(&self, client_name: &str) -> Result<(), Error> {
        let encoded = urlencoding_light(client_name);
        let path = format!("/pair/{encoded}");
        // Response is typically empty; deserialize to `()`.
        let _: serde_json::Value = self.client.request_delete(&path).await?;
        Ok(())
    }
}

/// Minimal percent-encoding for path segments. Only escapes characters
/// that would break URL parsing in practice (space, `/`, `?`, `#`, `%`).
/// Avoids pulling in `percent-encoding` for Phase 1.
fn urlencoding_light(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '?' => out.push_str("%3F"),
            '#' => out.push_str("%23"),
            ' ' => out.push_str("%20"),
            c if c.is_ascii_alphanumeric() => out.push(c),
            c if matches!(c, '-' | '_' | '.' | '~') => out.push(c),
            c => {
                let mut buf = [0u8; 4];
                for byte in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_light_handles_safe_chars() {
        assert_eq!(urlencoding_light("abc-123_XYZ.~"), "abc-123_XYZ.~");
    }

    #[test]
    fn urlencoding_light_encodes_special() {
        assert_eq!(urlencoding_light("foo/bar"), "foo%2Fbar");
        assert_eq!(urlencoding_light("a b"), "a%20b");
    }
}
