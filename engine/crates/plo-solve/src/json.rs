//! Zero-dependency JSON parser and serializer for `solve-river` spot inputs and strategy outputs.

use plo_cards::{format_cards, Card};
use plo_eval::{PloRange, WeightedCombo};

use crate::br::ExploitabilityReport;
use crate::cfr::{ComboEv, DcfrConfig, NodeStrategy, SolveResult};
use crate::flop::{expand_bucket_strategies, BucketConfig, FlopGame, FlopSolveResult, FlopSpot};
use crate::game::{Player, RiverGame, RiverSpot, SolveError, TreeConfig};
use crate::turn::{TurnGame, TurnSolveResult, TurnSpot};

/// Minimal recursive-descent JSON value representation (`std` only).
#[derive(Clone, Debug, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

impl JsonValue {
    /// Parses a [`JsonValue`] from a UTF-8 string.
    pub fn parse(input: &str) -> Result<Self, SolveError> {
        let mut parser = JsonParser {
            bytes: input.as_bytes(),
            pos: 0,
        };
        let val = parser.parse_value()?;
        parser.skip_ws();
        if parser.pos != parser.bytes.len() {
            return Err(SolveError::JsonError(format!(
                "unexpected trailing characters at byte {}",
                parser.pos
            )));
        }
        Ok(val)
    }

    /// Looks up a field by key if `self` is a `JsonValue::Object`.
    pub fn get(&self, key: &str) -> Option<&JsonValue> {
        match self {
            JsonValue::Object(entries) => entries
                .iter()
                .find_map(|(k, v)| if k == key { Some(v) } else { None }),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match *self {
            JsonValue::Number(n) => Some(n),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsonValue::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[JsonValue]> {
        match self {
            JsonValue::Array(arr) => Some(arr.as_slice()),
            _ => None,
        }
    }
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn parse_value(&mut self) -> Result<JsonValue, SolveError> {
        self.skip_ws();
        let b = self
            .peek()
            .ok_or_else(|| SolveError::JsonError("unexpected end of JSON input".to_string()))?;
        match b {
            b'"' => self.parse_string().map(JsonValue::String),
            b'{' => self.parse_object(),
            b'[' => self.parse_array(),
            b't' | b'f' => self.parse_bool(),
            b'n' => self.parse_null(),
            b'-' | b'0'..=b'9' => self.parse_number(),
            c => Err(SolveError::JsonError(format!(
                "unexpected character '{}' at byte {}",
                c as char, self.pos
            ))),
        }
    }

    fn parse_string(&mut self) -> Result<String, SolveError> {
        self.skip_ws();
        if self.peek() != Some(b'"') {
            return Err(SolveError::JsonError(format!(
                "expected '\"' at byte {}",
                self.pos
            )));
        }
        self.pos += 1;
        let mut out = String::new();
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            self.pos += 1;
            match b {
                b'"' => return Ok(out),
                b'\\' => {
                    if self.pos >= self.bytes.len() {
                        return Err(SolveError::JsonError(
                            "unterminated escape in JSON string".to_string(),
                        ));
                    }
                    let esc = self.bytes[self.pos];
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        _ => {
                            return Err(SolveError::JsonError(format!(
                                "unsupported escape '\\{}'",
                                esc as char
                            )))
                        }
                    }
                }
                c => out.push(c as char),
            }
        }
        Err(SolveError::JsonError(
            "unterminated JSON string".to_string(),
        ))
    }

    fn parse_object(&mut self) -> Result<JsonValue, SolveError> {
        self.pos += 1; // '{'
        self.skip_ws();
        let mut entries = Vec::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(JsonValue::Object(entries));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(SolveError::JsonError(format!(
                    "expected ':' after object key \"{key}\" at byte {}",
                    self.pos
                )));
            }
            self.pos += 1;
            let val = self.parse_value()?;
            entries.push((key, val));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => {
                    return Err(SolveError::JsonError(format!(
                        "expected ',' or '}}' in object at byte {}",
                        self.pos
                    )))
                }
            }
        }
        Ok(JsonValue::Object(entries))
    }

    fn parse_array(&mut self) -> Result<JsonValue, SolveError> {
        self.pos += 1; // '['
        self.skip_ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(JsonValue::Array(items));
        }
        loop {
            let val = self.parse_value()?;
            items.push(val);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                _ => {
                    return Err(SolveError::JsonError(format!(
                        "expected ',' or ']' in array at byte {}",
                        self.pos
                    )))
                }
            }
        }
        Ok(JsonValue::Array(items))
    }

    fn parse_bool(&mut self) -> Result<JsonValue, SolveError> {
        if self.bytes[self.pos..].starts_with(b"true") {
            self.pos += 4;
            Ok(JsonValue::Bool(true))
        } else if self.bytes[self.pos..].starts_with(b"false") {
            self.pos += 5;
            Ok(JsonValue::Bool(false))
        } else {
            Err(SolveError::JsonError(format!(
                "invalid boolean literal at byte {}",
                self.pos
            )))
        }
    }

    fn parse_null(&mut self) -> Result<JsonValue, SolveError> {
        if self.bytes[self.pos..].starts_with(b"null") {
            self.pos += 4;
            Ok(JsonValue::Null)
        } else {
            Err(SolveError::JsonError(format!(
                "invalid null literal at byte {}",
                self.pos
            )))
        }
    }

    fn parse_number(&mut self) -> Result<JsonValue, SolveError> {
        let start = self.pos;
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b.is_ascii_digit() || matches!(b, b'-' | b'+' | b'.' | b'e' | b'E') {
                self.pos += 1;
            } else {
                break;
            }
        }
        let s = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|e| SolveError::JsonError(e.to_string()))?;
        let n: f64 = s
            .parse()
            .map_err(|_| SolveError::JsonError(format!("invalid number \"{s}\"")))?;
        Ok(JsonValue::Number(n))
    }
}

/// Parses a river spot and solver configuration from a JSON string.
pub fn parse_spot_json(input: &str) -> Result<(RiverSpot, DcfrConfig), SolveError> {
    let root = JsonValue::parse(input)?;

    // 1. Parse 5-card board
    let board_val = root
        .get("board")
        .ok_or_else(|| SolveError::JsonError("missing required field \"board\"".to_string()))?;
    let board = parse_board_value(board_val)?;

    // 2. Parse OOP and IP ranges
    let (oop_val, ip_val) = if let (Some(o), Some(i)) = (
        root.get("oop_range").or_else(|| root.get("oop")),
        root.get("ip_range").or_else(|| root.get("ip")),
    ) {
        (o, i)
    } else if let Some(ranges_arr) = root.get("ranges").and_then(|v| v.as_array()) {
        if ranges_arr.len() != 2 {
            return Err(SolveError::JsonError(
                "\"ranges\" array must have exactly 2 elements [oop, ip]".to_string(),
            ));
        }
        (&ranges_arr[0], &ranges_arr[1])
    } else {
        return Err(SolveError::JsonError(
            "missing required range fields (\"oop_range\"/\"ip_range\" or \"oop\"/\"ip\")"
                .to_string(),
        ));
    };

    let oop_range = parse_range_value(oop_val)?;
    let ip_range = parse_range_value(ip_val)?;

    // 3. Parse pot and effective stack
    let starting_pot = root
        .get("pot")
        .or_else(|| root.get("starting_pot"))
        .and_then(|v| v.as_f64())
        .ok_or_else(|| {
            SolveError::JsonError("missing required numeric field \"pot\"".to_string())
        })?;

    let effective_stack = if let Some(s_val) = root
        .get("stacks")
        .or_else(|| root.get("effective_stack"))
        .or_else(|| root.get("stack"))
    {
        if let Some(n) = s_val.as_f64() {
            n
        } else if let Some(arr) = s_val.as_array() {
            if arr.is_empty() {
                return Err(SolveError::JsonError(
                    "\"stacks\" array cannot be empty".to_string(),
                ));
            }
            let mut min_s = f64::INFINITY;
            for item in arr {
                let n = item.as_f64().ok_or_else(|| {
                    SolveError::JsonError("\"stacks\" elements must be numbers".to_string())
                })?;
                if n < min_s {
                    min_s = n;
                }
            }
            min_s
        } else {
            return Err(SolveError::JsonError(
                "\"stacks\" must be a number or array of numbers".to_string(),
            ));
        }
    } else {
        return Err(SolveError::JsonError(
            "missing required field \"stacks\" (or \"effective_stack\" / \"stack\")".to_string(),
        ));
    };

    // 4. Optional tree configuration
    let mut tree_config = TreeConfig::default();
    if let Some(bs) = root.get("bet_sizes").and_then(|v| v.as_array()) {
        let mut sizes = Vec::with_capacity(bs.len());
        for item in bs {
            let n = item.as_f64().ok_or_else(|| {
                SolveError::JsonError("\"bet_sizes\" must contain numbers".to_string())
            })?;
            sizes.push(n);
        }
        tree_config.bet_sizes = sizes;
    }
    if let Some(rs) = root.get("raise_sizes").and_then(|v| v.as_array()) {
        let mut sizes = Vec::with_capacity(rs.len());
        for item in rs {
            let n = item.as_f64().ok_or_else(|| {
                SolveError::JsonError("\"raise_sizes\" must contain numbers".to_string())
            })?;
            sizes.push(n);
        }
        tree_config.raise_sizes = sizes;
    }
    if let Some(mr) = root.get("max_raises").and_then(|v| v.as_f64()) {
        tree_config.max_raises = mr.max(0.0) as usize;
    }

    // 5. Optional DCFR solver configuration
    let mut dcfr_config = DcfrConfig::default();
    if let Some(iters) = root
        .get("max_iterations")
        .or_else(|| root.get("iterations"))
        .and_then(|v| v.as_f64())
    {
        dcfr_config.max_iterations = (iters.max(1.0)) as usize;
    }
    if let Some(target) = root
        .get("target_exploitability_pct")
        .or_else(|| root.get("target_exploitability"))
        .and_then(|v| v.as_f64())
    {
        dcfr_config.target_exploitability_pct = target.max(0.0);
    }

    let spot = RiverSpot {
        board,
        oop_range,
        ip_range,
        starting_pot,
        effective_stack,
        tree_config,
    };

    Ok((spot, dcfr_config))
}

fn parse_board_value(val: &JsonValue) -> Result<[Card; 5], SolveError> {
    match val {
        JsonValue::String(s) => Ok(Card::parse_n::<5>(s)?),
        JsonValue::Array(arr) => {
            let mut joined = String::new();
            for item in arr {
                let s = item.as_str().ok_or_else(|| {
                    SolveError::JsonError("board array elements must be card strings".to_string())
                })?;
                if !joined.is_empty() {
                    joined.push(' ');
                }
                joined.push_str(s);
            }
            Ok(Card::parse_n::<5>(&joined)?)
        }
        _ => Err(SolveError::JsonError(
            "\"board\" must be a string or array of 5 card strings".to_string(),
        )),
    }
}

fn parse_range_value(val: &JsonValue) -> Result<PloRange, SolveError> {
    let mut range = PloRange::new();
    match val {
        JsonValue::String(s) => {
            for token in s.split(',') {
                let trimmed = token.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let (hand_str, weight) = parse_combo_colon_weight(trimmed)?;
                let cards = Card::parse_n::<4>(hand_str)?;
                range.push(cards, weight)?;
            }
        }
        JsonValue::Array(arr) => {
            for item in arr {
                match item {
                    JsonValue::String(s) => {
                        let (hand_str, weight) = parse_combo_colon_weight(s)?;
                        let cards = Card::parse_n::<4>(hand_str)?;
                        range.push(cards, weight)?;
                    }
                    JsonValue::Array(pair) if pair.len() == 2 => {
                        let hand_str = pair[0].as_str().ok_or_else(|| {
                            SolveError::JsonError(
                                "combo pair first element must be a string".to_string(),
                            )
                        })?;
                        let weight = pair[1].as_f64().ok_or_else(|| {
                            SolveError::JsonError(
                                "combo pair second element must be a number".to_string(),
                            )
                        })?;
                        let cards = Card::parse_n::<4>(hand_str)?;
                        range.push(cards, weight)?;
                    }
                    JsonValue::Object(_) => {
                        let hand_str = item
                            .get("combo")
                            .or_else(|| item.get("hand"))
                            .and_then(|v| v.as_str())
                            .ok_or_else(|| {
                                SolveError::JsonError(
                                    "range object must have \"combo\" or \"hand\" string"
                                        .to_string(),
                                )
                            })?;
                        let weight = item.get("weight").and_then(|v| v.as_f64()).unwrap_or(1.0);
                        let cards = Card::parse_n::<4>(hand_str)?;
                        range.push(cards, weight)?;
                    }
                    _ => {
                        return Err(SolveError::JsonError(
                            "unsupported range array element format".to_string(),
                        ))
                    }
                }
            }
        }
        JsonValue::Object(entries) => {
            for (k, v) in entries {
                let weight = v.as_f64().ok_or_else(|| {
                    SolveError::JsonError(format!("weight for combo \"{k}\" must be a number"))
                })?;
                let cards = Card::parse_n::<4>(k)?;
                range.push(cards, weight)?;
            }
        }
        _ => {
            return Err(SolveError::JsonError(
                "range must be a string, array, or object".to_string(),
            ))
        }
    }
    if range.is_empty() {
        return Err(SolveError::Equity(plo_eval::EquityError::EmptyRange));
    }
    Ok(range)
}

fn parse_combo_colon_weight(s: &str) -> Result<(&str, f64), SolveError> {
    if let Some((hand, w_str)) = s.split_once(':') {
        let w: f64 = w_str.trim().parse().map_err(|_| {
            SolveError::JsonError(format!("invalid weight in combo spec \"{s}\""))
        })?;
        Ok((hand.trim(), w))
    } else {
        Ok((s.trim(), 1.0))
    }
}

/// Serializes a solved river spot and its independent exploitability report into formatted JSON.
pub fn format_solve_result_json(game: &RiverGame, result: &SolveResult) -> String {
    let mut out = String::with_capacity(16384);
    out.push_str("{\n");
    out.push_str(&format!(
        "  \"board\": \"{}\",\n",
        format_cards(&game.board)
    ));
    out.push_str(&format!("  \"starting_pot\": {:.6},\n", game.starting_pot));
    out.push_str(&format!(
        "  \"effective_stack\": {:.6},\n",
        game.effective_stack
    ));
    out.push_str(&format!("  \"iterations\": {},\n", result.iterations));

    // Exploitability object
    let ex = &result.exploitability;
    out.push_str("  \"exploitability\": {\n");
    out.push_str(&format!(
        "    \"nash_distance_pct\": {:.6},\n",
        ex.nash_distance_pct
    ));
    out.push_str(&format!(
        "    \"nash_distance_chips\": {:.6},\n",
        ex.nash_distance_chips
    ));
    out.push_str(&format!(
        "    \"mean_exploitability_pct\": {:.6},\n",
        ex.mean_exploitability_pct
    ));
    out.push_str(&format!(
        "    \"mean_exploitability_chips\": {:.6},\n",
        ex.mean_exploitability_chips
    ));
    out.push_str(&format!(
        "    \"oop_exploitability_chips\": {:.6},\n",
        ex.oop_exploitability_chips
    ));
    out.push_str(&format!(
        "    \"ip_exploitability_chips\": {:.6},\n",
        ex.ip_exploitability_chips
    ));
    out.push_str(&format!("    \"oop_br_ev\": {:.6},\n", ex.oop_br_ev));
    out.push_str(&format!("    \"ip_br_ev\": {:.6},\n", ex.ip_br_ev));
    out.push_str(&format!(
        "    \"oop_strategy_ev\": {:.6},\n",
        ex.oop_strategy_ev
    ));
    out.push_str(&format!(
        "    \"ip_strategy_ev\": {:.6}\n",
        ex.ip_strategy_ev
    ));
    out.push_str("  },\n");

    // Per-combo EVs
    out.push_str("  \"oop_evs\": [\n");
    for (i, ce) in result.oop_evs.iter().enumerate() {
        let comma = if i + 1 < result.oop_evs.len() {
            ","
        } else {
            ""
        };
        out.push_str(&format!(
            "    {{\"combo\": \"{}\", \"weight\": {:.6}, \"ev\": {:.6}}}{}\n",
            format_cards(&ce.combo.cards),
            ce.combo.weight,
            ce.ev,
            comma
        ));
    }
    out.push_str("  ],\n");

    out.push_str("  \"ip_evs\": [\n");
    for (i, ce) in result.ip_evs.iter().enumerate() {
        let comma = if i + 1 < result.ip_evs.len() { "," } else { "" };
        out.push_str(&format!(
            "    {{\"combo\": \"{}\", \"weight\": {:.6}, \"ev\": {:.6}}}{}\n",
            format_cards(&ce.combo.cards),
            ce.combo.weight,
            ce.ev,
            comma
        ));
    }
    out.push_str("  ],\n");

    // Decision nodes and per-combo strategies
    out.push_str("  \"nodes\": [\n");
    for (d_idx, ns) in result.strategies.iter().enumerate() {
        let d = game.decision_node(ns.decision_id);
        let combos = game.player_combos(ns.player);
        out.push_str("    {\n");
        out.push_str(&format!("      \"decision_id\": {},\n", ns.decision_id));
        out.push_str(&format!("      \"node_id\": {},\n", ns.node_id));
        out.push_str(&format!("      \"player\": \"{}\",\n", ns.player));
        out.push_str(&format!("      \"history\": \"{}\",\n", ns.history));
        out.push_str(&format!("      \"pot\": {:.6},\n", d.current_pot));
        out.push_str(&format!("      \"to_call\": {:.6},\n", d.to_call));

        out.push_str("      \"actions\": [");
        for (a_idx, act) in ns.actions.iter().enumerate() {
            if a_idx > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!("\"{}\"", act.label()));
        }
        out.push_str("],\n");

        out.push_str("      \"strategy\": {\n");
        for (c_idx, combo) in combos.iter().enumerate() {
            let c_comma = if c_idx + 1 < combos.len() { "," } else { "" };
            let freqs = ns.combo_strategy(c_idx);
            out.push_str(&format!("        \"{}\": [", format_cards(&combo.cards)));
            for (a_idx, &f) in freqs.iter().enumerate() {
                if a_idx > 0 {
                    out.push_str(", ");
                }
                out.push_str(&format!("{:.6}", f));
            }
            out.push_str(&format!("]{}\n", c_comma));
        }
        out.push_str("      }\n");

        let n_comma = if d_idx + 1 < result.strategies.len() {
            ","
        } else {
            ""
        };
        out.push_str(&format!("    }}{}\n", n_comma));
    }
    out.push_str("  ]\n");
    out.push_str("}\n");
    out
}

// ============================================================================
// Turn spots (Ticket E3): JSON parsing/serialization for `solve-turn`.
// Input mirrors the river format, with a 4-card `board` and per-street tree
// fields: `turn_bet_sizes`, `river_bet_sizes`, `turn_raise_sizes`,
// `river_raise_sizes`, `max_raises` (both streets), `turn_max_raises`,
// `river_max_raises`. `bet_sizes` / `raise_sizes` act as defaults for both
// streets when the per-street field is absent.
// ============================================================================

fn parse_board4_value(val: &JsonValue) -> Result<[Card; 4], SolveError> {
    match val {
        JsonValue::String(s) => Ok(Card::parse_n::<4>(s)?),
        JsonValue::Array(arr) => {
            let mut joined = String::new();
            for item in arr {
                let s = item.as_str().ok_or_else(|| {
                    SolveError::JsonError("board array elements must be card strings".to_string())
                })?;
                if !joined.is_empty() {
                    joined.push(' ');
                }
                joined.push_str(s);
            }
            Ok(Card::parse_n::<4>(&joined)?)
        }
        _ => Err(SolveError::JsonError(
            "\"board\" must be a string or array of 4 card strings".to_string(),
        )),
    }
}

fn parse_number_array(root: &JsonValue, key: &str) -> Result<Option<Vec<f64>>, SolveError> {
    match root.get(key) {
        None => Ok(None),
        Some(v) => {
            let arr = v.as_array().ok_or_else(|| {
                SolveError::JsonError(format!("\"{key}\" must be an array of numbers"))
            })?;
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(item.as_f64().ok_or_else(|| {
                    SolveError::JsonError(format!("\"{key}\" must contain numbers"))
                })?);
            }
            Ok(Some(out))
        }
    }
}

fn parse_pot_and_stack(root: &JsonValue) -> Result<(f64, f64), SolveError> {
    let starting_pot = root
        .get("pot")
        .or_else(|| root.get("starting_pot"))
        .and_then(|v| v.as_f64())
        .ok_or_else(|| SolveError::JsonError("missing required numeric field \"pot\"".to_string()))?;
    let effective_stack = if let Some(s_val) = root
        .get("stacks")
        .or_else(|| root.get("effective_stack"))
        .or_else(|| root.get("stack"))
    {
        if let Some(n) = s_val.as_f64() {
            n
        } else if let Some(arr) = s_val.as_array() {
            if arr.is_empty() {
                return Err(SolveError::JsonError(
                    "\"stacks\" array cannot be empty".to_string(),
                ));
            }
            let mut min_s = f64::INFINITY;
            for item in arr {
                let n = item.as_f64().ok_or_else(|| {
                    SolveError::JsonError("\"stacks\" elements must be numbers".to_string())
                })?;
                if n < min_s {
                    min_s = n;
                }
            }
            min_s
        } else {
            return Err(SolveError::JsonError(
                "\"stacks\" must be a number or array of numbers".to_string(),
            ));
        }
    } else {
        return Err(SolveError::JsonError(
            "missing required field \"stacks\" (or \"effective_stack\" / \"stack\")".to_string(),
        ));
    };
    Ok((starting_pot, effective_stack))
}

fn street_config_from_json(
    root: &JsonValue,
    prefix: &str,
) -> Result<TreeConfig, SolveError> {
    let mut cfg = TreeConfig::default();
    if let Some(sizes) = parse_number_array(root, &format!("{prefix}_bet_sizes"))?
        .or(parse_number_array(root, "bet_sizes")?)
    {
        cfg.bet_sizes = sizes;
    }
    if let Some(sizes) = parse_number_array(root, &format!("{prefix}_raise_sizes"))?
        .or(parse_number_array(root, "raise_sizes")?)
    {
        cfg.raise_sizes = sizes;
    }
    if let Some(mr) = root
        .get(&format!("{prefix}_max_raises"))
        .or_else(|| root.get("max_raises"))
        .and_then(|v| v.as_f64())
    {
        cfg.max_raises = mr.max(0.0) as usize;
    }
    if let Some(ai) = root.get("include_all_in") {
        if let JsonValue::Bool(b) = ai {
            cfg.include_all_in_bet = *b;
            cfg.include_all_in_raise = *b;
        }
    }
    // A street-specific flag overrides the shared one. This lets the wizard
    // honour the flop/turn/river all-in toggles independently while old
    // turn spots that only carry `include_all_in` keep their behaviour.
    if let Some(ai) = root.get(&format!("{prefix}_include_all_in")) {
        if let JsonValue::Bool(b) = ai {
            cfg.include_all_in_bet = *b;
            cfg.include_all_in_raise = *b;
        }
    }
    if let Some(ai) = root.get(&format!("{prefix}_include_all_in_bet")) {
        if let JsonValue::Bool(b) = ai {
            cfg.include_all_in_bet = *b;
        }
    }
    if let Some(ai) = root.get(&format!("{prefix}_include_all_in_raise")) {
        if let JsonValue::Bool(b) = ai {
            cfg.include_all_in_raise = *b;
        }
    }
    Ok(cfg)
}

/// Parses a turn spot and solver configuration from a JSON string.
pub fn parse_turn_spot_json(input: &str) -> Result<(TurnSpot, DcfrConfig), SolveError> {
    let root = JsonValue::parse(input)?;

    let board_val = root
        .get("board")
        .ok_or_else(|| SolveError::JsonError("missing required field \"board\"".to_string()))?;
    let board = parse_board4_value(board_val)?;

    let (oop_val, ip_val) = if let (Some(o), Some(i)) = (
        root.get("oop_range").or_else(|| root.get("oop")),
        root.get("ip_range").or_else(|| root.get("ip")),
    ) {
        (o, i)
    } else if let Some(ranges_arr) = root.get("ranges").and_then(|v| v.as_array()) {
        if ranges_arr.len() != 2 {
            return Err(SolveError::JsonError(
                "\"ranges\" array must have exactly 2 elements [oop, ip]".to_string(),
            ));
        }
        (&ranges_arr[0], &ranges_arr[1])
    } else {
        return Err(SolveError::JsonError(
            "missing required range fields (\"oop_range\"/\"ip_range\" or \"oop\"/\"ip\")"
                .to_string(),
        ));
    };
    let oop_range = parse_range_value(oop_val)?;
    let ip_range = parse_range_value(ip_val)?;

    let (starting_pot, effective_stack) = parse_pot_and_stack(&root)?;
    let turn_config = street_config_from_json(&root, "turn")?;
    let river_config = street_config_from_json(&root, "river")?;

    let mut dcfr_config = DcfrConfig::default();
    if let Some(iters) = root
        .get("max_iterations")
        .or_else(|| root.get("iterations"))
        .and_then(|v| v.as_f64())
    {
        dcfr_config.max_iterations = (iters.max(1.0)) as usize;
    }
    if let Some(target) = root
        .get("target_exploitability_pct")
        .or_else(|| root.get("target_exploitability"))
        .and_then(|v| v.as_f64())
    {
        dcfr_config.target_exploitability_pct = target.max(0.0);
    }
    if let Some(ci) = root.get("check_interval").and_then(|v| v.as_f64()) {
        dcfr_config.check_interval = (ci.max(0.0)) as usize;
    }

    Ok((
        TurnSpot {
            board,
            oop_range,
            ip_range,
            starting_pot,
            effective_stack,
            turn_config,
            river_config,
        },
        dcfr_config,
    ))
}

/// Serializes a solved turn spot and its independent exploitability report into
/// formatted JSON. Node entries carry `street` and, for river nodes, `river_card`.
pub fn format_turn_solve_result_json(game: &TurnGame, result: &TurnSolveResult) -> String {
    let mut out = String::with_capacity(16384);
    out.push_str("{\n");
    out.push_str(&format!(
        "  \"board\": \"{}\",\n",
        format_cards(&game.board)
    ));
    out.push_str(&format!("  \"starting_pot\": {:.6},\n", game.starting_pot));
    out.push_str(&format!(
        "  \"effective_stack\": {:.6},\n",
        game.effective_stack
    ));
    out.push_str(&format!("  \"iterations\": {},\n", result.iterations));

    let ex = &result.exploitability;
    out.push_str("  \"exploitability\": {\n");
    out.push_str(&format!(
        "    \"nash_distance_pct\": {:.6},\n",
        ex.nash_distance_pct
    ));
    out.push_str(&format!(
        "    \"nash_distance_chips\": {:.6},\n",
        ex.nash_distance_chips
    ));
    out.push_str(&format!(
        "    \"mean_exploitability_pct\": {:.6},\n",
        ex.mean_exploitability_pct
    ));
    out.push_str(&format!(
        "    \"mean_exploitability_chips\": {:.6},\n",
        ex.mean_exploitability_chips
    ));
    out.push_str(&format!(
        "    \"oop_exploitability_chips\": {:.6},\n",
        ex.oop_exploitability_chips
    ));
    out.push_str(&format!(
        "    \"ip_exploitability_chips\": {:.6},\n",
        ex.ip_exploitability_chips
    ));
    out.push_str(&format!("    \"oop_br_ev\": {:.6},\n", ex.oop_br_ev));
    out.push_str(&format!("    \"ip_br_ev\": {:.6},\n", ex.ip_br_ev));
    out.push_str(&format!(
        "    \"oop_strategy_ev\": {:.6},\n",
        ex.oop_strategy_ev
    ));
    out.push_str(&format!(
        "    \"ip_strategy_ev\": {:.6}\n",
        ex.ip_strategy_ev
    ));
    out.push_str("  },\n");

    out.push_str("  \"oop_evs\": [\n");
    for (i, ce) in result.oop_evs.iter().enumerate() {
        let comma = if i + 1 < result.oop_evs.len() { "," } else { "" };
        out.push_str(&format!(
            "    {{\"combo\": \"{}\", \"weight\": {:.6}, \"ev\": {:.6}}}{}\n",
            format_cards(&ce.combo.cards),
            ce.combo.weight,
            ce.ev,
            comma
        ));
    }
    out.push_str("  ],\n");

    out.push_str("  \"ip_evs\": [\n");
    for (i, ce) in result.ip_evs.iter().enumerate() {
        let comma = if i + 1 < result.ip_evs.len() { "," } else { "" };
        out.push_str(&format!(
            "    {{\"combo\": \"{}\", \"weight\": {:.6}, \"ev\": {:.6}}}{}\n",
            format_cards(&ce.combo.cards),
            ce.combo.weight,
            ce.ev,
            comma
        ));
    }
    out.push_str("  ],\n");

    out.push_str("  \"nodes\": [\n");
    for (d_idx, ns) in result.strategies.iter().enumerate() {
        let d = game.decision_node(ns.decision_id);
        let combos = game.player_combos(ns.player);
        out.push_str("    {\n");
        out.push_str(&format!("      \"decision_id\": {},\n", ns.decision_id));
        out.push_str(&format!("      \"node_id\": {},\n", ns.node_id));
        out.push_str(&format!("      \"player\": \"{}\",\n", ns.player));
        out.push_str(&format!("      \"street\": \"{}\",\n", d.street.as_str()));
        match d.river_card {
            Some(rc) => out.push_str(&format!(
                "      \"river_card\": \"{}\",\n",
                format_cards(&[rc])
            )),
            None => out.push_str("      \"river_card\": null,\n"),
        }
        out.push_str(&format!("      \"history\": \"{}\",\n", ns.history));
        out.push_str(&format!("      \"pot\": {:.6},\n", d.current_pot));
        out.push_str(&format!("      \"to_call\": {:.6},\n", d.to_call));

        out.push_str("      \"actions\": [");
        for (a_idx, act) in ns.actions.iter().enumerate() {
            if a_idx > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!("\"{}\"", act.label()));
        }
        out.push_str("],\n");

        out.push_str("      \"strategy\": {\n");
        for (c_idx, combo) in combos.iter().enumerate() {
            let c_comma = if c_idx + 1 < combos.len() { "," } else { "" };
            let freqs = ns.combo_strategy(c_idx);
            out.push_str(&format!("        \"{}\": [", format_cards(&combo.cards)));
            for (a_idx, &f) in freqs.iter().enumerate() {
                if a_idx > 0 {
                    out.push_str(", ");
                }
                out.push_str(&format!("{:.6}", f));
            }
            out.push_str(&format!("]{}\n", c_comma));
        }
        out.push_str("      }\n");

        let n_comma = if d_idx + 1 < result.strategies.len() {
            ","
        } else {
            ""
        };
        out.push_str(&format!("    }}{}\n", n_comma));
    }
    out.push_str("  ]\n");
    out.push_str("}\n");
    out
}

// ============================================================================
// Flop spots (Ticket E4 + Phase 2 integration): JSON parsing/serialization
// for `solve-flop`. Input mirrors the turn format with a 3-card `board` and
// three per-street tree fields (`flop_*`, `turn_*`, `river_*`). Bucketing is
// EXACT by default; a spot opts into flop-street bucketing only by carrying
// one of:
//   "buckets": 200                 (a bare bucket count)
//   "buckets": "exact"             (explicit exact mode)
//   "bucket_config": {"k": 200}    (object form)
//   "bucket_count": 200            (alias)
// However the solve was bucketed, the emitted flop-street strategies are
// expanded back to combo level (the same expansion the exploitability
// checker evaluates), so every node in the output is keyed by real combos.
//
// History-key scheme (the Explorer's navigation contract):
//   - Flop decision nodes keep their native flop histories: "root",
//     "X", "B(75)/C", ...
//   - A turn subtree below the closed flop history H on turn card T is
//     namespaced as "{H}|t:{T}" for its root. Deeper turn nodes append
//     their local action path: "{H}|t:{T}/B(75)".
//   - River subtrees inside a turn subtree keep the turn solver's own
//     convention after the turn path: "{H}|t:{T}/X/X|r:{R}" for a river
//     root, "{H}|t:{T}/X/X|r:{R}/B(75)" below it.
// So an action that closes the flop street resolves to one
// "{child}|t:{Card}" subtree root per turn card, exactly as an action
// that closes the turn street resolves to "{child}|r:{Card}" river roots.
// ============================================================================

fn parse_board3_value(val: &JsonValue) -> Result<[Card; 3], SolveError> {
    match val {
        JsonValue::String(s) => Ok(Card::parse_n::<3>(s)?),
        JsonValue::Array(arr) => {
            let mut joined = String::new();
            for item in arr {
                let s = item.as_str().ok_or_else(|| {
                    SolveError::JsonError("board array elements must be card strings".to_string())
                })?;
                if !joined.is_empty() {
                    joined.push(' ');
                }
                joined.push_str(s);
            }
            Ok(Card::parse_n::<3>(&joined)?)
        }
        _ => Err(SolveError::JsonError(
            "\"board\" must be a string or array of 3 card strings".to_string(),
        )),
    }
}

fn bucket_k_from_f64(n: f64) -> Result<BucketConfig, SolveError> {
    if !n.is_finite() || n < 1.0 || n.fract() != 0.0 {
        return Err(SolveError::JsonError(format!(
            "bucket count must be a positive integer, got {n}"
        )));
    }
    Ok(BucketConfig::K(n as usize))
}

fn bucket_k_from_str(s: &str) -> Result<BucketConfig, SolveError> {
    let k: usize = s.trim().parse().map_err(|_| {
        SolveError::JsonError(format!(
            "bucket count must be a positive integer, got \"{s}\""
        ))
    })?;
    if k == 0 {
        return Err(SolveError::JsonError(
            "bucket count must be a positive integer, got 0".to_string(),
        ));
    }
    Ok(BucketConfig::K(k))
}

/// Parses the optional flop bucket configuration. Absent (or explicitly
/// `"exact"`) means [`BucketConfig::Exact`] — no flop-street abstraction.
fn parse_bucket_config(root: &JsonValue) -> Result<BucketConfig, SolveError> {
    let value = root
        .get("buckets")
        .or_else(|| root.get("bucket_config"))
        .or_else(|| root.get("bucket_count"));
    let Some(value) = value else {
        return Ok(BucketConfig::Exact);
    };
    match value {
        JsonValue::Null => Ok(BucketConfig::Exact),
        JsonValue::Number(n) => bucket_k_from_f64(*n),
        JsonValue::String(s) => {
            let t = s.trim().to_ascii_lowercase();
            if t == "exact" {
                Ok(BucketConfig::Exact)
            } else if let Some(rest) = t.strip_prefix("k:") {
                bucket_k_from_str(rest)
            } else {
                bucket_k_from_str(&t)
            }
        }
        JsonValue::Object(_) => {
            if matches!(value.get("exact"), Some(JsonValue::Bool(true))) {
                return Ok(BucketConfig::Exact);
            }
            match value
                .get("k")
                .or_else(|| value.get("count"))
                .or_else(|| value.get("buckets"))
            {
                Some(JsonValue::Number(n)) => bucket_k_from_f64(*n),
                Some(JsonValue::String(s)) => bucket_k_from_str(s),
                _ => Err(SolveError::JsonError(
                    "bucket_config object must carry \"k\" (or \"exact\": true)".to_string(),
                )),
            }
        }
        _ => Err(SolveError::JsonError(
            "\"buckets\" must be a count, \"exact\", or an object with \"k\"".to_string(),
        )),
    }
}

/// Parses a flop spot and solver configuration from a JSON string.
pub fn parse_flop_spot_json(input: &str) -> Result<(FlopSpot, DcfrConfig), SolveError> {
    let root = JsonValue::parse(input)?;

    let board_val = root
        .get("board")
        .ok_or_else(|| SolveError::JsonError("missing required field \"board\"".to_string()))?;
    let board = parse_board3_value(board_val)?;

    let (oop_val, ip_val) = if let (Some(o), Some(i)) = (
        root.get("oop_range").or_else(|| root.get("oop")),
        root.get("ip_range").or_else(|| root.get("ip")),
    ) {
        (o, i)
    } else if let Some(ranges_arr) = root.get("ranges").and_then(|v| v.as_array()) {
        if ranges_arr.len() != 2 {
            return Err(SolveError::JsonError(
                "\"ranges\" array must have exactly 2 elements [oop, ip]".to_string(),
            ));
        }
        (&ranges_arr[0], &ranges_arr[1])
    } else {
        return Err(SolveError::JsonError(
            "missing required range fields (\"oop_range\"/\"ip_range\" or \"oop\"/\"ip\")"
                .to_string(),
        ));
    };
    let oop_range = parse_range_value(oop_val)?;
    let ip_range = parse_range_value(ip_val)?;

    let (starting_pot, effective_stack) = parse_pot_and_stack(&root)?;
    let flop_config = street_config_from_json(&root, "flop")?;
    let turn_config = street_config_from_json(&root, "turn")?;
    let river_config = street_config_from_json(&root, "river")?;
    let bucket_config = parse_bucket_config(&root)?;

    let mut dcfr_config = DcfrConfig::default();
    if let Some(iters) = root
        .get("max_iterations")
        .or_else(|| root.get("iterations"))
        .and_then(|v| v.as_f64())
    {
        dcfr_config.max_iterations = (iters.max(1.0)) as usize;
    }
    if let Some(target) = root
        .get("target_exploitability_pct")
        .or_else(|| root.get("target_exploitability"))
        .and_then(|v| v.as_f64())
    {
        dcfr_config.target_exploitability_pct = target.max(0.0);
    }
    if let Some(ci) = root.get("check_interval").and_then(|v| v.as_f64()) {
        dcfr_config.check_interval = (ci.max(0.0)) as usize;
    }

    Ok((
        FlopSpot {
            board,
            oop_range,
            ip_range,
            starting_pot,
            effective_stack,
            flop_config,
            turn_config,
            river_config,
            bucket_config,
        },
        dcfr_config,
    ))
}

/// Namespaces a turn-subtree node's local history under its flop line and
/// turn card (see the history-key scheme at the top of this section).
fn flop_subtree_history(flop_history: &str, turn_card: Card, local_history: &str) -> String {
    let base = format!("{}|t:{}", flop_history, format_cards(&[turn_card]));
    if local_history == "root" {
        return base;
    }
    if let Some((turn_history, river_history)) = local_history.split_once("|r:") {
        if turn_history == "root" {
            return format!("{base}|r:{river_history}");
        }
        return format!("{base}/{turn_history}|r:{river_history}");
    }
    format!("{base}/{local_history}")
}

fn push_exploitability_json(out: &mut String, ex: &ExploitabilityReport) {
    out.push_str("  \"exploitability\": {\n");
    out.push_str(&format!(
        "    \"nash_distance_pct\": {:.6},\n",
        ex.nash_distance_pct
    ));
    out.push_str(&format!(
        "    \"nash_distance_chips\": {:.6},\n",
        ex.nash_distance_chips
    ));
    out.push_str(&format!(
        "    \"mean_exploitability_pct\": {:.6},\n",
        ex.mean_exploitability_pct
    ));
    out.push_str(&format!(
        "    \"mean_exploitability_chips\": {:.6},\n",
        ex.mean_exploitability_chips
    ));
    out.push_str(&format!(
        "    \"oop_exploitability_chips\": {:.6},\n",
        ex.oop_exploitability_chips
    ));
    out.push_str(&format!(
        "    \"ip_exploitability_chips\": {:.6},\n",
        ex.ip_exploitability_chips
    ));
    out.push_str(&format!("    \"oop_br_ev\": {:.6},\n", ex.oop_br_ev));
    out.push_str(&format!("    \"ip_br_ev\": {:.6},\n", ex.ip_br_ev));
    out.push_str(&format!(
        "    \"oop_strategy_ev\": {:.6},\n",
        ex.oop_strategy_ev
    ));
    out.push_str(&format!(
        "    \"ip_strategy_ev\": {:.6}\n",
        ex.ip_strategy_ev
    ));
    out.push_str("  },\n");
}

fn push_combo_evs_json(out: &mut String, key: &str, evs: &[ComboEv]) {
    out.push_str(&format!("  \"{key}\": [\n"));
    for (i, ce) in evs.iter().enumerate() {
        let comma = if i + 1 < evs.len() { "," } else { "" };
        out.push_str(&format!(
            "    {{\"combo\": \"{}\", \"weight\": {:.6}, \"ev\": {:.6}}}{}\n",
            format_cards(&ce.combo.cards),
            ce.combo.weight,
            ce.ev,
            comma
        ));
    }
    out.push_str("  ],\n");
}

#[allow(clippy::too_many_arguments)]
fn push_strategy_node_json(
    out: &mut String,
    is_last: bool,
    decision_id: usize,
    node_id: usize,
    player: Player,
    street: &str,
    turn_card: Option<Card>,
    river_card: Option<Card>,
    history: &str,
    current_pot: f64,
    to_call: f64,
    ns: &NodeStrategy,
    combos: &[WeightedCombo],
) {
    out.push_str("    {\n");
    out.push_str(&format!("      \"decision_id\": {},\n", decision_id));
    out.push_str(&format!("      \"node_id\": {},\n", node_id));
    out.push_str(&format!("      \"player\": \"{}\",\n", player));
    out.push_str(&format!("      \"street\": \"{}\",\n", street));
    match turn_card {
        Some(tc) => out.push_str(&format!(
            "      \"turn_card\": \"{}\",\n",
            format_cards(&[tc])
        )),
        None => out.push_str("      \"turn_card\": null,\n"),
    }
    match river_card {
        Some(rc) => out.push_str(&format!(
            "      \"river_card\": \"{}\",\n",
            format_cards(&[rc])
        )),
        None => out.push_str("      \"river_card\": null,\n"),
    }
    out.push_str(&format!("      \"history\": \"{}\",\n", history));
    out.push_str(&format!("      \"pot\": {:.6},\n", current_pot));
    out.push_str(&format!("      \"to_call\": {:.6},\n", to_call));

    out.push_str("      \"actions\": [");
    for (a_idx, act) in ns.actions.iter().enumerate() {
        if a_idx > 0 {
            out.push_str(", ");
        }
        out.push_str(&format!("\"{}\"", act.label()));
    }
    out.push_str("],\n");

    out.push_str("      \"strategy\": {\n");
    for (c_idx, combo) in combos.iter().enumerate() {
        let c_comma = if c_idx + 1 < combos.len() { "," } else { "" };
        let freqs = ns.combo_strategy(c_idx);
        out.push_str(&format!("        \"{}\": [", format_cards(&combo.cards)));
        for (a_idx, &f) in freqs.iter().enumerate() {
            if a_idx > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!("{:.6}", f));
        }
        out.push_str(&format!("]{}\n", c_comma));
    }
    out.push_str("      }\n");
    out.push_str(&format!("    }}{}\n", if is_last { "" } else { "," }));
}

/// Serializes a solved flop spot and its independent exploitability report
/// into formatted JSON: one flat `nodes` array holding the flop street and
/// every turn/river subtree, joined by the history-key scheme above. Node
/// `decision_id` / `node_id` are made unique across the whole output by
/// offsetting each subtree's local ids past the flop tree and all earlier
/// subtrees (histories remain the authoritative navigation keys).
pub fn format_flop_solve_result_json(game: &FlopGame, result: &FlopSolveResult) -> String {
    // The Explorer consumes combo-level strategies; expand the (possibly
    // bucketed) flop profile exactly as the checker does.
    let expanded_flop = expand_bucket_strategies(game, &result.flop_strategies);
    let subtree_node_count: usize = game
        .subtrees
        .iter()
        .zip(result.subtree_strategies.iter())
        .filter(|(sub, _)| sub.game.is_some())
        .map(|(_, strategies)| strategies.len())
        .sum();
    let total_nodes = expanded_flop.len() + subtree_node_count;

    let mut out = String::with_capacity(16384);
    out.push_str("{\n");
    out.push_str(&format!(
        "  \"board\": \"{}\",\n",
        format_cards(&game.board)
    ));
    out.push_str(&format!("  \"starting_pot\": {:.6},\n", game.starting_pot));
    out.push_str(&format!(
        "  \"effective_stack\": {:.6},\n",
        game.effective_stack
    ));
    out.push_str(&format!("  \"iterations\": {},\n", result.iterations));

    push_exploitability_json(&mut out, &result.exploitability);
    push_combo_evs_json(&mut out, "oop_evs", &result.oop_evs);
    push_combo_evs_json(&mut out, "ip_evs", &result.ip_evs);

    out.push_str("  \"nodes\": [\n");
    let mut emitted = 0usize;

    for ns in &expanded_flop {
        let d = game.decision_node(ns.decision_id);
        emitted += 1;
        push_strategy_node_json(
            &mut out,
            emitted == total_nodes,
            ns.decision_id,
            ns.node_id,
            ns.player,
            "flop",
            None,
            None,
            &ns.history,
            d.current_pot,
            d.to_call,
            ns,
            game.player_combos(ns.player),
        );
    }

    let mut decision_offset = game.num_decision_nodes();
    let mut node_offset = game.nodes.len();
    for (sub, strategies) in game.subtrees.iter().zip(result.subtree_strategies.iter()) {
        let sub_game = match &sub.game {
            Some(g) => g,
            None => continue,
        };
        for ns in strategies {
            let d = sub_game.decision_node(ns.decision_id);
            let history = flop_subtree_history(&sub.flop_history, sub.turn_card, &ns.history);
            emitted += 1;
            push_strategy_node_json(
                &mut out,
                emitted == total_nodes,
                ns.decision_id + decision_offset,
                ns.node_id + node_offset,
                ns.player,
                d.street.as_str(),
                Some(sub.turn_card),
                d.river_card,
                &history,
                d.current_pot,
                d.to_call,
                ns,
                sub_game.player_combos(ns.player),
            );
        }
        decision_offset += sub_game.num_decision_nodes();
        node_offset += sub_game.num_nodes();
    }

    out.push_str("  ]\n");
    out.push_str("}\n");
    out
}
