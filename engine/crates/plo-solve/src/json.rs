//! Zero-dependency JSON parser and serializer for `solve-river` spot inputs and strategy outputs.

use plo_cards::{format_cards, Card};
use plo_eval::{PloRange, WeightedCombo};

use crate::br::ExploitabilityReport;
use crate::cfr::{ComboEv, DcfrConfig, NodeStrategy, SolveResult};
use crate::flop::{expand_bucket_strategies, BucketConfig, FlopGame, FlopSolveResult, FlopSpot};
use crate::game::{Player, RiverGame, RiverSpot, SolveError, TreeConfig};
use crate::locks::NodeLock;
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
    dcfr_config.locks = parse_locks(&root)?;

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
            for token in s.split(|c| c == ',' || c == '\n' || c == ';') {
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

/// Parses the optional `"locks"` array of a spot (nodelocking, Ship 3):
/// `[{"history": "root", "player": "OOP", "frequencies": [0.5, 0.5]}]`
/// (`"node"` is accepted as an alias for `"history"`). Only the shape is
/// checked here — node existence, player-to-act, vector length, and the
/// sum-to-1 rule are validated against the built game in [`crate::locks`]
/// before any iteration runs.
fn parse_locks(root: &JsonValue) -> Result<Vec<NodeLock>, SolveError> {
    let Some(value) = root.get("locks") else {
        return Ok(Vec::new());
    };
    if matches!(value, JsonValue::Null) {
        return Ok(Vec::new());
    }
    let arr = value.as_array().ok_or_else(|| {
        SolveError::JsonError("\"locks\" must be an array of lock objects".to_string())
    })?;
    let mut locks = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let history = item
            .get("history")
            .or_else(|| item.get("node"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                SolveError::JsonError(format!(
                    "locks[{i}] must carry a \"history\" (or \"node\") string"
                ))
            })?;
        let player_str = item
            .get("player")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                SolveError::JsonError(format!("locks[{i}] must carry a \"player\" string"))
            })?;
        let player = match player_str {
            "OOP" | "oop" => Player::Oop,
            "IP" | "ip" => Player::Ip,
            other => {
                return Err(SolveError::JsonError(format!(
                    "locks[{i}].player must be \"OOP\" or \"IP\", got \"{other}\""
                )))
            }
        };
        let freq_arr = item
            .get("frequencies")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                SolveError::JsonError(format!(
                    "locks[{i}] must carry a \"frequencies\" array of numbers"
                ))
            })?;
        if freq_arr.is_empty() {
            return Err(SolveError::JsonError(format!(
                "locks[{i}].frequencies cannot be empty"
            )));
        }
        let mut frequencies = Vec::with_capacity(freq_arr.len());
        for f in freq_arr {
            frequencies.push(f.as_f64().ok_or_else(|| {
                SolveError::JsonError(format!("locks[{i}].frequencies must contain numbers"))
            })?);
        }
        locks.push(NodeLock {
            history: history.to_string(),
            player,
            frequencies,
        });
    }
    Ok(locks)
}

/// Emits the `"locked"` / `"locks"` header fields of a solve result: the
/// honesty badge. A locked solve is not an equilibrium — consumers must
/// surface it as LOCKED, never CERTIFIED/GTO. Unlocked solves emit
/// `"locked": false` and an empty list so the schema is stable.
fn push_locks_json(out: &mut String, locks: &[NodeLock]) {
    out.push_str(&format!("  \"locked\": {},\n", !locks.is_empty()));
    if locks.is_empty() {
        out.push_str("  \"locks\": [],\n");
        return;
    }
    out.push_str("  \"locks\": [\n");
    for (i, lock) in locks.iter().enumerate() {
        let comma = if i + 1 < locks.len() { "," } else { "" };
        out.push_str("    {\"history\": \"");
        out.push_str(&lock.history);
        out.push_str("\", \"player\": \"");
        out.push_str(lock.player.as_str());
        out.push_str("\", \"frequencies\": [");
        for (a, f) in lock.frequencies.iter().enumerate() {
            if a > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!("{f:.6}"));
        }
        out.push_str("]}");
        out.push_str(comma);
        out.push('\n');
    }
    out.push_str("  ],\n");
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
    push_locks_json(&mut out, &result.locks);

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
    dcfr_config.locks = parse_locks(&root)?;

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
    push_locks_json(&mut out, &result.locks);

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
    dcfr_config.locks = parse_locks(&root)?;

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
    push_locks_json(&mut out, &result.locks);

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

// ============================================================================
// Multiway equity (Ticket MW-1): JSON parsing, execution, and serialization
// for `multiway-equity`.
// ============================================================================

/// Requested execution mode in a multiway equity JSON request.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum MultiwayModeRequest {
    Auto,
    Exact,
    MonteCarlo,
}

/// Parsed multiway equity request from JSON.
#[derive(Clone, Debug)]
pub struct MultiwayEquityRequest {
    pub board: Vec<Card>,
    pub dead_cards: Vec<Card>,
    pub hero: plo_eval::HeroInput,
    pub opponents: Vec<PloRange>,
    pub opponent_labels: Vec<String>,
    pub mode: MultiwayModeRequest,
    pub samples: usize,
    pub seed: u64,
}

fn parse_cards_flexible(val: &JsonValue, field_name: &str) -> Result<Vec<Card>, SolveError> {
    match val {
        JsonValue::String(s) => Ok(Card::parse_many(s)?),
        JsonValue::Array(arr) => {
            let mut joined = String::new();
            for item in arr {
                let s = item.as_str().ok_or_else(|| {
                    SolveError::JsonError(format!(
                        "\"{field_name}\" array elements must be card strings"
                    ))
                })?;
                if !joined.is_empty() {
                    joined.push(' ');
                }
                joined.push_str(s);
            }
            Ok(Card::parse_many(&joined)?)
        }
        _ => Err(SolveError::JsonError(format!(
            "\"{field_name}\" must be a string or array of card strings"
        ))),
    }
}

fn is_random_preset_str(s: &str) -> bool {
    let t = s.trim();
    t.eq_ignore_ascii_case("random")
        || t.eq_ignore_ascii_case("all")
        || t.eq_ignore_ascii_case("any")
        || t == "*"
        || t == "100%"
}

fn parse_range_or_random(
    val: &JsonValue,
    dead_mask: plo_cards::HandMask,
) -> Result<PloRange, SolveError> {
    if let JsonValue::String(s) = val {
        if is_random_preset_str(s) {
            return Ok(PloRange::all_unblocked(dead_mask)?);
        }
    }
    if let JsonValue::Object(_) = val {
        if let Some(inner) = val.get("range") {
            return parse_range_or_random(inner, dead_mask);
        }
    }
    parse_range_value(val)
}

fn escape_json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

/// Parses a [`MultiwayEquityRequest`] from a JSON string.
pub fn parse_multiway_equity_request_json(
    input: &str,
) -> Result<MultiwayEquityRequest, SolveError> {
    let root = JsonValue::parse(input)?;

    // 1. Parse board (3, 4, or 5 cards)
    let board_val = root
        .get("board")
        .ok_or_else(|| SolveError::JsonError("missing required field \"board\"".to_string()))?;
    let board = parse_cards_flexible(board_val, "board")?;
    if board.len() < 3 || board.len() > 5 {
        return Err(SolveError::Equity(
            plo_eval::EquityError::InvalidBoardCardCount(board.len()),
        ));
    }
    let board_mask = plo_cards::HandMask::from_cards(&board);

    // 2. Optional dead_cards
    let dead_cards = match root.get("dead_cards").or_else(|| root.get("dead")) {
        Some(JsonValue::Null) | None => Vec::new(),
        Some(v) => parse_cards_flexible(v, "dead_cards")?,
    };
    let extra_dead_mask = plo_cards::HandMask::from_cards(&dead_cards);

    // 3. Parse hero (`hero_hand`, `hero_range`, or `hero`)
    let (hero, hero_fixed_mask) = if let Some(hh_val) =
        root.get("hero_hand").filter(|v| !matches!(v, JsonValue::Null))
    {
        let cards_vec = parse_cards_flexible(hh_val, "hero_hand")?;
        if cards_vec.len() != 4 {
            return Err(SolveError::Equity(
                plo_eval::EquityError::InvalidHandCardCount(cards_vec.len()),
            ));
        }
        let cards = [cards_vec[0], cards_vec[1], cards_vec[2], cards_vec[3]];
        let mask = plo_cards::HandMask::from_cards(&cards);
        (plo_eval::HeroInput::Hand(cards), mask)
    } else if let Some(hr_val) = root
        .get("hero_range")
        .filter(|v| !matches!(v, JsonValue::Null))
    {
        let range = parse_range_or_random(hr_val, board_mask | extra_dead_mask)?;
        (plo_eval::HeroInput::Range(range), plo_cards::HandMask::EMPTY)
    } else if let Some(h_val) = root.get("hero").filter(|v| !matches!(v, JsonValue::Null)) {
        match h_val {
            JsonValue::String(s) => {
                let trimmed = s.trim();
                if is_random_preset_str(trimmed) {
                    let range = PloRange::all_unblocked(board_mask | extra_dead_mask)?;
                    (plo_eval::HeroInput::Range(range), plo_cards::HandMask::EMPTY)
                } else if !trimmed.contains(',')
                    && !trimmed.contains('\n')
                    && !trimmed.contains(';')
                    && !trimmed.contains(':')
                {
                    let cards = Card::parse_n::<4>(trimmed)?;
                    let mask = plo_cards::HandMask::from_cards(&cards);
                    (plo_eval::HeroInput::Hand(cards), mask)
                } else {
                    let range = parse_range_value(h_val)?;
                    (plo_eval::HeroInput::Range(range), plo_cards::HandMask::EMPTY)
                }
            }
            _ => {
                let range = parse_range_or_random(h_val, board_mask | extra_dead_mask)?;
                (plo_eval::HeroInput::Range(range), plo_cards::HandMask::EMPTY)
            }
        }
    } else {
        return Err(SolveError::JsonError(
            "missing required hero field (\"hero\", \"hero_hand\", or \"hero_range\")".to_string(),
        ));
    };

    // 4. Parse opponents (1..=4 weighted ranges)
    let opps_val = root
        .get("opponents")
        .or_else(|| root.get("opponent_ranges"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            SolveError::JsonError(
                "missing required array field \"opponents\" (1..4 opponent ranges)".to_string(),
            )
        })?;
    if opps_val.is_empty() || opps_val.len() > plo_eval::MAX_MULTIWAY_OPPONENTS {
        return Err(SolveError::Equity(
            plo_eval::EquityError::InvalidOpponentCount(opps_val.len()),
        ));
    }

    let opp_dead_mask = board_mask | extra_dead_mask | hero_fixed_mask;
    let mut opponents = Vec::with_capacity(opps_val.len());
    let mut opponent_labels = Vec::with_capacity(opps_val.len());
    let mut cached_random: Option<PloRange> = None;

    for (idx, item) in opps_val.iter().enumerate() {
        let default_label = format!("Opponent {}", idx + 1);
        let label = item
            .get("label")
            .or_else(|| item.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or(default_label);
        opponent_labels.push(label);

        let range_node = item.get("range").unwrap_or(item);
        if let JsonValue::String(s) = range_node {
            if is_random_preset_str(s) {
                let r = match &cached_random {
                    Some(existing) => existing.clone(),
                    None => {
                        let built = PloRange::all_unblocked(opp_dead_mask)?;
                        cached_random = Some(built.clone());
                        built
                    }
                };
                opponents.push(r);
                continue;
            }
        }
        opponents.push(parse_range_or_random(range_node, opp_dead_mask)?);
    }

    // 5. Optional mode, samples, seed
    let mode = match root.get("mode").and_then(|v| v.as_str()) {
        None | Some("auto") | Some("AUTO") => MultiwayModeRequest::Auto,
        Some("exact") | Some("EXACT") => MultiwayModeRequest::Exact,
        Some("mc") | Some("MC") | Some("monte_carlo") | Some("MONTE_CARLO") => {
            MultiwayModeRequest::MonteCarlo
        }
        Some(other) => {
            return Err(SolveError::JsonError(format!(
                "unsupported mode \"{other}\" (expected \"auto\", \"exact\", or \"monte_carlo\")"
            )))
        }
    };

    let samples = match root.get("samples").or_else(|| root.get("mc_samples")) {
        None | Some(JsonValue::Null) => plo_eval::DEFAULT_MULTIWAY_MC_SAMPLES,
        Some(v) => {
            let n = v.as_f64().ok_or_else(|| {
                SolveError::JsonError("\"samples\" must be a positive integer".to_string())
            })?;
            if !n.is_finite() || n < 1.0 {
                return Err(SolveError::Equity(
                    plo_eval::EquityError::ZeroMonteCarloSamples,
                ));
            }
            n as usize
        }
    };

    let seed = match root.get("seed") {
        None | Some(JsonValue::Null) => plo_eval::DEFAULT_MULTIWAY_MC_SEED,
        Some(v) => {
            let n = v.as_f64().ok_or_else(|| {
                SolveError::JsonError("\"seed\" must be a non-negative integer".to_string())
            })?;
            if !n.is_finite() || n < 0.0 {
                return Err(SolveError::JsonError(
                    "\"seed\" must be a non-negative integer".to_string(),
                ));
            }
            n as u64
        }
    };

    Ok(MultiwayEquityRequest {
        board,
        dead_cards,
        hero,
        opponents,
        opponent_labels,
        mode,
        samples,
        seed,
    })
}

/// Executes a parsed [`MultiwayEquityRequest`] and returns the [`plo_eval::MultiwayEquityResult`].
pub fn run_multiway_equity_request(
    req: &MultiwayEquityRequest,
) -> Result<plo_eval::MultiwayEquityResult, SolveError> {
    let res = match req.mode {
        MultiwayModeRequest::Auto => plo_eval::compute_multiway_equity_auto(
            &req.hero,
            &req.opponents,
            &req.board,
            &req.dead_cards,
            req.samples,
            req.seed,
        )?,
        MultiwayModeRequest::Exact => plo_eval::compute_multiway_equity(
            &req.hero,
            &req.opponents,
            &req.board,
            &req.dead_cards,
            plo_eval::EquityMode::Exact,
        )?,
        MultiwayModeRequest::MonteCarlo => plo_eval::compute_multiway_equity(
            &req.hero,
            &req.opponents,
            &req.board,
            &req.dead_cards,
            plo_eval::EquityMode::MonteCarlo {
                samples: req.samples,
                seed: req.seed,
            },
        )?,
    };
    Ok(res)
}

/// Formats a [`plo_eval::MultiwayEquityResult`] into JSON.
pub fn format_multiway_equity_result_json(
    req: &MultiwayEquityRequest,
    res: &plo_eval::MultiwayEquityResult,
) -> String {
    let street = match req.board.len() {
        3 => "flop",
        4 => "turn",
        5 => "river",
        _ => "unknown",
    };

    let mut out = String::with_capacity(4096);
    out.push_str("{\n");
    out.push_str(&format!(
        "  \"board\": \"{}\",\n",
        format_cards(&req.board)
    ));
    out.push_str(&format!("  \"street\": \"{street}\",\n"));

    match res.mode {
        plo_eval::EquityMode::Exact => {
            out.push_str("  \"mode\": \"exact\",\n");
            out.push_str("  \"badge\": \"EXACT\",\n");
            out.push_str("  \"is_exact\": true,\n");
            out.push_str("  \"samples\": null,\n");
            out.push_str("  \"seed\": null,\n");
        }
        plo_eval::EquityMode::MonteCarlo { samples, seed } => {
            out.push_str("  \"mode\": \"monte_carlo\",\n");
            out.push_str("  \"badge\": \"MONTE CARLO\",\n");
            out.push_str("  \"is_exact\": false,\n");
            out.push_str(&format!("  \"samples\": {samples},\n"));
            out.push_str(&format!("  \"seed\": {seed},\n"));
        }
    }

    out.push_str(&format!(
        "  \"exact_max_showdowns\": {},\n",
        plo_eval::EXACT_MAX_SHOWDOWNS
    ));
    out.push_str(&format!(
        "  \"estimated_showdowns\": {},\n",
        res.estimated_showdowns
    ));
    out.push_str(&format!("  \"total_weight\": {:.6},\n", res.total_weight));

    let dead_vec = res.dead_mask.to_canonical_vec();
    out.push_str("  \"dead_cards\": [");
    for (i, c) in dead_vec.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&format!("\"{}\"", format_cards(&[*c])));
    }
    out.push_str("],\n");

    match &req.hero {
        plo_eval::HeroInput::Hand(cards) => {
            out.push_str("  \"hero_kind\": \"hand\",\n");
            out.push_str(&format!(
                "  \"hero_hand\": \"{}\",\n",
                format_cards(cards)
            ));
        }
        plo_eval::HeroInput::Range(_) => {
            out.push_str("  \"hero_kind\": \"range\",\n");
            out.push_str("  \"hero_hand\": null,\n");
        }
    }

    out.push_str(&format!("  \"hero_equity\": {:.6},\n", res.hero_equity));

    out.push_str("  \"players\": [\n");
    for (i, p) in res.players.iter().enumerate() {
        let role = if p.player_index == 0 {
            "hero"
        } else {
            "opponent"
        };
        let label = if p.player_index == 0 {
            "Hero".to_string()
        } else {
            req.opponent_labels
                .get(p.player_index - 1)
                .cloned()
                .unwrap_or_else(|| format!("Opponent {}", p.player_index))
        };
        let comma = if i + 1 < res.players.len() { "," } else { "" };
        out.push_str(&format!(
            "    {{\"player_index\": {}, \"role\": \"{}\", \"label\": \"{}\", \"equity\": {:.6}, \"win_prob\": {:.6}, \"tie_prob\": {:.6}, \"tie_equity\": {:.6}, \"loss_prob\": {:.6}, \"std_error\": {:.6}}}{}\n",
            p.player_index,
            role,
            escape_json_str(&label),
            p.equity,
            p.win_prob,
            p.tie_prob,
            p.tie_equity,
            p.loss_prob,
            p.std_error,
            comma
        ));
    }
    out.push_str("  ],\n");

    match &res.hero_range_distribution {
        None => {
            out.push_str("  \"hero_range_distribution\": null\n");
        }
        Some(dist) => {
            out.push_str("  \"hero_range_distribution\": {\n");
            out.push_str(&format!("    \"combo_count\": {},\n", dist.combo_count));
            out.push_str(&format!("    \"total_weight\": {:.6},\n", dist.total_weight));
            out.push_str(&format!("    \"mean\": {:.6},\n", dist.mean));
            out.push_str(&format!("    \"min\": {:.6},\n", dist.min));
            out.push_str(&format!("    \"q25\": {:.6},\n", dist.q25));
            out.push_str(&format!("    \"median\": {:.6},\n", dist.median));
            out.push_str(&format!("    \"q75\": {:.6},\n", dist.q75));
            out.push_str(&format!("    \"max\": {:.6},\n", dist.max));
            out.push_str(&format!(
                "    \"quartiles\": [{:.6}, {:.6}, {:.6}, {:.6}, {:.6}],\n",
                dist.quartiles[0],
                dist.quartiles[1],
                dist.quartiles[2],
                dist.quartiles[3],
                dist.quartiles[4]
            ));
            out.push_str("    \"top_decile\": [\n");
            for (i, c) in dist.top_decile.iter().enumerate() {
                let comma = if i + 1 < dist.top_decile.len() {
                    ","
                } else {
                    ""
                };
                out.push_str(&format!(
                    "      {{\"combo\": \"{}\", \"weight\": {:.6}, \"equity\": {:.6}, \"win_prob\": {:.6}, \"tie_prob\": {:.6}}}{}\n",
                    format_cards(&c.cards),
                    c.weight,
                    c.equity,
                    c.win_prob,
                    c.tie_prob,
                    comma
                ));
            }
            out.push_str("    ],\n");
            out.push_str("    \"bottom_decile\": [\n");
            for (i, c) in dist.bottom_decile.iter().enumerate() {
                let comma = if i + 1 < dist.bottom_decile.len() {
                    ","
                } else {
                    ""
                };
                out.push_str(&format!(
                    "      {{\"combo\": \"{}\", \"weight\": {:.6}, \"equity\": {:.6}, \"win_prob\": {:.6}, \"tie_prob\": {:.6}}}{}\n",
                    format_cards(&c.cards),
                    c.weight,
                    c.equity,
                    c.win_prob,
                    c.tie_prob,
                    comma
                ));
            }
            out.push_str("    ]\n");
            out.push_str("  }\n");
        }
    }

    out.push_str("}\n");
    out
}
