use crate::{Error, Provider, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encryption {
    Tls,
    Starttls,
}

/// No credentials. Every endpoint is visible/editable before an explicit connect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub encryption: Encryption,
    pub username: String,
    #[serde(default)]
    pub send_id: bool,
}

pub fn valid_host(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host.parse::<std::net::IpAddr>().is_err()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
pub fn normalize_email(address: &str) -> Result<String> {
    let email = address.trim().to_ascii_lowercase();
    let (local, domain) = email.split_once('@').ok_or(Error::Address)?;
    if local.is_empty()
        || local.len() > 64
        || email.len() > 254
        || !local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        || !valid_host(domain)
    {
        return Err(Error::Address);
    }
    if matches!(
        domain,
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com"
    ) {
        return Err(Error::OAuthRequired);
    }
    Ok(email)
}
impl ConnectionConfig {
    pub fn preset(email: &str) -> Result<Self> {
        let (email, provider) = Provider::detect(email)?;
        let domain = email.split_once('@').unwrap().1;
        let host = if provider == Provider::Sina {
            format!("imap.{domain}")
        } else {
            provider.server().to_string()
        };
        Ok(Self {
            host,
            port: 993,
            encryption: Encryption::Tls,
            username: email,
            send_id: provider.needs_id(),
        })
    }
    pub fn validated(mut self, email: &str) -> Result<Self> {
        normalize_email(email)?;
        self.host = self.host.trim().to_ascii_lowercase();
        self.username = self.username.trim().to_string();
        if !valid_host(&self.host)
            || self.port == 0
            || self.username.is_empty()
            || self.username.len() > 254
            || self.username.chars().any(char::is_control)
        {
            return Err(Error::Configuration);
        }
        // The NetEase ID requirement also applies when manually overriding its host.
        self.send_id |= Provider::detect(email).is_ok_and(|(_, p)| p.needs_id());
        Ok(self)
    }
}
