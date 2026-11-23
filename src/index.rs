//! The files under a folder, searched with fff (the engine of fff.nvim).

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use fff_search::file_picker::FilePicker;
use fff_search::frecency::FrecencyTracker;
use fff_search::git::{format_git_status_opt, is_modified_status};
use fff_search::{
    FFFMode, FilePickerOptions, FuzzySearchOptions, PaginationArgs, QueryParser,
    SharedFilePicker, SharedFrecency,
};
use serde::Serialize;

/// How many results a search returns.
const SHOWN: usize = 100;
/// How many results the changed-files search filters down to `SHOWN`.
const CHANGED_POOL: usize = 20_000;

#[derive(Serialize)]
pub struct Hit {
    /// Relative to the index's root.
    pub path: String,
    /// Character ranges `[start, end)` of `path` the query matched.
    pub highlights: Vec<(usize, usize)>,
    /// "modified", "untracked", "staged_new", ... or null when clean.
    pub status: Option<&'static str>,
}

#[derive(Serialize)]
pub struct Results {
    pub root: PathBuf,
    /// False while the first scan runs: the hits are what is found so far.
    pub ready: bool,
    pub hits: Vec<Hit>,
}

pub struct Index {
    shared: SharedFilePicker,
    root: PathBuf,
}

impl Index {
    /// Starts indexing `root` in the background and watches it for changes.
    pub fn open(root: &Path, frecency: SharedFrecency) -> Result<Self> {
        let shared = SharedFilePicker::default();
        FilePicker::new_with_shared_state(
            shared.clone(),
            frecency,
            FilePickerOptions {
                base_path: root.to_string_lossy().into_owned(),
                mode: FFFMode::Neovim,
                watch: true,
                ..Default::default()
            },
        )
        .map_err(|e| anyhow::anyhow!("{e}"))
        .with_context(|| format!("cannot index {}", root.display()))?;
        Ok(Self {
            shared,
            root: root.to_path_buf(),
        })
    }

    /// The best matches for `query`: every file, or with `changed` only the
    /// ones git reports as modified, added or untracked.
    pub fn search(&self, query: &str, changed: bool) -> Results {
        let ready = self.shared.wait_for_scan(Duration::ZERO);
        let mut results = Results {
            root: self.root.clone(),
            ready,
            hits: Vec::new(),
        };
        let Ok(guard) = self.shared.read() else {
            return results;
        };
        let Some(picker) = guard.as_ref() else {
            return results;
        };
        let parsed = QueryParser::default().parse(query);
        let found = picker.fuzzy_search(
            &parsed,
            None,
            FuzzySearchOptions {
                max_threads: 0,
                current_file: None,
                pagination: PaginationArgs {
                    offset: 0,
                    limit: if changed { CHANGED_POOL } else { SHOWN },
                },
                ..Default::default()
            },
        );
        results.hits = found
            .items
            .iter()
            .zip(found.match_byte_offsets.iter())
            .filter(|(item, _)| !changed || item.git_status.is_some_and(is_modified_status))
            .take(SHOWN)
            .map(|(item, offsets)| {
                let path = item.relative_path(picker);
                let highlights = offsets
                    .iter()
                    .filter_map(|&(start, end)| char_range(&path, start as usize, end as usize))
                    .collect();
                Hit {
                    highlights,
                    status: item
                        .git_status
                        .and_then(|status| format_git_status_opt(Some(status)))
                        .filter(|status| *status != "clean"),
                    path,
                }
            })
            .collect();
        results
    }
}

/// A byte range of `s` as a character range, for the mod's JavaScript.
fn char_range(s: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    let end = end.min(s.len());
    if start >= end || !s.is_char_boundary(start) || !s.is_char_boundary(end) {
        return None;
    }
    let from = s[..start].chars().count();
    Some((from, from + s[start..end].chars().count()))
}

/// fff.nvim's frecency database, copied so the files you open most in nvim
/// rank first here too, without taking nvim's lock on it. The copy lives in
/// `$XDG_CACHE_HOME/herdr-fff/frecency` and is made afresh on each start.
pub fn open_frecency_copy() -> Option<FrecencyTracker> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let cache = std::env::var_os("XDG_CACHE_HOME").map_or_else(|| home.join(".cache"), PathBuf::from);
    let source = cache.join("nvim/fff_nvim");
    if !source.is_dir() {
        return None;
    }
    let copy = cache.join("herdr-fff/frecency");
    let _ = std::fs::remove_dir_all(&copy);
    copy_files(&source, &copy).ok()?;
    FrecencyTracker::open(&copy).ok()
}

fn copy_files(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            std::fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}
