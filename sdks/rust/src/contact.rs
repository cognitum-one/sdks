use serde::Serialize;

use crate::client::Client;
use crate::error::Error;
use crate::types::ContactSendResponse;

/// Operations on the contact form API.
pub struct ContactResource<'a> {
    pub(crate) client: &'a Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContactBody {
    name: String,
    email: String,
    message: String,
    inquiry_type: String,
}

impl<'a> ContactResource<'a> {
    /// Send a contact form message.
    pub async fn send(
        &self,
        name: &str,
        email: &str,
        message: &str,
        inquiry_type: &str,
    ) -> Result<ContactSendResponse, Error> {
        let body = ContactBody {
            name: name.to_owned(),
            email: email.to_owned(),
            message: message.to_owned(),
            inquiry_type: inquiry_type.to_owned(),
        };
        self.client.post("/sendContactEmail", &body).await
    }
}
