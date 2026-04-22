use serde::Serialize;

use crate::client::Client;
use crate::error::Error;
use crate::types::Device;

/// Operations on OTA devices.
pub struct DevicesResource<'a> {
    pub(crate) client: &'a Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterBody {
    public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckUpdateBody {
    device_id: String,
    current_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatBody {
    device_id: String,
}

/// Response from the update check endpoint.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResponse {
    /// Whether an update is available.
    pub update_available: bool,
    /// The version of the available update, if any.
    #[serde(default)]
    pub version: Option<String>,
    /// Download URL for the firmware, if an update is available.
    #[serde(default)]
    pub download_url: Option<String>,
}

/// Response from the heartbeat endpoint.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
    pub success: bool,
}

impl<'a> DevicesResource<'a> {
    /// Register a new device with its Ed25519 public key.
    pub async fn register(&self, public_key: &str) -> Result<Device, Error> {
        let body = RegisterBody {
            public_key: public_key.to_owned(),
        };
        self.client.post("/seedRegisterDevice", &body).await
    }

    /// Check whether a firmware update is available for the given device.
    pub async fn check_update(
        &self,
        device_id: &str,
        current_version: &str,
    ) -> Result<UpdateCheckResponse, Error> {
        let body = CheckUpdateBody {
            device_id: device_id.to_owned(),
            current_version: current_version.to_owned(),
        };
        self.client.post("/seedCheckUpdate", &body).await
    }

    /// Send a heartbeat for a device.
    pub async fn heartbeat(&self, device_id: &str) -> Result<HeartbeatResponse, Error> {
        let body = HeartbeatBody {
            device_id: device_id.to_owned(),
        };
        self.client.post("/seedHeartbeat", &body).await
    }
}
