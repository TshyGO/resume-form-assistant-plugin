//! Look up only the domain via the machine's DNS resolver. Never fetch web pages,
//! send credentials, log queries, or infer IMAP addresses directly from MX hosts.
use crate::{config::normalize_email, ConnectionConfig, Encryption, Provider, Result};
use hickory_resolver::{system_conf::read_system_conf, TokioAsyncResolver};
use serde::Serialize;
use std::time::Duration;
pub const HELP_URLS: &[&str] = &[
    "https://service.mail.qq.com/",
    "https://help.mail.163.com/",
    "https://help.mail.126.com/",
    "https://support.google.com/mail/answer/185833?hl=zh-Hans",
    "https://support.apple.com/zh-cn/102654",
    "https://help.sina.com.cn/comquestiondetail/view/1566/",
    "https://mail.sohu.com/",
    "https://mailhelp.aliyun.com/",
    "https://help.mail.10086.cn/statichtml/1/Content/3837.html",
    "https://mails.tsinghua.edu.cn/coremail/help/notice.html",
    "https://exmail.qq.com",
    "https://qiye.163.com",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub config: Option<ConnectionConfig>,
    pub source: &'static str,
    pub provider: Option<Provider>,
    pub note: String,
    pub help_url: Option<&'static str>,
}
fn manual(note: &str) -> Discovery {
    Discovery {
        config: None,
        source: "manual",
        provider: None,
        note: note.into(),
        help_url: None,
    }
}
pub fn local(address: &str) -> Result<Discovery> {
    let email = normalize_email(address)?;
    if let Ok(config) = ConnectionConfig::preset(&email) {
        return Ok(Discovery {
            config: Some(config),
            source: "preset",
            provider: Provider::detect(&email).ok().map(|(_, p)| p),
            note: "已填入邮箱服务商配置，可核对或修改后测试连接。".into(),
            help_url: None,
        });
    }
    let domain = email.split_once('@').unwrap().1;
    // Exact domains, not *.tsinghua.edu.cn. Student and faculty endpoints differ.
    if matches!(domain, "mails.tsinghua.edu.cn" | "mail.tsinghua.edu.cn") {
        return Ok(Discovery { config: Some(ConnectionConfig { host: domain.into(), port: 993,
            encryption: Encryption::Tls, username: email, send_id: false }),
            source: "school", provider: Some(Provider::Custom),
            note: "清华大学邮箱：请在网页版安全设置中生成客户端专用密码；若账号要求短用户名，可在下方修改。".into(),
            help_url: Some("https://mails.tsinghua.edu.cn/coremail/help/notice.html") });
    }
    Ok(manual(
        "没有内置配置，可查询域名配置，或按学校信息中心的邮箱客户端教程手动填写。",
    ))
}
fn belongs(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}
/// MX is only a provider hint. The IMAP endpoint comes from a known provider
/// configuration and still needs explicit user testing. Coremail varies by school.
fn from_mx(email: &str, hosts: &[String]) -> Option<Discovery> {
    let (host, note, url, send_id) = if hosts.iter().any(|s| {
        belongs(s, "exmail.qq.com") || matches!(s.as_str(), "mxbiz1.qq.com" | "mxbiz2.qq.com")
    }) {
        ("imap.exmail.qq.com", "域名邮件路由指向腾讯企业邮，已填入其通用 IMAP 配置。请按学校要求核对服务器和客户端专用密码。", "https://exmail.qq.com", false)
    } else if hosts.iter().any(|s| belongs(s, "qiye.163.com")) {
        ("imap.qiye.163.com", "域名邮件路由指向网易企业邮，已填入其通用 IMAP 配置。请按学校要求核对服务器和客户端授权密码。", "https://qiye.163.com", true)
    } else {
        return None;
    };
    Some(Discovery {
        config: Some(ConnectionConfig {
            host: host.into(),
            port: 993,
            encryption: Encryption::Tls,
            username: email.into(),
            send_id,
        }),
        source: "dns",
        provider: Some(Provider::Custom),
        note: note.into(),
        help_url: Some(url),
    })
}
async fn dns(email: &str) -> Option<Discovery> {
    let domain = email.split_once('@')?.1;
    let (configuration, mut options) = read_system_conf().ok()?;
    options.timeout = Duration::from_secs(1);
    options.attempts = 1;
    let resolver = TokioAsyncResolver::tokio(configuration, options);
    let mut tls_disabled = false;
    for (service, encryption) in [
        ("_imaps._tcp", Encryption::Tls),
        ("_imap._tcp", Encryption::Starttls),
    ] {
        if let Ok(records) = resolver.srv_lookup(format!("{service}.{domain}.")).await {
            if records.iter().any(|r| r.target().to_utf8() == ".") {
                if encryption == Encryption::Tls {
                    tls_disabled = true;
                }
                continue;
            }
            // RFC 6186 target '.' explicitly says this service is not available.
            let mut records: Vec<_> = records
                .iter()
                .filter(|r| r.target().to_utf8() != ".")
                .filter(|r| {
                    r.port() > 0
                        && crate::config::valid_host(r.target().to_utf8().trim_end_matches('.'))
                })
                .collect();
            records.sort_by_key(|r| r.priority());
            if let Some(first) = records.first() {
                let priority = first.priority();
                records.retain(|r| r.priority() == priority);
                let total: u64 = records.iter().map(|r| u64::from(r.weight())).sum();
                let mut pick = if total == 0 {
                    0
                } else {
                    (uuid::Uuid::new_v4().as_u128() % u128::from(total)) as u64
                };
                let record = records.iter().find(|r| {
                    if total == 0 {
                        return true;
                    }
                    if pick < u64::from(r.weight()) {
                        true
                    } else {
                        pick -= u64::from(r.weight());
                        false
                    }
                })?;
                return Some(Discovery { config: Some(ConnectionConfig { host: record.target().to_utf8().trim_end_matches('.').into(),
                    port: record.port(), encryption, username: email.into(), send_id: false }),
                    source: "dns", provider: Some(Provider::Custom),
                    note: "已从域名公布的 IMAP 配置填入服务器。请核对服务器，并按学校要求填写登录凭据；识别成功不代表学校已开放访问。".into(), help_url: None });
            }
        }
    }
    if tls_disabled {
        return None;
    }
    let hosts = resolver
        .mx_lookup(format!("{domain}."))
        .await
        .ok()?
        .iter()
        .map(|r| {
            r.exchange()
                .to_utf8()
                .trim_end_matches('.')
                .to_ascii_lowercase()
        })
        .collect::<Vec<_>>();
    from_mx(email, &hosts)
}
pub async fn discover(address: &str) -> Result<Discovery> {
    let email = normalize_email(address)?;
    let local = local(&email)?;
    if local.config.is_some() {
        return Ok(local);
    }
    Ok(tokio::time::timeout(Duration::from_secs(3), dns(&email)).await.ok().flatten()
        .unwrap_or_else(|| manual("未能自动识别或查询已超时。请按学校信息中心的邮箱客户端教程手动填写；网页登录地址不能直接作为 IMAP 地址。")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn school_domains_are_exact_and_student_faculty_are_separate() {
        for domain in ["mails.tsinghua.edu.cn", "mail.tsinghua.edu.cn"] {
            let result = local(&format!("student@{domain}")).unwrap();
            assert_eq!(result.source, "school");
            assert_eq!(result.config.unwrap().host, domain);
            assert!(result.note.contains("客户端专用密码"));
        }
        for domain in ["evil.tsinghua.edu.cn", "mails.tsinghua.edu.cn.evil.test"] {
            assert!(local(&format!("user@{domain}")).unwrap().config.is_none());
        }
    }
    #[test]
    fn mx_mapping_requires_label_boundary_and_never_reuses_delivery_host() {
        let found = from_mx("a@school.example", &["mxbiz1.qq.com".into()]);
        assert_eq!(found.unwrap().config.unwrap().host, "imap.exmail.qq.com");
        let found = from_mx("a@school.example", &["mx.exmail.qq.com".into()]).unwrap();
        assert_eq!(found.config.unwrap().host, "imap.exmail.qq.com");
        for host in [
            "exmail.qq.com.evil.test",
            "notexmail.qq.com",
            "mx.coremail.cn",
        ] {
            assert!(from_mx("a@school.example", &[host.into()]).is_none());
        }
    }
}
