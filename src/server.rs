//! The search server behind `herdr-fff search`, on a Unix socket:
//! `$XDG_RUNTIME_DIR/herdr-fff.sock` (else in the temp folder).
//!
//! A client writes one JSON request line, `{"dir": DIR, "query": Q,
//! "changed": bool}`, and reads one JSON line back: the results
//! (index.rs) or `{"error": "..."}`. A search runs in the repository holding
//! DIR (the folder with `.git`), or in DIR itself outside one. Each
//! repository is indexed once, in the background, and watched afterwards,
//! so searches after the first answer from memory. Until the first scan is
//! done a search says `"ready": false` with what was found so far.
//!
//! The first `herdr-fff search` starts the server; it ends after an hour
//! without a search.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use fff_search::SharedFrecency;
use serde::Deserialize;
use serde_json::json;

use crate::index::{open_frecency_copy, Index};

/// Repositories kept indexed; the one searched longest ago goes first.
const KEPT: usize = 16;
const IDLE: Duration = Duration::from_secs(60 * 60);

pub fn socket_path() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map_or_else(std::env::temp_dir, PathBuf::from)
        .join("herdr-fff.sock")
}

#[derive(Deserialize)]
pub struct Request {
    pub dir: PathBuf,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub changed: bool,
}

/// The repository holding `dir`, or `dir` outside one.
pub fn root_of(dir: &Path) -> Result<PathBuf> {
    let dir = dir
        .canonicalize()
        .with_context(|| format!("no folder {}", dir.display()))?;
    let root = dir
        .ancestors()
        .find(|d| d.join(".git").exists())
        .unwrap_or(&dir)
        .to_path_buf();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if root.parent().is_none() || Some(&root) == home.as_ref() {
        bail!("{} is too big to search: open a project folder", root.display());
    }
    Ok(root)
}

struct Indexes {
    frecency: SharedFrecency,
    open: HashMap<PathBuf, (Index, Instant)>,
}

impl Indexes {
    fn get(&mut self, root: &Path) -> Result<&Index> {
        if !self.open.contains_key(root) {
            if self.open.len() >= KEPT {
                let oldest = self
                    .open
                    .iter()
                    .min_by_key(|(_, (_, used))| *used)
                    .map(|(root, _)| root.clone());
                if let Some(oldest) = oldest {
                    self.open.remove(&oldest);
                }
            }
            let index = Index::open(root, self.frecency.clone())?;
            self.open.insert(root.to_path_buf(), (index, Instant::now()));
        }
        let (index, used) = self.open.get_mut(root).expect("inserted above");
        *used = Instant::now();
        Ok(index)
    }

    fn answer(&mut self, line: &str) -> Result<String> {
        let request: Request = serde_json::from_str(line).context("not a search request")?;
        let root = root_of(&request.dir)?;
        let results = self.get(&root)?.search(&request.query, request.changed);
        Ok(serde_json::to_string(&results)?)
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub fn serve() -> Result<()> {
    let path = socket_path();
    // One server at a time: two clients may start one each. The lock goes
    // with this process, so a dead server's socket file is ours to replace.
    let lock = std::fs::File::create(path.with_extension("lock"))?;
    if lock.try_lock().is_err() {
        bail!("a herdr-fff server already runs on {}", path.display());
    }
    let _ = std::fs::remove_file(&path);
    let listener =
        UnixListener::bind(&path).with_context(|| format!("cannot listen on {}", path.display()))?;

    let last = Arc::new(AtomicU64::new(now()));
    {
        let (last, path) = (last.clone(), path.clone());
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(60));
            if now().saturating_sub(last.load(Ordering::Relaxed)) >= IDLE.as_secs() {
                let _ = std::fs::remove_file(&path);
                std::process::exit(0);
            }
        });
    }

    let frecency = SharedFrecency::default();
    if let Some(tracker) = open_frecency_copy() {
        let _ = frecency.init(tracker);
    }
    let mut indexes = Indexes {
        frecency,
        open: HashMap::new(),
    };
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        last.store(now(), Ordering::Relaxed);
        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            continue;
        }
        let reply = indexes
            .answer(line.trim())
            .unwrap_or_else(|error| json!({ "error": format!("{error:#}") }).to_string());
        let _ = writeln!(stream, "{reply}");
    }
    Ok(())
}

/// Sends `request` to the server, starting one first when none answers.
pub fn ask(request: &serde_json::Value) -> Result<String> {
    let path = socket_path();
    let mut stream = match UnixStream::connect(&path) {
        Ok(stream) => stream,
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            start_server()?;
            wait_for(&path)?
        }
        Err(error) => return Err(error).with_context(|| format!("cannot reach {}", path.display())),
    };
    writeln!(stream, "{request}")?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply)?;
    Ok(reply.trim_end().to_owned())
}

/// `herdr-fff serve`, in a session of its own so it outlives this client.
fn start_server() -> Result<()> {
    let exe = std::env::current_exe().context("cannot find the herdr-fff binary")?;
    let mut command = Command::new(exe);
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches no memory of ours.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.spawn().context("cannot start the herdr-fff server")?;
    Ok(())
}

fn wait_for(path: &Path) -> Result<UnixStream> {
    let start = Instant::now();
    loop {
        match UnixStream::connect(path) {
            Ok(stream) => return Ok(stream),
            Err(_) if start.elapsed() < Duration::from_secs(5) => thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(error).context("the herdr-fff server did not start"),
        }
    }
}
