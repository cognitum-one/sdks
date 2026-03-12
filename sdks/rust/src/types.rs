use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// A product in the Cognitum catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub price_cents: Option<u64>,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub available: Option<bool>,
}

/// Response returned by the catalog browse endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub products: Vec<Product>,
    #[serde(default)]
    pub total: Option<u64>,
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/// An existing order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub order_id: String,
    pub email: String,
    pub status: String,
    #[serde(default)]
    pub quantity: Option<u32>,
    #[serde(default)]
    pub amount_cents: Option<u64>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// Response when creating a new order (presale payment intent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderCreateResponse {
    pub client_secret: String,
    #[serde(default)]
    pub order_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/// Response after subscribing a lead.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadSubscribeResponse {
    pub success: bool,
    #[serde(default)]
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

/// Response after sending a contact message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSendResponse {
    pub success: bool,
    #[serde(default)]
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/// An MCP tool definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: Option<serde_json::Value>,
}

/// Result of invoking an MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolResult {
    #[serde(default)]
    pub content: Option<serde_json::Value>,
    #[serde(default)]
    pub is_error: Option<bool>,
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/// A registered OTA device.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub firmware_version: Option<String>,
    #[serde(default)]
    pub last_seen: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

/// Fleet-level statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetStatus {
    #[serde(default)]
    pub total_devices: Option<u64>,
    #[serde(default)]
    pub online_devices: Option<u64>,
    #[serde(default)]
    pub pending_updates: Option<u64>,
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/// Health-check response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
}

// ---------------------------------------------------------------------------
// Brain (knowledge / memory)
// ---------------------------------------------------------------------------

/// A single memory entry in the brain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainMemory {
    #[serde(default)]
    pub id: Option<String>,
    pub content: String,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// Response from a brain search query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainSearchResponse {
    pub results: Vec<BrainMemory>,
    #[serde(default)]
    pub total: Option<u64>,
}

/// Result from a docs search.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsSearchResult {
    pub title: String,
    #[serde(default)]
    pub snippet: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
}
