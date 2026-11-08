//! CLI binary `multiway-equity`: reads a multiway equity request as JSON (from a file path
//! argument or `stdin`), computes exact or deterministic Monte Carlo multiway equity via
//! `plo-eval`, and writes the JSON result to `stdout` (or an optional output file path).

use std::env;
use std::fs;
use std::io::{self, Read};
use std::process;

use plo_solve::{
    format_multiway_equity_result_json, parse_multiway_equity_request_json,
    run_multiway_equity_request,
};

fn main() {
    if let Err(err) = run() {
        eprintln!("multiway-equity error: {err}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut input_path: Option<String> = None;
    let mut output_path: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => {
                println!(
                    "Usage: multiway-equity [REQUEST_JSON_PATH] [OUTPUT_JSON_PATH] [--input PATH] [--output PATH]\n\
                     If no input path is given, reads request JSON from stdin and writes result JSON to stdout."
                );
                return Ok(());
            }
            "-i" | "--input" => {
                i += 1;
                if i >= args.len() {
                    return Err("missing value for --input".into());
                }
                input_path = Some(args[i].clone());
            }
            "-o" | "--output" => {
                i += 1;
                if i >= args.len() {
                    return Err("missing value for --output".into());
                }
                output_path = Some(args[i].clone());
            }
            arg => {
                if input_path.is_none() {
                    input_path = Some(arg.to_string());
                } else if output_path.is_none() {
                    output_path = Some(arg.to_string());
                } else {
                    return Err(format!("unexpected argument: {arg}").into());
                }
            }
        }
        i += 1;
    }

    let raw_json = match input_path {
        Some(path) => fs::read_to_string(path)?,
        None => {
            let mut buf = String::new();
            io::stdin().read_to_string(&mut buf)?;
            buf
        }
    };

    let req = parse_multiway_equity_request_json(&raw_json)?;
    let res = run_multiway_equity_request(&req)?;
    let out_json = format_multiway_equity_result_json(&req, &res);

    match output_path {
        Some(path) => fs::write(path, out_json)?,
        None => print!("{out_json}"),
    }

    Ok(())
}
