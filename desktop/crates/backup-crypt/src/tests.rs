use super::*;
use sha2::{Digest, Sha256};
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

fn secret() -> SecretString {
    SecretString::from("  synthetic 密码  ".to_owned())
}
fn encrypt(dir: &Path, bytes: &[u8]) -> std::path::PathBuf {
    let input = dir.join("input.rpbak");
    let output = dir.join("output.rpbak.age");
    fs::write(&input, bytes).unwrap();
    encrypt_with_factor(&input, &output, secret(), Limits::default(), &|| false, 10).unwrap();
    output
}
fn no_partial(dir: &Path) {
    assert!(!fs::read_dir(dir).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".resumepro-crypt-")));
}

#[test]
fn empty_chunk_boundaries_and_streamed_payload_interoperate_with_age() {
    for size in [0, 1, 65535, 65536, 65537, 2 * 1024 * 1024] {
        let dir = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = (0..size).map(|n| (n % 251) as u8).collect();
        let encrypted = encrypt(dir.path(), &bytes);
        let output = dir.path().join("restored.rpbak");
        assert_eq!(
            decrypt_file(&encrypted, &output, secret(), Limits::default(), &|| false).unwrap(),
            size as u64
        );
        assert_eq!(fs::read(output).unwrap(), bytes);
        // Read our output directly through the protocol implementation, bypassing
        // this adapter's header parser and publication code.
        let decryptor = age::Decryptor::new(fs::File::open(encrypted).unwrap()).unwrap();
        let identity = age::scrypt::Identity::new(secret());
        let mut plaintext = decryptor
            .decrypt(std::iter::once(&identity as &dyn age::Identity))
            .unwrap();
        let mut decoded = Vec::new();
        plaintext.read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded, bytes);
        no_partial(dir.path());
    }
}

#[test]
fn official_age_testkit_scrypt_vector() {
    // Public age testkit vector, vendored with provenance in tests/fixtures/README.md.
    let fixture = include_bytes!("../tests/fixtures/scrypt");
    let start = fixture
        .windows(2)
        .position(|bytes| bytes == b"\n\n")
        .unwrap()
        + 2;
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("vector.age");
    let output = dir.path().join("plaintext");
    fs::write(&input, &fixture[start..]).unwrap();
    decrypt_file(
        &input,
        &output,
        SecretString::from("password".to_owned()),
        Limits::default(),
        &|| false,
    )
    .unwrap();
    let hash: String = Sha256::digest(fs::read(output).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(
        hash,
        "013f54400c82da08037759ada907a8b864e97de81c088a182062c4b5622fd2ab"
    );
}

#[test]
fn public_encryptor_uses_the_documented_factor_and_preserves_whitespace() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input");
    let encrypted = dir.path().join("encrypted");
    let output = dir.path().join("output");
    fs::write(&input, b"synthetic public API").unwrap();
    encrypt_file(&input, &encrypted, secret(), Limits::default(), &|| false).unwrap();
    assert!(fs::read(&encrypted)
        .unwrap()
        .windows(4)
        .any(|part| part == b" 18\n"));
    decrypt_file(&encrypted, &output, secret(), Limits::default(), &|| false).unwrap();
    assert_eq!(fs::read(output).unwrap(), b"synthetic public API");
}

#[test]
fn corrupt_truncated_reordered_concatenated_and_trailing_data_never_publish() {
    let dir = tempfile::tempdir().unwrap();
    let original = encrypt(dir.path(), &vec![42; 200_000]);
    let bytes = fs::read(original).unwrap();
    let mut tampered = bytes.clone();
    *tampered.last_mut().unwrap() ^= 1;
    let mut reordered = bytes.clone();
    let start = bytes.windows(4).position(|part| part == b"--- ").unwrap();
    let payload = start + bytes[start..].iter().position(|b| *b == b'\n').unwrap() + 1 + 16;
    let (first, second) = reordered[payload..].split_at_mut(65552);
    first.swap_with_slice(&mut second[..65552]);
    let mut concat = bytes.clone();
    concat.extend_from_slice(&bytes);
    let mut trailing = bytes.clone();
    trailing.push(0);
    for (n, bad) in [
        tampered,
        bytes[..bytes.len() - 1].to_vec(),
        bytes[..100].to_vec(),
        reordered,
        concat,
        trailing,
    ]
    .iter()
    .enumerate()
    {
        let input = dir.path().join(format!("bad-{n}.age"));
        let output = dir.path().join(format!("bad-{n}.rpbak"));
        fs::write(&input, bad).unwrap();
        assert!(decrypt_file(&input, &output, secret(), Limits::default(), &|| false).is_err());
        assert!(!output.exists());
        no_partial(dir.path());
    }
    let output = dir.path().join("wrong.rpbak");
    let input = dir.path().join("output.rpbak.age");
    assert_eq!(
        decrypt_file(
            &input,
            &output,
            SecretString::from("wrong".to_owned()),
            Limits::default(),
            &|| false
        ),
        Err(Error::InvalidCiphertext)
    );
    assert!(!output.exists());
}

#[test]
fn limits_hostile_headers_and_cancellation_preserve_existing_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let encrypted = encrypt(dir.path(), &vec![7; 150_000]);
    let output = dir.path().join("out");
    let small = Limits {
        max_output_bytes: 10,
        ..Limits::default()
    };
    assert_eq!(
        decrypt_file(&encrypted, &output, secret(), small, &|| false),
        Err(Error::Limit)
    );
    let small = Limits {
        max_input_bytes: 10,
        ..Limits::default()
    };
    assert_eq!(
        decrypt_file(&encrypted, &output, secret(), small, &|| false),
        Err(Error::Limit)
    );
    let small = Limits {
        max_work_factor: 9,
        ..Limits::default()
    };
    assert!(decrypt_file(&encrypted, &output, secret(), small, &|| false).is_err());
    let calls = AtomicUsize::new(0);
    assert_eq!(
        decrypt_file(&encrypted, &output, secret(), Limits::default(), &|| calls
            .fetch_add(1, Ordering::SeqCst)
            >= 3),
        Err(Error::Cancelled)
    );
    assert!(!output.exists());
    fs::write(&output, b"previous valid output").unwrap();
    assert!(decrypt_file(&encrypted, &output, secret(), Limits::default(), &|| false).is_err());
    assert_eq!(fs::read(&output).unwrap(), b"previous valid output");
    let input = dir.path().join("input.rpbak");
    assert!(
        encrypt_with_factor(&input, &output, secret(), Limits::default(), &|| false, 10).is_err()
    );
    assert_eq!(fs::read(&output).unwrap(), b"previous valid output");
    let hostile = dir.path().join("hostile.age");
    fs::write(
        &hostile,
        format!(
            "age-encryption.org/v1\n{}",
            "x".repeat(MAX_HEADER_BYTES + 1)
        ),
    )
    .unwrap();
    assert!(decrypt_file(
        &hostile,
        &dir.path().join("never"),
        secret(),
        Limits::default(),
        &|| false
    )
    .is_err());
    let mut kdf = fs::read(&encrypted).unwrap();
    let offset = kdf.windows(4).position(|part| part == b" 10\n").unwrap();
    kdf[offset + 1..offset + 3].copy_from_slice(b"63");
    fs::write(&hostile, kdf).unwrap();
    assert!(decrypt_file(
        &hostile,
        &dir.path().join("never"),
        secret(),
        Limits::default(),
        &|| false
    )
    .is_err());
    no_partial(dir.path());
}

#[test]
fn disk_failures_are_not_reported_as_authentication_failures_and_encrypted_caps_are_limits() {
    struct FullDisk;
    impl Write for FullDisk {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("synthetic disk failure"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    struct BrokenInput(io::ErrorKind);
    impl Read for BrokenInput {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(self.0, "synthetic read failure"))
        }
    }
    assert_eq!(
        copy_bounded(
            &mut Cursor::new(b"plaintext"),
            &mut FullDisk,
            100,
            &|| false,
            decrypted_read_error
        ),
        Err(Error::Io)
    );
    assert_eq!(
        copy_bounded(
            &mut BrokenInput(io::ErrorKind::PermissionDenied),
            &mut Vec::new(),
            100,
            &|| false,
            decrypted_read_error
        ),
        Err(Error::Io)
    );
    assert_eq!(
        copy_bounded(
            &mut BrokenInput(io::ErrorKind::InvalidData),
            &mut Vec::new(),
            100,
            &|| false,
            decrypted_read_error
        ),
        Err(Error::InvalidCiphertext)
    );
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input");
    fs::write(&input, vec![1; 100000]).unwrap();
    for cap in [1, 200, 1000] {
        let output = dir.path().join(format!("cap-{cap}"));
        assert_eq!(
            encrypt_with_factor(
                &input,
                &output,
                secret(),
                Limits {
                    max_output_bytes: cap,
                    ..Limits::default()
                },
                &|| false,
                10
            ),
            Err(Error::Limit)
        );
        assert!(!output.exists());
        no_partial(dir.path());
    }
}
