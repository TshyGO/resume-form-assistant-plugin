use crate::{CancellationToken, Client, Error, ErrorKind, RemotePath};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveSupport {
    Supported,
    Unsupported,
}

/// Observations from a disposable, caller-recorded UUID directory. None means a
/// capability was not observed, not that the server promises support.
#[derive(Debug, Clone)]
pub struct Capabilities {
    pub move_support: MoveSupport,
    pub create_only_put: bool,
    pub move_no_overwrite: Option<bool>,
    pub length_matches: bool,
    pub etag_observed: bool,
    pub listing_complete: bool,
    pub cleanup_complete: bool,
    pub probe_path: RemotePath,
}

impl Client {
    /// Caller records the random ID before starting so a failed/cancelled probe
    /// has a known cleanup location. Never uses real archive bytes or user files.
    pub async fn probe_capabilities(
        &self,
        parent: &RemotePath,
        probe_id: uuid::Uuid,
        cancel: &CancellationToken,
    ) -> Result<Capabilities, Error> {
        let folder = parent.child(&format!("resumepro-probe-{probe_id}"))?;
        self.mkcol(&folder, cancel).await?;
        let result = self.probe_inside(&folder, cancel).await;
        // Do not start more requests after cancellation. Only this newly-created
        // UUID directory is ever deleted, including on a failed probe.
        let cleaned = if cancel.is_cancelled() {
            false
        } else {
            self.delete(&folder, cancel).await.is_ok()
        };
        result.map(|mut capabilities| {
            capabilities.cleanup_complete = cleaned;
            capabilities
        })
    }

    async fn probe_inside(
        &self,
        folder: &RemotePath,
        cancel: &CancellationToken,
    ) -> Result<Capabilities, Error> {
        let source = folder.child("source.bin")?;
        let destination = folder.child("destination.bin")?;
        let blocker = folder.child("blocker.bin")?;
        self.put_bytes_new(&source, b"synthetic-a".to_vec(), cancel)
            .await?;
        let meta = self.stat(&source, cancel).await?;
        let create_only_put = match self
            .put_bytes_new(&source, b"synthetic-b".to_vec(), cancel)
            .await
        {
            Err(error) if error.status == Some(412) => true,
            Ok(()) => false,
            Err(error) => return Err(error),
        };
        let expected = if create_only_put {
            b"synthetic-a"
        } else {
            b"synthetic-b"
        };
        if self.get_bytes(&source, 64, cancel).await? != expected {
            return Err(Error::new(ErrorKind::InvalidResponse));
        }
        let (move_support, move_no_overwrite) = match self
            .move_new(&source, &destination, cancel)
            .await
        {
            Err(error) if error.kind == ErrorKind::Unsupported => (MoveSupport::Unsupported, None),
            Err(error) => return Err(error),
            Ok(()) => {
                if self.get_bytes(&destination, 64, cancel).await? != expected {
                    return Err(Error::new(ErrorKind::InvalidResponse));
                }
                self.put_bytes_new(&blocker, b"synthetic-c".to_vec(), cancel)
                    .await?;
                let protected = match self.move_new(&destination, &blocker, cancel).await {
                    Err(error) if error.status == Some(412) => {
                        self.get_bytes(&blocker, 64, cancel).await? == b"synthetic-c"
                            && self.get_bytes(&destination, 64, cancel).await? == expected
                    }
                    Ok(()) => false,
                    Err(error) => return Err(error),
                };
                (MoveSupport::Supported, Some(protected))
            }
        };
        let listing_complete = self.list(folder, cancel).await?.safe_for_cleanup();
        Ok(Capabilities {
            move_support,
            create_only_put,
            move_no_overwrite,
            length_matches: meta.size == Some(expected.len() as u64),
            etag_observed: meta.etag.is_some(),
            listing_complete,
            cleanup_complete: false,
            probe_path: folder.clone(),
        })
    }
}
