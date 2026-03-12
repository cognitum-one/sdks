use serde::Serialize;

use crate::client::Client;
use crate::error::Error;
use crate::types::LeadSubscribeResponse;

/// Operations on the leads / waitlist API.
pub struct LeadsResource<'a> {
    pub(crate) client: &'a Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeBody {
    email: String,
    product: String,
}

impl<'a> LeadsResource<'a> {
    /// Subscribe an email to the notify-me / waitlist for a given product.
    pub async fn subscribe(
        &self,
        email: &str,
        product: &str,
    ) -> Result<LeadSubscribeResponse, Error> {
        let body = SubscribeBody {
            email: email.to_owned(),
            product: product.to_owned(),
        };
        self.client.post("/saveNotifyLead", &body).await
    }
}
