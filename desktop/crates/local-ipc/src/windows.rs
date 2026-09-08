//! Named pipe transport.
//!
//! The pipe name carries the current user's SID so two users on one machine never
//! collide, and the pipe is created with a DACL naming only that SID. A DACL controls
//! who may connect to us; it cannot stop us connecting to someone else's pipe, so the
//! client additionally checks that the server process runs this same executable.

use std::ffi::c_void;
use std::io::{Read, Write};
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_SHARE_MODE,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::IpcError;

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const BUFFER_BYTES: u32 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    name: String,
}

impl Endpoint {
    /// A pipe lives in the kernel namespace rather than the filesystem, so the data
    /// directory cannot hold it. It is folded into the name instead: the SID keeps two
    /// users apart, and the directory digest keeps two archives apart, which matches how
    /// the Unix socket is scoped and lets separate data directories run side by side.
    pub fn for_data_root(data_root: &Path) -> Result<Self, IpcError> {
        use std::hash::{Hash, Hasher};
        let sid = current_user_sid()?;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        data_root.hash(&mut hasher);
        let digest = hasher.finish();
        Ok(Self {
            name: format!(r"\\.\pipe\resume-pro-{sid}-{digest:016x}"),
        })
    }

    pub fn display(&self) -> String {
        self.name.clone()
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error() -> u32 {
    // SAFETY: reads a thread-local error code, no pointers involved.
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

/// The current user's SID in string form, e.g. `S-1-5-21-…-1001`.
pub fn current_user_sid() -> Result<String, IpcError> {
    // SAFETY: the token handle is opened and closed here; GetTokenInformation is called
    // first for the size and then for the data, into a buffer of exactly that size.
    unsafe {
        let mut token: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io_error("OpenProcessToken"));
        }
        let mut needed = 0u32;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
        let mut buffer = vec![0u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            needed,
            &mut needed,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(io_error("GetTokenInformation"));
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut raw: *mut u16 = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut raw) == 0 {
            return Err(io_error("ConvertSidToStringSidW"));
        }
        let sid = from_wide(raw);
        LocalFree(raw as *mut c_void);
        Ok(sid)
    }
}

/// SAFETY: `raw` must be a NUL-terminated UTF-16 string owned by the caller.
unsafe fn from_wide(raw: *const u16) -> String {
    let mut len = 0usize;
    while *raw.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(raw, len))
}

fn io_error(context: &str) -> IpcError {
    IpcError::Io(std::io::Error::new(
        std::io::ErrorKind::Other,
        format!("{context} failed: {}", std::io::Error::last_os_error()),
    ))
}

/// A security descriptor granting all access to the current user and nobody else.
///
/// Built from SDDL rather than by assembling an ACL by hand: one string, far less to get
/// wrong, and the resulting descriptor is what the test reads back.
fn owner_only_descriptor() -> Result<(PSECURITY_DESCRIPTOR, String), IpcError> {
    let sid = current_user_sid()?;
    let sddl = format!("D:(A;;GA;;;{sid})");
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: the SDDL string is NUL-terminated; the descriptor is freed by the caller.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(&sddl).as_ptr(),
            SDDL_REVISION_1 as u32,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io_error("ConvertStringSecurityDescriptorToSecurityDescriptorW"));
    }
    Ok((descriptor, sid))
}

pub struct Listener {
    endpoint: Endpoint,
    pending: HANDLE,
}

impl Listener {
    pub fn bind(endpoint: &Endpoint) -> Result<Self, IpcError> {
        let pending = create_instance(endpoint, true)?;
        Ok(Self {
            endpoint: endpoint.clone(),
            pending,
        })
    }

    pub fn accept(&mut self) -> Result<Stream, IpcError> {
        // SAFETY: `pending` is a pipe instance owned by this listener.
        let connected = unsafe { ConnectNamedPipe(self.pending, ptr::null_mut()) };
        if connected == 0 && last_error() != ERROR_PIPE_CONNECTED {
            return Err(io_error("ConnectNamedPipe"));
        }
        // A pipe instance serves one client, so hand this one over and stand up the next.
        let served = self.pending;
        self.pending = create_instance(&self.endpoint, false)?;
        Ok(Stream { handle: served })
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        // SAFETY: closing a handle this listener owns.
        unsafe { CloseHandle(self.pending) };
    }
}

fn create_instance(endpoint: &Endpoint, first: bool) -> Result<HANDLE, IpcError> {
    let (descriptor, _sid) = owner_only_descriptor()?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // FILE_FLAG_FIRST_PIPE_INSTANCE makes creation fail when the name is already taken,
    // so a squatted name is reported rather than silently joined.
    let mut mode = PIPE_ACCESS_DUPLEX;
    if first {
        mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    // SAFETY: the name is NUL-terminated and the attributes outlive the call.
    let handle = unsafe {
        CreateNamedPipeW(
            wide(&endpoint.name).as_ptr(),
            mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER_BYTES,
            BUFFER_BYTES,
            0,
            &mut attributes,
        )
    };
    // SAFETY: freeing the descriptor allocated by the SDDL conversion.
    unsafe { LocalFree(descriptor as *mut c_void) };
    if handle == INVALID_HANDLE_VALUE {
        let code = last_error();
        // ERROR_ACCESS_DENIED (5) and ERROR_PIPE_BUSY both mean the name is taken.
        if code == 5 || code == ERROR_PIPE_BUSY {
            return Err(IpcError::AlreadyListening);
        }
        return Err(io_error("CreateNamedPipeW"));
    }
    Ok(handle)
}

pub struct Stream {
    handle: HANDLE,
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: closing a handle this stream owns.
        unsafe { CloseHandle(self.handle) };
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut read = 0u32;
        // SAFETY: `buf` is valid for `buf.len()` bytes.
        let ok = unsafe {
            ReadFile(
                self.handle,
                buf.as_mut_ptr(),
                buf.len() as u32,
                &mut read,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            // A peer that closed its end reads as end of stream, not an error.
            let code = last_error();
            if code == 109 || code == 233 {
                return Ok(0);
            }
            return Err(std::io::Error::last_os_error());
        }
        Ok(read as usize)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut written = 0u32;
        // SAFETY: `buf` is valid for `buf.len()` bytes.
        let ok = unsafe {
            WriteFile(
                self.handle,
                buf.as_ptr(),
                buf.len() as u32,
                &mut written,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(written as usize)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn connect(endpoint: &Endpoint) -> Result<Stream, IpcError> {
    // SAFETY: the name is NUL-terminated; the handle is owned by the returned Stream.
    let handle = unsafe {
        CreateFileW(
            wide(&endpoint.name).as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_MODE::default(),
            ptr::null_mut(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let code = last_error();
        if code == ERROR_FILE_NOT_FOUND || code == ERROR_PIPE_BUSY {
            return Err(IpcError::NotRunning);
        }
        return Err(io_error("CreateFileW"));
    }
    let stream = Stream { handle };
    verify_server(&stream)?;
    Ok(stream)
}

/// Check the pipe was created by this same executable.
///
/// Partial by design: a copy of the binary at the same path would pass. A complete check
/// compares the server process's user SID and is left to a later slice; the D06 local IPC
/// spec states this limit rather than claiming the risk is closed.
fn verify_server(stream: &Stream) -> Result<(), IpcError> {
    let mut pid = 0u32;
    // SAFETY: the handle is a connected pipe owned by `stream`.
    if unsafe { GetNamedPipeServerProcessId(stream.handle, &mut pid) } == 0 {
        return Err(IpcError::UntrustedServer {
            reason: "cannot identify the listening process".into(),
        });
    }
    // SAFETY: the process handle is closed before returning.
    let image = unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return Err(IpcError::UntrustedServer {
                reason: format!("cannot open the listening process {pid}"),
            });
        }
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len);
        CloseHandle(process);
        if ok == 0 {
            return Err(IpcError::UntrustedServer {
                reason: format!("cannot read the image path of process {pid}"),
            });
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    };
    let ours = std::env::current_exe()
        .map_err(IpcError::Io)?
        .to_string_lossy()
        .into_owned();
    if !image.eq_ignore_ascii_case(&ours) {
        return Err(IpcError::UntrustedServer {
            reason: format!("listening process runs {image}, not {ours}"),
        });
    }
    Ok(())
}

/// The SIDs the pipe's DACL grants access to, in literal `S-1-…` form.
///
/// Test support. Walks the ACEs rather than reading the SDDL text: SDDL abbreviates
/// well-known accounts, so a pipe owned by the local administrator reads back as `LA`
/// rather than that account's SID, and a text comparison would fail on a correct DACL.
#[cfg(test)]
pub fn granted_sids(endpoint: &Endpoint) -> Result<Vec<String>, IpcError> {
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
    use windows_sys::Win32::Security::{GetAce, ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION};
    use windows_sys::Win32::Storage::FileSystem::READ_CONTROL;

    // SAFETY: opens the pipe for READ_CONTROL, reads its DACL, walks the ACEs, and frees
    // the descriptor. Every pointer comes from the call immediately above it.
    unsafe {
        let handle = CreateFileW(
            wide(&endpoint.name).as_ptr(),
            READ_CONTROL,
            FILE_SHARE_MODE::default(),
            ptr::null_mut(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(io_error("CreateFileW for READ_CONTROL"));
        }
        let mut dacl: *mut ACL = ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let status = GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        );
        CloseHandle(handle);
        if status != 0 {
            return Err(io_error("GetSecurityInfo"));
        }
        let mut sids = Vec::new();
        if !dacl.is_null() {
            for index in 0..(*dacl).AceCount {
                let mut ace: *mut c_void = ptr::null_mut();
                if GetAce(dacl, index as u32, &mut ace) == 0 {
                    LocalFree(descriptor as *mut c_void);
                    return Err(io_error("GetAce"));
                }
                let allowed = ace as *const ACCESS_ALLOWED_ACE;
                let sid = std::ptr::addr_of!((*allowed).SidStart) as *const c_void;
                let mut raw: *mut u16 = ptr::null_mut();
                if ConvertSidToStringSidW(sid as *mut c_void, &mut raw) != 0 {
                    sids.push(from_wide(raw));
                    LocalFree(raw as *mut c_void);
                }
            }
        }
        LocalFree(descriptor as *mut c_void);
        Ok(sids)
    }
}
