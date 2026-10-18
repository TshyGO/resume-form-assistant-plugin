use crate::path::response_path;
use crate::{Error, ErrorKind, RemotePath};
use std::collections::HashSet;
use url::Url;

pub const MAX_XML_BYTES: usize = 1024 * 1024;
pub const NUTSTORE_LIST_LIMIT: usize = 750;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completeness {
    Complete,
    PossiblyTruncated,
    UnverifiedServer,
}
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: RemotePath,
    pub collection: bool,
    pub size: Option<u64>,
    /// Opaque server token, never assumed to be a content hash.
    pub etag: Option<String>,
}
#[derive(Debug, Clone)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub completeness: Completeness,
}
impl Listing {
    pub fn safe_for_cleanup(&self) -> bool {
        self.completeness == Completeness::Complete
    }
}

fn dav<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<roxmltree::Node<'a, 'a>> {
    node.children()
        .find(|child| child.has_tag_name(("DAV:", name)))
}
fn status_ok(status: &str) -> bool {
    let mut parts = status.split_whitespace();
    matches!(
        parts.next(),
        Some("HTTP/1.1" | "HTTP/1.0" | "HTTP/2" | "HTTP/2.0")
    ) && parts.next() == Some("200")
}
pub(crate) fn parse(
    root: &Url,
    requested: &RemotePath,
    bytes: &[u8],
    known_limit: Option<usize>,
) -> Result<Listing, Error> {
    let invalid = || Error::new(ErrorKind::InvalidResponse);
    if bytes.len() > MAX_XML_BYTES {
        return Err(Error::new(ErrorKind::TooLarge));
    }
    let xml = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let document = roxmltree::Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: 200_000,
            ..Default::default()
        },
    )
    .map_err(|_| invalid())?;
    let top = document.root_element();
    if !top.has_tag_name(("DAV:", "multistatus")) {
        return Err(invalid());
    }
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut count = 0usize;
    let mut continuation = false;
    for response in top.children().filter(|node| node.is_element()) {
        if !response.has_tag_name(("DAV:", "response")) {
            continuation = true;
            continue;
        }
        count += 1;
        if count > 1000 {
            return Err(Error::new(ErrorKind::TooLarge));
        }
        let href = dav(response, "href")
            .and_then(|node| node.text())
            .ok_or_else(invalid)?;
        let path = response_path(root, requested, href)?;
        if !seen.insert(path.clone()) {
            return Err(invalid());
        }
        if dav(response, "status").is_some_and(|node| !status_ok(node.text().unwrap_or(""))) {
            return Err(invalid());
        }
        let mut properties = Vec::new();
        for propstat in response
            .children()
            .filter(|node| node.has_tag_name(("DAV:", "propstat")))
        {
            if dav(propstat, "status").is_some_and(|node| status_ok(node.text().unwrap_or(""))) {
                properties.push(dav(propstat, "prop").ok_or_else(invalid)?);
            }
        }
        if properties.is_empty() {
            return Err(invalid());
        }
        let find = |name| properties.iter().find_map(|property| dav(*property, name));
        let resource_type = find("resourcetype").ok_or_else(invalid)?;
        let collection = dav(resource_type, "collection").is_some();
        let size = find("getcontentlength")
            .map(|node| {
                node.text()
                    .unwrap_or("")
                    .parse::<u64>()
                    .map_err(|_| invalid())
            })
            .transpose()?;
        let etag = find("getetag")
            .and_then(|node| node.text())
            .map(str::to_owned);
        if etag.as_ref().is_some_and(|text| text.len() > 1024) {
            return Err(invalid());
        }
        if &path != requested {
            entries.push(Entry {
                path,
                collection,
                size,
                etag,
            });
        }
    }
    // A missing self entry or server continuation hints cannot authorize cleanup.
    if !seen.contains(requested) {
        continuation = true;
    }
    let completeness = match known_limit {
        // A documented response cap detects truncation; it does not prove a
        // particular account/server returned every entry. #306 must establish a
        // verified listing contract before enabling retention cleanup in #305.
        Some(limit) if count < limit && !continuation => Completeness::UnverifiedServer,
        Some(_) => Completeness::PossiblyTruncated,
        None => Completeness::UnverifiedServer,
    };
    Ok(Listing {
        entries,
        completeness,
    })
}
