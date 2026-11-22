//! CLI for selecting a river game from the input JSON `game` field.

use std::env;
use std::fs;
use std::io::{self, Read};
use std::process;

use plo_solve::{
    format_holdem_solve_result_json, format_solve_result_json, parse_holdem_spot_json,
    parse_spot_json, solve_holdem_river, solve_river, HoldemGame, JsonValue, RiverGame,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("solve error: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut input_path = None;
    let mut output_path = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "-h" | "--help" => {
                println!(
                    "Usage: solve [SPOT_JSON_PATH] [--input PATH] [--output PATH]\n\
                     Selects Hold'em with `\"game\":\"holdem\"`; otherwise uses PLO."
                );
                return Ok(());
            }
            "-i" | "--input" => {
                index += 1;
                input_path = Some(args.get(index).ok_or("missing value for --input")?.clone());
            }
            "-o" | "--output" => {
                index += 1;
                output_path = Some(args.get(index).ok_or("missing value for --output")?.clone());
            }
            arg if input_path.is_none() => input_path = Some(arg.to_string()),
            arg if output_path.is_none() => output_path = Some(arg.to_string()),
            arg => return Err(format!("unexpected argument: {arg}").into()),
        }
        index += 1;
    }

    let input = match input_path {
        Some(path) => fs::read_to_string(path)?,
        None => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input)?;
            input
        }
    };
    let game_type = JsonValue::parse(&input)?
        .get("game")
        .and_then(JsonValue::as_str)
        .unwrap_or("plo")
        .to_ascii_lowercase();
    let output = match game_type.as_str() {
        "holdem" | "hold'em" | "nlhe" => {
            let (spot, config) = parse_holdem_spot_json(&input)?;
            let game = HoldemGame::new(spot)?;
            format_holdem_solve_result_json(&game, &solve_holdem_river(&game, &config))
        }
        "plo" | "omaha" => {
            let (spot, config) = parse_spot_json(&input)?;
            let game = RiverGame::new(spot)?;
            format_solve_result_json(&game, &solve_river(&game, &config))
        }
        other => return Err(format!("unsupported river game: {other}").into()),
    };
    match output_path {
        Some(path) => fs::write(path, output)?,
        None => print!("{output}"),
    }
    Ok(())
}
