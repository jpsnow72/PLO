//! CLI binary `build-ranges`: builds the constructed preflop range sets
//! (method `constructed-equity-v1`) into `data/preflop/`.
//!
//! Modes:
//! * (default) generate: score all 16,432 canonical hand classes, build every
//!   RFI and vs_rfi set implied by the config targets, write
//!   `sets/<id>.json`, `class-table.json`, refresh `index.json` (foreign,
//!   non-constructed entries are preserved), and print the cross-check diff
//!   of every set's totals against the published targets.
//! * `--check`: read the already-emitted files back, validate each against
//!   the rangeset schema rules, recompute totals from the emitted hands, and
//!   print the same cross-check diff. Exit code 1 on any validation error or
//!   hard cross-check failure.
//!
//! The sets are CONSTRUCTED ranges (exact card features + seeded Monte Carlo
//! equities fitted to documented target frequencies). They are not solver
//! output and are never labelled GTO. All tunables live in
//! `data/preflop/ranges-config-v1.json`.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

use plo_solve::ranges::{
    check_doc_totals, class_table_json, cross_check, enumerate_classes, generate, index_entry_json,
    json_to_compact, parse_opener, set_totals, validate_rangeset, RangesConfig,
};
use plo_solve::JsonValue;

fn main() {
    if let Err(err) = run() {
        eprintln!("build-ranges error: {err}");
        process::exit(1);
    }
}

struct Args {
    config: Option<String>,
    data_dir: Option<String>,
    check: bool,
}

fn parse_args() -> Result<Args, Box<dyn std::error::Error>> {
    let argv: Vec<String> = env::args().skip(1).collect();
    let mut args = Args { config: None, data_dir: None, check: false };
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "-h" | "--help" => {
                println!(
                    "Usage: build-ranges [--config PATH] [--data-dir PATH] [--check]\n\
                     Defaults: --data-dir data/preflop, --config <data-dir>/ranges-config-v1.json\n\
                     Without --check, generates the constructed range sets and prints the cross-check.\n\
                     With --check, validates the emitted files and prints the cross-check only."
                );
                process::exit(0);
            }
            "--check" => args.check = true,
            "--config" => {
                i += 1;
                args.config = Some(argv.get(i).ok_or("missing value for --config")?.clone());
            }
            "--data-dir" => {
                i += 1;
                args.data_dir = Some(argv.get(i).ok_or("missing value for --data-dir")?.clone());
            }
            other => return Err(format!("unexpected argument: {other}").into()),
        }
        i += 1;
    }
    Ok(args)
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args()?;
    let data_dir = PathBuf::from(args.data_dir.clone().unwrap_or_else(|| "data/preflop".to_string()));
    let config_path = args
        .config
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("ranges-config-v1.json"));
    let config_text = fs::read_to_string(&config_path)
        .map_err(|e| format!("cannot read config {}: {e}", config_path.display()))?;
    let cfg = RangesConfig::from_json_text(&config_text)?;
    if args.check {
        let failures = run_check(&cfg, &data_dir)?;
        if failures > 0 {
            eprintln!("build-ranges --check: {failures} failure(s)");
            process::exit(1);
        }
        println!("build-ranges --check: all constructed sets valid and within cross-check tolerances");
        return Ok(());
    }
    run_generate(&cfg, &data_dir)
}

fn run_generate(cfg: &RangesConfig, data_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "build-ranges: method constructed-equity-v1, config {} (fnv1a64:{})",
        cfg.version, cfg.config_hash
    );
    println!(
        "Monte Carlo samples per class: vs random {}, vs reference {}, vs opener {} (seed {})",
        cfg.samples_vs_random, cfg.samples_vs_reference, cfg.samples_vs_opener, cfg.seed
    );
    let generation = generate(cfg)?;
    println!(
        "scored {} classes; built {} sets",
        generation.classes.len(),
        generation.sets.len()
    );
    let sets_dir = data_dir.join("sets");
    fs::create_dir_all(&sets_dir)?;
    for doc in &generation.sets {
        let path = sets_dir.join(format!("{}.json", doc.id));
        fs::write(&path, doc.to_json(cfg))?;
    }
    fs::write(data_dir.join("class-table.json"), class_table_json(cfg, &generation.classes))?;
    write_index(cfg, data_dir, &generation)?;
    // Cross-check the in-memory documents (round-tripped through JSON).
    let multiplicity: HashMap<String, u32> = generation
        .classes
        .iter()
        .map(|c| (c.class.key.clone(), c.class.multiplicity))
        .collect();
    let (lines, failures) = cross_check(cfg, &generation.sets, &multiplicity);
    for line in &lines {
        println!("{line}");
    }
    if failures > 0 {
        eprintln!("build-ranges: {failures} cross-check failure(s)");
        process::exit(1);
    }
    println!("build-ranges: wrote {} sets + class-table.json + index.json to {}", generation.sets.len(), data_dir.display());
    Ok(())
}

/// Rewrites index.json: constructed entries are regenerated from this run;
/// foreign entries (e.g. future transcribed charts) are preserved verbatim.
fn write_index(
    cfg: &RangesConfig,
    data_dir: &Path,
    generation: &plo_solve::ranges::Generation,
) -> Result<(), Box<dyn std::error::Error>> {
    let index_path = data_dir.join("index.json");
    let mut preserved: Vec<String> = Vec::new();
    if let Ok(text) = fs::read_to_string(&index_path) {
        if let Ok(parsed) = JsonValue::parse(&text) {
            if let Some(entries) = parsed.get("rangesets").and_then(|v| v.as_array()) {
                for entry in entries {
                    let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if !id.starts_with("constructed-v1-") {
                        preserved.push(json_to_compact(entry));
                    }
                }
            }
        }
    }
    let mut out = String::new();
    out.push_str("{\n  \"schema_version\": 1,\n  \"rangesets\": [");
    let mut first = true;
    for p in &preserved {
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str("\n");
        out.push_str(p);
    }
    for doc in &generation.sets {
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str("\n");
        out.push_str(&index_entry_json(doc, cfg));
    }
    out.push_str("\n  ]\n}\n");
    fs::write(&index_path, out)?;
    Ok(())
}

fn run_check(cfg: &RangesConfig, data_dir: &Path) -> Result<usize, Box<dyn std::error::Error>> {
    let classes = enumerate_classes();
    let multiplicity: HashMap<String, u32> = classes
        .iter()
        .map(|c| (c.key.clone(), c.multiplicity))
        .collect();
    let index_path = data_dir.join("index.json");
    let index_text = fs::read_to_string(&index_path)
        .map_err(|e| format!("cannot read {}: {e}", index_path.display()))?;
    let index = JsonValue::parse(&index_text)?;
    let entries = index
        .get("rangesets")
        .and_then(|v| v.as_array())
        .ok_or("index.json has no 'rangesets' array")?;
    let mut failures = 0usize;
    println!(
        "cross-check: emitted files vs published targets (tolerance for anchored defense: {:.1}pp)",
        cfg.cross_check_defense_tolerance * 100.0
    );
    for entry in entries {
        let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if !id.starts_with("constructed-v1-") {
            continue;
        }
        let rel = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let path = data_dir.join(rel);
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                println!("{id}: cannot read {}: {e}", path.display());
                failures += 1;
                continue;
            }
        };
        let doc = match JsonValue::parse(&text) {
            Ok(v) => v,
            Err(e) => {
                println!("{id}: JSON parse failed: {e}");
                failures += 1;
                continue;
            }
        };
        let errors = validate_rangeset(&doc);
        for e in &errors {
            println!("{id}: schema: {e}");
        }
        failures += errors.len();
        let totals = set_totals(&doc, &multiplicity);
        let table = doc.get("table_size").and_then(|v| v.as_str()).unwrap_or("");
        let position = doc.get("position").and_then(|v| v.as_str()).unwrap_or("");
        let context = doc.get("context").and_then(|v| v.as_str()).unwrap_or("");
        let detail = doc.get("context_detail").and_then(|v| v.as_str()).unwrap_or("");
        let opener = if context == "vs_rfi" { Some(parse_opener(detail)) } else { None };
        let (lines, f) = check_doc_totals(
            cfg,
            id,
            table,
            position,
            context,
            opener.as_deref(),
            &totals,
        );
        for line in &lines {
            println!("{line}");
        }
        failures += f;
    }
    if !data_dir.join("class-table.json").exists() {
        println!("warning: class-table.json missing in {}", data_dir.display());
    }
    Ok(failures)
}
