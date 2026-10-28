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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_confirmation: Option<EndpointConfirmation>,
}

/// Explicit user acceptance, bound to the exact account and connection settings.
/// It is not a server-provided claim and does not replace certificate validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointConfirmation {
    pub email: String,
    pub host: String,
    pub port: u16,
    pub encryption: Encryption,
    pub username: String,
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
/// Address syntax shared by IMAP and API accounts, without transport policy.
pub fn normalize_address(address: &str) -> Result<String> {
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
    Ok(email)
}
/// Existing IMAP connection policy remains unchanged.
pub fn normalize_email(address: &str) -> Result<String> {
    let email = normalize_address(address)?;
    let domain = email.split_once('@').ok_or(Error::Address)?.1;
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
            endpoint_confirmation: None,
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

impl ConnectionConfig {
    pub fn same_endpoint(&self, other: &Self) -> bool {
        self.host == other.host
            && self.port == other.port
            && self.encryption == other.encryption
            && self.username == other.username
            && self.send_id == other.send_id
    }
    pub fn requires_endpoint_confirmation(&self, email: &str) -> Result<bool> {
        let email = normalize_email(email)?;
        let domain = email.split_once('@').ok_or(Error::Address)?.1;
        let host = self.host.trim().to_ascii_lowercase();
        let in_domain =
            host == domain || host.strip_suffix(domain).is_some_and(|p| p.ends_with('.'));
        // Canonical endpoints only, never arbitrary subdomains of a provider.
        let provider = self.port == 993
            && self.encryption == Encryption::Tls
            && matches!(
                host.as_str(),
                "imap.qq.com"
                    | "imap.163.com"
                    | "imap.126.com"
                    | "imap.gmail.com"
                    | "imap.mail.me.com"
                    | "imap.sina.com"
                    | "imap.sina.cn"
                    | "imap.vip.sina.com"
                    | "imap.vip.sina.cn"
                    | "imap.sohu.com"
                    | "imap.aliyun.com"
                    | "imap.139.com"
                    | "imap.exmail.qq.com"
                    | "imap.qiye.163.com"
            );
        Ok(!in_domain && !provider)
    }
    pub fn endpoint_confirmation_for(&self, email: &str) -> Result<EndpointConfirmation> {
        Ok(EndpointConfirmation {
            email: normalize_email(email)?,
            host: self.host.clone(),
            port: self.port,
            encryption: self.encryption,
            username: self.username.clone(),
            send_id: self.send_id,
        })
    }
    pub fn authorize_endpoint(&self, email: &str) -> Result<()> {
        if self.requires_endpoint_confirmation(email)?
            && self.endpoint_confirmation.as_ref() != Some(&self.endpoint_confirmation_for(email)?)
        {
            return Err(Error::EndpointConfirmation);
        }
        Ok(())
    }
}
