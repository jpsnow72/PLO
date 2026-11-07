//! CLI binary `solve-turn`: reads a turn spot as JSON (from a file path argument or
//! `stdin`), solves the two-street turn+river game using Discounted CFR, measures exact
//! best-response exploitability via the turn checker in `br.rs`, and writes the strategy
//! + measured exploitability as JSON.

use std::env;
use std::fs;
use std::io::{self, Read};
use std::process;

use plo_solve::{format_turn_solve_result_json, parse_turn_spot_json, solve_turn, TurnGame};

fn main() {
    if let Err(err) = run() {
        eprintln!("solve-turn error: {err}");
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
                    "Usage: solve-turn [SPOT_JSON_PATH] [--input PATH] [--output PATH]\n\
                     If no input path is given, reads spot JSON from stdin and writes solution JSON to stdout."
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

    let (spot, dcfr_config) = parse_turn_spot_json(&raw_json)?;
    let game = TurnGame::new(spot)?;
    let result = solve_turn(&game, &dcfr_config);
    let out_json = format_turn_solve_result_json(&game, &result);

    match output_path {
        Some(path) => fs::write(path, out_json)?,
        None => print!("{out_json}"),
    }

    Ok(())
}
