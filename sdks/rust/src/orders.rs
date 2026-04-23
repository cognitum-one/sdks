use serde::Serialize;

use crate::client::Client;
use crate::error::Error;
use crate::types::{Order, OrderCreateResponse};

/// Operations on orders (presale payment intents).
pub struct OrdersResource<'a> {
    pub(crate) client: &'a Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrderBody {
    email: String,
    quantity: u32,
}

impl<'a> OrdersResource<'a> {
    /// Look up orders by email address.
    pub async fn status(&self, email: &str) -> Result<Vec<Order>, Error> {
        let path = format!(
            "/lookupOrderStatus?email={}",
            crate::catalog::urlencoding_minimal(email)
        );
        self.client.get(&path).await
    }

    /// Create a new presale payment intent.
    pub async fn create(&self, email: &str, quantity: u32) -> Result<OrderCreateResponse, Error> {
        let body = CreateOrderBody {
            email: email.to_owned(),
            quantity,
        };
        self.client.post("/createPresalePaymentIntent", &body).await
    }
}
