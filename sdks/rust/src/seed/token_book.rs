//! Per-peer pairing-token store (ADR-0016a §D5).
//!
//! Seed pairing is per-device: `DELETE /api/v1/pair/{client_name}` deletes
//! one client on one seed, so an SDK talking to N peers needs N potentially
//! distinct tokens. The [`TokenBook`] trait lets callers plug in whatever
//! storage they want (OS keychain, encrypted file, test fixture).
//!
//! The default in-memory implementation zeroes out its values on drop by
//! wrapping the inner string in [`SecretString`].

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};

/// A pairing token. Intentionally opaque — the wire value is exposed only
/// through [`SecretString::as_str`] on the request path.
///
/// Drops overwrite the heap buffer with zeros best-effort (see
/// [`Drop`](SecretString::drop)).
pub struct SecretString {
    inner: String,
}

impl SecretString {
    /// Wrap an existing token. Prefer [`SecretString::from_owned`] when
    /// the caller can move the source buffer in (avoids an alloc).
    pub fn new(s: impl Into<String>) -> Self {
        Self { inner: s.into() }
    }

    /// Move an existing `String` in. Equivalent to [`SecretString::new`].
    pub fn from_owned(s: String) -> Self {
        Self { inner: s }
    }

    /// Borrow the inner token. Use sparingly.
    pub fn as_str(&self) -> &str {
        &self.inner
    }

    /// Whether the underlying string is empty.
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

impl Clone for SecretString {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl Default for SecretString {
    /// Empty secret. Needed so wire-type response structs that embed
    /// `SecretString` can use `#[serde(default)]` on the field
    /// (e.g. `PairCreateResponse.token` per [cognitum-one/sdks#15]).
    ///
    /// [cognitum-one/sdks#15]: https://github.com/cognitum-one/sdks/issues/15
    fn default() -> Self {
        Self {
            inner: String::new(),
        }
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretString(<redacted, {} bytes>)", self.inner.len())
    }
}

impl Serialize for SecretString {
    /// Serialize the raw token value. Required so wire-type response
    /// structs that embed `SecretString` (e.g. `PairCreateResponse` per
    /// [cognitum-one/sdks#15]) satisfy the ADR-0010 "Serialize on all
    /// wire types" convention and can round-trip through JSON.
    ///
    /// The Debug impl still redacts — only explicit serde serialization
    /// reveals the inner value.
    ///
    /// [cognitum-one/sdks#15]: https://github.com/cognitum-one/sdks/issues/15
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.inner)
    }
}

impl<'de> Deserialize<'de> for SecretString {
    /// Deserialize from a JSON string into a `SecretString`. Added for
    /// [cognitum-one/sdks#15] so `PairCreateResponse.token` can hold a
    /// redacting wrapper while still round-tripping through the seed
    /// API's `{"token": "..."}` response shape.
    ///
    /// [cognitum-one/sdks#15]: https://github.com/cognitum-one/sdks/issues/15
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer).map_err(de::Error::custom)?;
        Ok(Self::from_owned(raw))
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        // Overwrite the allocation best-effort. Not a hard guarantee
        // against compiler optimisation, but it covers the common case
        // where the buffer stays resident until the allocator reclaims it.
        let bytes = unsafe { self.inner.as_bytes_mut() };
        for b in bytes {
            *b = 0;
        }
    }
}

/// Peer-keyed pairing-token store. Implementers MUST key on a normalised
/// peer URL (use [`Endpoint::key`](super::peers::Endpoint::key)).
pub trait TokenBook: Send + Sync + fmt::Debug {
    /// Look up the token for `peer_url`. Returns `None` when no pairing
    /// exists for that peer (the call either surfaces an auth error or
    /// proceeds unauthenticated for WiFi-read endpoints).
    fn get(&self, peer_url: &str) -> Option<SecretString>;
    /// Store `token` under `peer_url`. Overwrites any previous value.
    fn set(&mut self, peer_url: &str, token: SecretString);
    /// Forget the token for `peer_url`. Idempotent.
    fn delete(&mut self, peer_url: &str);
}

/// Default in-memory implementation. Not persisted; tokens vanish when
/// the owning [`SeedClient`](super::SeedClient) is dropped.
#[derive(Debug, Default)]
pub struct InMemoryTokenBook {
    inner: BTreeMap<String, SecretString>,
}

impl InMemoryTokenBook {
    /// Create an empty book.
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a book from an iterator of `(peer_url, token)` pairs.
    pub fn from_map<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let mut book = Self::new();
        for (k, v) in pairs {
            book.set(&k.into(), SecretString::new(v));
        }
        book
    }
}

impl TokenBook for InMemoryTokenBook {
    fn get(&self, peer_url: &str) -> Option<SecretString> {
        self.inner.get(&normalize(peer_url)).cloned()
    }

    fn set(&mut self, peer_url: &str, token: SecretString) {
        self.inner.insert(normalize(peer_url), token);
    }

    fn delete(&mut self, peer_url: &str) {
        self.inner.remove(&normalize(peer_url));
    }
}

/// Thread-safe wrapper around a boxed [`TokenBook`]. The seed client
/// passes this to every request path so reads and writes serialize.
#[derive(Clone)]
pub struct SharedTokenBook {
    inner: Arc<Mutex<Box<dyn TokenBook>>>,
}

impl SharedTokenBook {
    /// Wrap an existing `TokenBook` in shared storage.
    pub fn new(book: impl TokenBook + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Box::new(book))),
        }
    }

    /// Wrap an already-boxed `TokenBook`.
    pub fn from_boxed(book: Box<dyn TokenBook>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(book)),
        }
    }

    /// Look up a token by peer URL.
    pub fn get(&self, peer_url: &str) -> Option<SecretString> {
        let guard = self.inner.lock().ok()?;
        guard.get(peer_url)
    }

    /// Store a token for a peer URL.
    pub fn set(&self, peer_url: &str, token: SecretString) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.set(peer_url, token);
        }
    }

    /// Delete a token for a peer URL.
    pub fn delete(&self, peer_url: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.delete(peer_url);
        }
    }
}

impl Default for SharedTokenBook {
    fn default() -> Self {
        Self::new(InMemoryTokenBook::new())
    }
}

impl fmt::Debug for SharedTokenBook {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SharedTokenBook").finish_non_exhaustive()
    }
}

fn normalize(peer_url: &str) -> String {
    peer_url.trim_end_matches('/').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_get_set_delete() {
        let mut book = InMemoryTokenBook::new();
        assert!(book.get("https://a:8443").is_none());

        book.set("https://a:8443", SecretString::new("tok-a"));
        assert_eq!(book.get("https://a:8443").unwrap().as_str(), "tok-a");

        book.delete("https://a:8443");
        assert!(book.get("https://a:8443").is_none());
    }

    #[test]
    fn in_memory_trailing_slash_normalized() {
        let mut book = InMemoryTokenBook::new();
        book.set("https://a:8443/", SecretString::new("tok"));
        assert_eq!(book.get("https://a:8443").unwrap().as_str(), "tok");
    }

    #[test]
    fn from_map_populates_entries() {
        let book =
            InMemoryTokenBook::from_map([("https://a:8443", "tok-a"), ("https://b:8443", "tok-b")]);
        assert_eq!(book.get("https://a:8443").unwrap().as_str(), "tok-a");
        assert_eq!(book.get("https://b:8443").unwrap().as_str(), "tok-b");
    }

    #[test]
    fn shared_book_is_clone_cheap() {
        let shared = SharedTokenBook::default();
        shared.set("https://a:8443", SecretString::new("t"));
        let shared2 = shared.clone();
        assert_eq!(shared2.get("https://a:8443").unwrap().as_str(), "t");
        shared.delete("https://a:8443");
        assert!(shared2.get("https://a:8443").is_none());
    }

    #[test]
    fn debug_does_not_leak_secret() {
        let s = SecretString::new("hunter2");
        let dbg = format!("{s:?}");
        assert!(!dbg.contains("hunter2"));
    }
}
