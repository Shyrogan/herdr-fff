//! herdr-fff: fff's file search for the Herdr desktop app.
//!
//!   herdr-fff search [--changed] DIR [QUERY]
//!   herdr-fff serve
//!
//! `search` prints the best matches for QUERY among the files of the
//! repository holding DIR, as one line of JSON. It asks the server (see
//! server.rs), starting it on first use, so the index stays in memory
//! between searches. `serve` runs that server in the foreground.

mod index;
mod server;

use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use serde_json::json;

const USAGE: &str = "usage: herdr-fff search [--changed] DIR [QUERY]\n       herdr-fff serve";

fn search(args: &[String]) -> Result<()> {
    let changed = args.iter().any(|a| a == "--changed");
    let mut rest = args.iter().filter(|a| *a != "--changed");
    let dir = rest.next().context(USAGE)?;
    let query = rest.next().map_or("", String::as_str);
    if let Some(extra) = rest.next() {
        bail!("unexpected {extra}\n{USAGE}");
    }
    let dir = std::fs::canonicalize(dir).with_context(|| format!("no folder {dir}"))?;
    let reply = server::ask(&json!({ "dir": dir, "query": query, "changed": changed }))?;
    println!("{reply}");
    Ok(())
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("search") => search(&args[1..]),
        Some("serve") if args.len() == 1 => server::serve(),
        Some("-h" | "--help") => {
            println!("{USAGE}");
            Ok(())
        }
        _ => bail!("{USAGE}"),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("herdr-fff: {error:#}");
            ExitCode::FAILURE
        }
    }
}
