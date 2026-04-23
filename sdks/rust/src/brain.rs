use serde::Serialize;

use crate::client::Client;
use crate::error::Error;
use crate::types::BrainSearchResponse;

/// Operations on the brain / knowledge memory API.
pub struct BrainResource<'a> {
    pub(crate) client: &'a Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareBody {
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchBody {
    query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoteBody {
    memory_id: String,
    vote: i8,
}

/// Response from the share endpoint.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareResponse {
    pub success: bool,
    #[serde(default)]
    pub id: Option<String>,
}

/// Response from the vote endpoint.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteResponse {
    pub success: bool,
}

impl<'a> BrainResource<'a> {
    /// Share a new memory / knowledge entry.
    pub async fn share(
        &self,
        content: &str,
        namespace: Option<&str>,
        tags: Option<Vec<String>>,
    ) -> Result<ShareResponse, Error> {
        let body = ShareBody {
            content: content.to_owned(),
            namespace: namespace.map(|s| s.to_owned()),
            tags,
        };
        self.client.post("/brainShare", &body).await
    }

    /// Semantic search across brain memories.
    pub async fn search(
        &self,
        query: &str,
        namespace: Option<&str>,
        limit: Option<u32>,
    ) -> Result<BrainSearchResponse, Error> {
        let body = SearchBody {
            query: query.to_owned(),
            namespace: namespace.map(|s| s.to_owned()),
            limit,
        };
        self.client.post("/brainSearch", &body).await
    }

    /// Vote on a memory entry (positive = 1, negative = -1).
    pub async fn vote(&self, memory_id: &str, vote: i8) -> Result<VoteResponse, Error> {
        let body = VoteBody {
            memory_id: memory_id.to_owned(),
            vote,
        };
        self.client.post("/brainVote", &body).await
    }
}
