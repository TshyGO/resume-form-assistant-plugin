use super::*;
use std::collections::HashMap;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

#[derive(Debug)]
struct Request {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}
struct Reply {
    code: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    raw: Option<Vec<u8>>,
}
fn reply(code: u16, body: impl Into<Vec<u8>>) -> Reply {
    Reply {
        code,
        body: body.into(),
        headers: vec![],
        raw: None,
    }
}
fn header(mut response: Reply, name: &str, value: &str) -> Reply {
    response.headers.push((name.into(), value.into()));
    response
}

// A real HTTP socket fixture; each connection is closed so exact request counts
// and a half-written response are observable. No TLS bypass is public API.
async fn server(
    count: usize,
    mut respond: impl FnMut(Request) -> Reply + Send + 'static,
) -> (Client, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/dav/", listener.local_addr().unwrap());
    let client = Client::build(
        &endpoint,
        "synthetic".into(),
        SecretString::from("synthetic-password".to_owned()),
        true,
    )
    .unwrap();
    let task = tokio::spawn(async move {
        for _ in 0..count {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut data = Vec::new();
            let split = loop {
                let mut buffer = [0; 1024];
                let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer))
                    .await
                    .unwrap()
                    .unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buffer[..n]);
                if let Some(at) = data.windows(4).position(|part| part == b"\r\n\r\n") {
                    break at + 4;
                }
                assert!(data.len() < 65536);
            };
            let text = std::str::from_utf8(&data[..split]).unwrap();
            let mut lines = text.split("\r\n");
            let mut first = lines.next().unwrap().split_whitespace();
            let method = first.next().unwrap().to_owned();
            let target = first.next().unwrap().to_owned();
            let headers: HashMap<String, String> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
                .collect();
            let length = headers
                .get("content-length")
                .map(|value| value.parse::<usize>().unwrap())
                .unwrap_or(0);
            while data.len() < split + length {
                let mut buffer = [0; 4096];
                let n = stream.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buffer[..n]);
            }
            let response = respond(Request {
                method: method.clone(),
                target,
                headers,
                body: data[split..split + length].to_vec(),
            });
            let bytes = response.raw.unwrap_or_else(|| {
                let mut head = format!(
                    "HTTP/1.1 {} Fixture\r\nConnection: close\r\n",
                    response.code
                );
                if !response
                    .headers
                    .iter()
                    .any(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                {
                    head.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
                }
                for (key, value) in response.headers {
                    head.push_str(&format!("{key}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let mut bytes = head.into_bytes();
                if method != "HEAD" {
                    bytes.extend(response.body);
                }
                bytes
            });
            let _ = stream.write_all(&bytes).await;
        }
        // Mutations must not retry, redirects must not be followed.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    (client, task)
}
fn response(href: &str, collection: bool) -> String {
    format!(
        r#"<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype>{}</d:resourcetype><d:getcontentlength>11</d:getcontentlength><d:getetag>opaque</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:ignored/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>"#,
        if collection { "<d:collection/>" } else { "" }
    )
}
fn xml(contents: &str) -> Vec<u8> {
    format!(r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">{contents}</d:multistatus>"#)
        .into_bytes()
}

#[test]
fn https_and_path_scope_are_enforced() {
    for endpoint in [
        "http://example.invalid/dav/",
        "https://u:p@example.invalid/",
        "https://example.invalid/?q=x",
        "https://example.invalid/#frag",
    ] {
        assert!(Client::new(
            endpoint,
            "user".into(),
            SecretString::from("pass".to_owned())
        )
        .is_err());
    }
    let root = Url::parse(NUTSTORE_ENDPOINT).unwrap();
    let requested = RemotePath::new(&["backup"]).unwrap();
    assert!(path::response_path(&root, &RemotePath::root(), "/dav/backup/%2e%2e/a").is_err());
    for href in [
        "https://evil.invalid/dav/backup/a",
        "/dav-other/backup/a",
        "/dav/else/a",
        "/dav/backup/a/b",
        "/dav/backup/a%2Fb",
        "/dav/backup/%2e%2e/outside",
        "/dav/backup/a?query",
        "/dav/backup/a#fragment",
        "//u:p@dav.jianguoyun.com/dav/backup/a",
    ] {
        assert!(
            path::response_path(&root, &requested, href).is_err(),
            "{href}"
        );
    }
    for segment in ["..", ".", "a/b", "a\\b", "\n"] {
        assert!(RemotePath::new(&[segment]).is_err());
    }
    let chinese = RemotePath::new(&["中文 空格%#"]).unwrap();
    assert_eq!(
        path::response_path(
            &root,
            &RemotePath::root(),
            "/dav/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC%25%23"
        )
        .unwrap(),
        chinese
    );
}

#[test]
fn listing_completeness_xml_limits_and_untrusted_metadata() {
    let root = Url::parse(NUTSTORE_ENDPOINT).unwrap();
    let requested = RemotePath::root();
    let base = response("/dav/", true);
    let valid = xml(&(base.clone() + &response("/dav/a", false)));
    let listing = listing::parse(&root, &requested, &valid, Some(750)).unwrap();
    assert!(!listing.safe_for_cleanup());
    assert_eq!(listing.completeness, Completeness::UnverifiedServer);
    assert_eq!(listing.entries[0].size, Some(11));
    assert!(!listing::parse(&root, &requested, &valid, None)
        .unwrap()
        .safe_for_cleanup());
    assert!(!listing::parse(
        &root,
        &requested,
        &xml(&response("/dav/a", false)),
        Some(750)
    )
    .unwrap()
    .safe_for_cleanup());
    let mut many = base.clone();
    for n in 0..749 {
        many.push_str(&response(&format!("/dav/a{n}"), false));
    }
    assert_eq!(
        listing::parse(&root, &requested, &xml(&many), Some(750))
            .unwrap()
            .completeness,
        Completeness::PossiblyTruncated
    );
    assert!(!listing::parse(
        &root,
        &requested,
        &xml(&(base.clone() + "<next/>")),
        Some(750)
    )
    .unwrap()
    .safe_for_cleanup());
    for invalid in [
        xml(&(base.clone() + &response("/dav/", true))),
        xml(&response("https://evil.invalid/dav/a", false)),
        b"<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><x>&e;</x>".to_vec(),
        vec![b'x'; listing::MAX_XML_BYTES + 1],
    ] {
        assert!(listing::parse(&root, &requested, &invalid, Some(750)).is_err());
    }
}

#[tokio::test]
async fn methods_encoding_stream_lengths_and_safe_headers() {
    let mut step = 0;
    let (client, task) = server(7, move |request| {
        assert!(request.headers.contains_key("authorization"));
        assert!(!request.target.contains("synthetic-password"));
        let methods = [
            "MKCOL", "PUT", "PROPFIND", "PROPFIND", "GET", "MOVE", "DELETE",
        ];
        assert_eq!(request.method, methods[step]);
        step += 1;
        match request.method.as_str() {
            "MKCOL" => {
                assert!(request.target.ends_with("%E4%B8%AD%E6%96%87%20%25%23/"));
                reply(201, vec![])
            }
            "PUT" => {
                assert_eq!(request.headers["if-none-match"], "*");
                assert_eq!(request.headers["content-length"], "11");
                assert_eq!(request.body, b"synthetic-a");
                reply(201, vec![])
            }
            "PROPFIND" if request.headers["depth"] == "0" => {
                assert!(request.target.ends_with("%E4%B8%AD%E6%96%87%20%25%23"));
                reply(207, xml(&response(&request.target, false)))
            }
            "PROPFIND" => {
                assert_eq!(request.headers["depth"], "1");
                assert!(std::str::from_utf8(&request.body)
                    .unwrap()
                    .contains("propfind"));
                reply(207, xml(&response("/dav/", true)))
            }
            "GET" => reply(200, b"synthetic-a".to_vec()),
            "MOVE" => {
                assert_eq!(request.headers["overwrite"], "F");
                assert!(request.headers["destination"].ends_with("/dav/new"));
                reply(201, vec![])
            }
            _ => reply(204, vec![]),
        }
    })
    .await;
    let cancel = CancellationToken::new();
    let path = RemotePath::new(&["中文 %#"]).unwrap();
    client.mkcol(&path, &cancel).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("input");
    std::fs::write(&file, b"synthetic-a").unwrap();
    client
        .put_file_new(&path, &file, 100, &cancel)
        .await
        .unwrap();
    let info = client.stat(&path, &cancel).await.unwrap();
    assert_eq!(info.size, Some(11));
    assert_eq!(info.etag.as_deref(), Some("opaque"));
    assert!(!client
        .list(&RemotePath::root(), &cancel)
        .await
        .unwrap()
        .safe_for_cleanup());
    assert_eq!(
        client.get_bytes(&path, 64, &cancel).await.unwrap(),
        b"synthetic-a"
    );
    client
        .move_new(&path, &RemotePath::new(&["new"]).unwrap(), &cancel)
        .await
        .unwrap();
    client.delete(&path, &cancel).await.unwrap();
    task.await.unwrap();
}

// #316: Nutstore answers HEAD with `content-length: 0` and no ETag for a complete
// file. Object size must come from PROPFIND Depth:0, and HEAD is never sent.
#[tokio::test]
async fn object_size_comes_from_depth_zero_propfind_not_nutstore_head() {
    let path = RemotePath::new(&["resumetest", "b.rpbak.age"]).unwrap();
    let cancel = CancellationToken::new();
    let (client, task) = server(1, |request| match request.method.as_str() {
        "HEAD" => header(reply(200, vec![]), "Content-Length", "0"),
        "PROPFIND" => {
            assert_eq!(request.headers["depth"], "0");
            assert_eq!(request.target, "/dav/resumetest/b.rpbak.age");
            reply(
                207,
                xml(r#"<d:response><d:href>/dav/resumetest/b.rpbak.age</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>14300</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#),
            )
        }
        other => panic!("unexpected {other}"),
    })
    .await;
    let info = client.stat(&path, &cancel).await.unwrap();
    assert_eq!(info.size, Some(14300));
    assert_eq!(info.etag, None);
    task.await.unwrap();

    // No size property is "unknown", never a match; a missing object is NotFound;
    // a Depth:0 answer that omits the requested resource is not trusted.
    let (client, task) = server(1, |_| {
        reply(
            207,
            xml(r#"<d:response><d:href>/dav/resumetest/b.rpbak.age</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#),
        )
    })
    .await;
    assert_eq!(client.stat(&path, &cancel).await.unwrap().size, None);
    task.await.unwrap();
    let (client, task) = server(1, |_| reply(404, vec![])).await;
    assert_eq!(
        client.stat(&path, &cancel).await.unwrap_err().kind,
        ErrorKind::NotFound
    );
    task.await.unwrap();
    let (client, task) = server(1, |_| {
        reply(207, xml(&response("/dav/resumetest/other", false)))
    })
    .await;
    assert_eq!(
        client.stat(&path, &cancel).await.unwrap_err().kind,
        ErrorKind::InvalidResponse
    );
    task.await.unwrap();
}

#[tokio::test]
async fn status_mapping_retry_limits_and_unknown_mutation_outcomes() {
    let path = RemotePath::new(&["a"]).unwrap();
    let cancel = CancellationToken::new();
    for (code, kind) in [
        (401, ErrorKind::Authentication),
        (403, ErrorKind::Permission),
        (404, ErrorKind::NotFound),
        (409, ErrorKind::Conflict),
        (412, ErrorKind::Conflict),
        (413, ErrorKind::TooLarge),
        (507, ErrorKind::NoSpace),
        (302, ErrorKind::Redirect),
    ] {
        let (client, task) = server(1, move |_| {
            header(
                reply(code, b"private response synthetic-password".to_vec()),
                "Location",
                "https://evil.invalid/",
            )
        })
        .await;
        let error = client
            .put_bytes_new(&path, vec![1], &cancel)
            .await
            .unwrap_err();
        assert_eq!(error.kind, kind);
        assert!(!format!("{error:?} {error}").contains("synthetic-password"));
        task.await.unwrap();
    }
    let (client, task) = server(3, |_| header(reply(429, vec![]), "Retry-After", "0")).await;
    assert_eq!(
        client.stat(&path, &cancel).await.unwrap_err().kind,
        ErrorKind::RateLimited
    );
    task.await.unwrap();
    let (client, task) = server(1, |_| header(reply(429, vec![]), "Retry-After", "120")).await;
    assert_eq!(
        client.stat(&path, &cancel).await.unwrap_err().retry_after,
        Some(Duration::from_secs(120))
    );
    task.await.unwrap();
    let (client, task) = server(1, |_| Reply {
        raw: Some(vec![]),
        ..reply(200, vec![])
    })
    .await;
    let error = client
        .put_bytes_new(&path, vec![1], &cancel)
        .await
        .unwrap_err();
    assert!(error.outcome_unknown);
    assert_eq!(error.kind, ErrorKind::Network);
    task.await.unwrap();
    assert_eq!(parse_retry_after("12"), Some(Duration::from_secs(12)));
    let date = httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(30));
    assert!((29..=30).contains(&parse_retry_after(&date).unwrap().as_secs()));
}

#[tokio::test]
async fn bounded_downloads_never_publish_partial_or_replace_valid_outputs() {
    let path = RemotePath::new(&["a"]).unwrap();
    let cancel = CancellationToken::new();
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("output");
    let (client, task) = server(1, |_| reply(200, b"synthetic-a".to_vec())).await;
    let result = client
        .download_new(&path, &output, 64, &cancel)
        .await
        .unwrap();
    assert_eq!(result.bytes, 11);
    assert_eq!(
        result.sha256,
        <[u8; 32]>::from(Sha256::digest(b"synthetic-a"))
    );
    task.await.unwrap();
    let (client, task) = server(1, |_| reply(200, b"replacement".to_vec())).await;
    assert!(client
        .download_new(&path, &output, 64, &cancel)
        .await
        .is_err());
    task.await.unwrap();
    assert_eq!(std::fs::read(&output).unwrap(), b"synthetic-a");
    let incomplete = dir.path().join("incomplete");
    for raw in [b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\nConnection: close\r\n\r\nshort".to_vec(), b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nB\r\nsynthetic-a\r\n0\r\n\r\n".to_vec()] {
        let (client,task) = server(1,move |_| Reply {raw:Some(raw.clone()),..reply(200,vec![])}).await;
        assert!(client.download_new(&path,&incomplete,10,&cancel).await.is_err()); assert!(!incomplete.exists()); task.await.unwrap();
    }
    cancel.cancel();
    let client = Client::build(
        "http://127.0.0.1:1/dav/",
        "user".into(),
        SecretString::from("pass".to_owned()),
        true,
    )
    .unwrap();
    assert_eq!(
        client
            .download_new(&path, &incomplete, 64, &cancel)
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Cancelled
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn capability_probe_reports_move_and_conditional_write_semantics_and_scoped_cleanup() {
    for (supports_move, honours_conditions) in [(true, true), (false, true), (true, false)] {
        let mut files = HashMap::<String, Vec<u8>>::new();
        let mut folder = String::new();
        let count = if !supports_move {
            8
        } else if honours_conditions {
            13
        } else {
            11
        };
        let (client, task) = server(count, move |request| match request.method.as_str() {
            "MKCOL" => {
                folder = request.target.trim_end_matches('/').to_owned();
                assert!(folder.starts_with("/dav/resumepro-probe-"));
                reply(201, vec![])
            }
            "PUT" => {
                if honours_conditions && files.contains_key(&request.target) {
                    reply(412, vec![])
                } else {
                    files.insert(request.target, request.body);
                    reply(201, vec![])
                }
            }
            "PROPFIND" if request.headers["depth"] == "0" => {
                reply(207, xml(&response(&request.target, false)))
            }
            "GET" => reply(200, files[&request.target].clone()),
            "MOVE" if !supports_move => reply(405, vec![]),
            "MOVE" => {
                let destination = Url::parse(&request.headers["destination"])
                    .unwrap()
                    .path()
                    .to_owned();
                if honours_conditions && files.contains_key(&destination) {
                    reply(412, vec![])
                } else {
                    let bytes = files.remove(&request.target).unwrap();
                    files.insert(destination, bytes);
                    reply(201, vec![])
                }
            }
            "PROPFIND" => reply(207, xml(&response(&(folder.clone() + "/"), true))),
            "DELETE" => {
                assert_eq!(request.target, folder);
                files.clear();
                reply(204, vec![])
            }
            other => panic!("unexpected {other}"),
        })
        .await;
        let capabilities = client
            .probe_capabilities(
                &RemotePath::root(),
                uuid::Uuid::new_v4(),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(capabilities.create_only_put, honours_conditions);
        assert_eq!(
            capabilities.move_support,
            if supports_move {
                MoveSupport::Supported
            } else {
                MoveSupport::Unsupported
            }
        );
        assert_eq!(
            capabilities.move_no_overwrite,
            if supports_move {
                Some(honours_conditions)
            } else {
                None
            }
        );
        assert!(
            capabilities.length_matches
                && capabilities.etag_observed
                && capabilities.cleanup_complete
        );
        assert!(!capabilities.listing_complete);
        task.await.unwrap();
    }
}

#[tokio::test]
async fn timeout_after_sending_a_mutation_is_unknown_and_is_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut client = Client::build(
        &format!("http://{}/dav/", listener.local_addr().unwrap()),
        "user".into(),
        SecretString::from("pass".to_owned()),
        true,
    )
    .unwrap();
    client.http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(100))
        .build()
        .unwrap();
    client.control_timeout = Duration::from_millis(100);
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 4096];
        assert!(stream.read(&mut buffer).await.unwrap() > 0);
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    let error = client
        .delete(&RemotePath::new(&["a"]).unwrap(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Timeout);
    assert!(error.outcome_unknown);
    task.await.unwrap();
}

#[tokio::test]
async fn cancelling_a_partial_download_removes_the_temporary_file() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Client::build(
        &format!("http://{}/dav/", listener.local_addr().unwrap()),
        "user".into(),
        SecretString::from("pass".to_owned()),
        true,
    )
    .unwrap();
    let cancel = CancellationToken::new();
    let cancelling = cancel.clone();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 4096];
        stream.read(&mut buffer).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\npartial")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancelling.cancel();
        tokio::time::sleep(Duration::from_millis(20)).await;
    });
    let dir = tempfile::tempdir().unwrap();
    let error = client
        .download_new(
            &RemotePath::new(&["a"]).unwrap(),
            &dir.path().join("output"),
            100000,
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Cancelled);
    task.await.unwrap();
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn unexpected_success_status_on_a_read_does_not_claim_a_mutation() {
    let (client, task) = server(1, |_| reply(201, vec![])).await;
    let error = client
        .stat(&RemotePath::new(&["a"]).unwrap(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidResponse);
    assert!(!error.outcome_unknown);
    task.await.unwrap();
}

#[tokio::test]
async fn a_failed_capability_probe_still_deletes_its_owned_directory_once() {
    let mut step = 0;
    let mut folder = String::new();
    let (client, task) = server(3, move |request| {
        step += 1;
        match step {
            1 => {
                assert_eq!(request.method, "MKCOL");
                folder = request.target.trim_end_matches('/').to_owned();
                reply(201, vec![])
            }
            2 => {
                assert_eq!(request.method, "PUT");
                reply(403, vec![])
            }
            3 => {
                assert_eq!(request.method, "DELETE");
                assert_eq!(request.target, folder);
                reply(204, vec![])
            }
            _ => unreachable!(),
        }
    })
    .await;
    assert_eq!(
        client
            .probe_capabilities(
                &RemotePath::root(),
                uuid::Uuid::new_v4(),
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .kind,
        ErrorKind::Permission
    );
    task.await.unwrap();
}

#[test]
fn indented_listings_near_the_provider_boundary_remain_parseable_and_incomplete() {
    let mut contents = response("/dav/", true);
    for n in 0..749 {
        contents.push_str(&response(&format!("/dav/a{n}"), false));
    }
    let pretty = String::from_utf8(xml(&contents))
        .unwrap()
        .replace("><", ">\n  <");
    let listing = listing::parse(
        &Url::parse(NUTSTORE_ENDPOINT).unwrap(),
        &RemotePath::root(),
        pretty.as_bytes(),
        Some(750),
    )
    .unwrap();
    assert_eq!(listing.entries.len(), 749);
    assert_eq!(listing.completeness, Completeness::PossiblyTruncated);
}

#[tokio::test]
async fn a_progressing_file_transfer_can_outlast_the_control_request_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut client = Client::build(
        &format!("http://{}/dav/", listener.local_addr().unwrap()),
        "user".into(),
        SecretString::from("pass".to_owned()),
        true,
    )
    .unwrap();
    client.control_timeout = Duration::from_millis(100);
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        stream.read(&mut request).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(30)).await;
            stream.write_all(b"a").await.unwrap();
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let result = client
        .download_new(
            &RemotePath::new(&["a"]).unwrap(),
            &dir.path().join("out"),
            10,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.bytes, 10);
    task.await.unwrap();
    assert_eq!(transfer_timeout(500_000_000), Duration::from_secs(7690));
}
