//! Nodelocking (Ship 3): fix one player's strategy at a chosen decision
//! node (the "lock") and re-solve the rest of the tree around it.
//!
//! A lock names a decision node by the same history key the solve output
//! uses (see [`crate::json`]), the player to act at that node, and one
//! action-frequency vector that every combo of that player at that node is
//! held to for the whole solve. The lock is a constraint on the game from
//! iteration 0: the locked infoset's strategy never moves (no regret
//! updates, no average-strategy accumulation there — the output strategy at
//! the node is the lock vector verbatim), while every other infoset solves
//! normally. A locked solve is therefore NOT an equilibrium; its output is
//! badged `locked: true` and the independent checker (`br.rs`) prices the
//! lock by measuring the locked profile's exact best-response
//! exploitability and per-player EVs exactly as for an unlocked solve.
//!
//! Node identity by game:
//! - River ([`RiverGame`]): the native node history (`"root"`, `"X"`,
//!   `"B(75)"`, ...).
//! - Turn ([`TurnGame`]): the native two-street history (`"root"`,
//!   `"X/X|r:As"`, `"X/X|r:As/B(75)"`, ...). Chance nodes have no decision
//!   to lock; their histories name no decision node and are rejected.
//! - Flop ([`FlopGame`]): the output history key — a native flop history
//!   (`"root"`, `"B(75)"`) for flop-street nodes, or the namespaced subtree
//!   key (`"{flop_history}|t:{turn_card}/..."`, the exact inverse of
//!   `flop_subtree_history` in `json.rs`) for turn/river nodes inside a
//!   turn-card subtree.
//!
//! Validation is strict and happens before any iteration runs (acceptance
//! criterion 1): an unknown history, a player who is not the player to act
//! at the named node, a frequency vector whose length differs from the
//! node's legal action count, a negative or non-finite frequency,
//! frequencies not summing to 1 (within [`LOCK_SUM_TOLERANCE`]), or two
//! locks naming the same node are all hard errors
//! ([`SolveError::InvalidLock`]). Callers that need the error as a value
//! use the `validate_locks_*` functions; the `solve_*` entry points resolve
//! the locks themselves and panic on an invalid one (a caller bug — the
//! bins validate first and exit cleanly).

use std::collections::HashSet;

use crate::flop::FlopGame;
use crate::game::{Player, RiverGame, SolveError};
use crate::turn::TurnGame;

/// Tolerance on `|sum(frequencies) - 1|` for a lock vector (brief: ±1e-6).
pub const LOCK_SUM_TOLERANCE: f64 = 1e-6;

/// One nodelock: hold `player`'s strategy at the decision node identified
/// by `history` to `frequencies` (one entry per legal action at that node,
/// in the node's action order) for the entire solve.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeLock {
    /// Output history key of the decision node (see the module docs).
    pub history: String,
    /// Player to act at that node (validated against the tree).
    pub player: Player,
    /// Action frequencies over the node's legal actions; must sum to 1.
    pub frequencies: Vec<f64>,
}

/// Validates one lock vector against a node's legal action count.
fn check_vector(lock: &NodeLock, num_actions: usize) -> Result<(), SolveError> {
    if lock.frequencies.len() != num_actions {
        return Err(SolveError::InvalidLock(format!(
            "lock for node \"{}\" has {} frequencies but the node has {} legal actions",
            lock.history,
            lock.frequencies.len(),
            num_actions
        )));
    }
    let mut sum = 0.0f64;
    for &f in &lock.frequencies {
        if !f.is_finite() || f < 0.0 {
            return Err(SolveError::InvalidLock(format!(
                "lock for node \"{}\" has a negative or non-finite frequency ({f})",
                lock.history
            )));
        }
        sum += f;
    }
    if (sum - 1.0).abs() > LOCK_SUM_TOLERANCE {
        return Err(SolveError::InvalidLock(format!(
            "lock frequencies for node \"{}\" sum to {sum}, not 1 (tolerance {LOCK_SUM_TOLERANCE})",
            lock.history
        )));
    }
    Ok(())
}

/// A view of one decision node for lock resolution: (decision_id, history,
/// player to act, legal action count).
type NodeView<'a> = (usize, &'a str, Player, usize);

/// Places one lock into `resolved` (indexed by decision id) after finding
/// its node among `nodes` and validating player + vector. `resolved` slots
/// start as `None`; a second lock landing on the same slot is an error.
fn place_lock<'a>(
    nodes: impl Iterator<Item = NodeView<'a>>,
    resolved: &mut [Option<Vec<f64>>],
    lock: &NodeLock,
) -> Result<(), SolveError> {
    let mut found: Option<NodeView> = None;
    for view in nodes {
        if view.1 == lock.history {
            if found.is_some() {
                return Err(SolveError::InvalidLock(format!(
                    "history \"{}\" names more than one decision node; it cannot be locked unambiguously",
                    lock.history
                )));
            }
            found = Some(view);
        }
    }
    let (decision_id, _, player, num_actions) = found.ok_or_else(|| {
        SolveError::InvalidLock(format!(
            "no decision node with history \"{}\" exists in this solve tree",
            lock.history
        ))
    })?;
    if player != lock.player {
        return Err(SolveError::InvalidLock(format!(
            "lock for node \"{}\" names {} but {} is the player to act there",
            lock.history, lock.player, player
        )));
    }
    check_vector(lock, num_actions)?;
    if resolved[decision_id].is_some() {
        return Err(SolveError::InvalidLock(format!(
            "duplicate lock for node \"{}\"",
            lock.history
        )));
    }
    resolved[decision_id] = Some(lock.frequencies.clone());
    Ok(())
}

/// Rejects two locks in the same list that name the same history (they
/// would target the same node — one player acts at a node by construction).
fn check_no_duplicate_histories(locks: &[NodeLock]) -> Result<(), SolveError> {
    let mut seen: HashSet<&str> = HashSet::with_capacity(locks.len());
    for lock in locks {
        if !seen.insert(lock.history.as_str()) {
            return Err(SolveError::InvalidLock(format!(
                "duplicate lock for node \"{}\"",
                lock.history
            )));
        }
    }
    Ok(())
}

fn river_node_views(game: &RiverGame) -> impl Iterator<Item = NodeView<'_>> {
    (0..game.num_decision_nodes()).map(move |did| {
        let d = game.decision_node(did);
        (did, d.history.as_str(), d.player, d.actions.len())
    })
}

fn turn_node_views(game: &TurnGame) -> impl Iterator<Item = NodeView<'_>> {
    (0..game.num_decision_nodes()).map(move |did| {
        let d = game.decision_node(did);
        (did, d.history.as_str(), d.player, d.actions.len())
    })
}

/// Resolves river locks to per-decision-id frequency vectors (`None` =
/// unlocked), validating every lock against the tree.
pub fn resolve_locks_river(
    game: &RiverGame,
    locks: &[NodeLock],
) -> Result<Vec<Option<Vec<f64>>>, SolveError> {
    check_no_duplicate_histories(locks)?;
    let mut resolved = vec![None; game.num_decision_nodes()];
    for lock in locks {
        place_lock(river_node_views(game), &mut resolved, lock)?;
    }
    Ok(resolved)
}

/// Validates river locks without resolving them (used by the CLI bins so a
/// bad lock exits with a clean error before solving).
pub fn validate_locks_river(game: &RiverGame, locks: &[NodeLock]) -> Result<(), SolveError> {
    resolve_locks_river(game, locks).map(|_| ())
}

/// Resolves turn locks to per-decision-id frequency vectors, validating
/// every lock against the two-street tree (turn and river nodes alike).
pub fn resolve_locks_turn(
    game: &TurnGame,
    locks: &[NodeLock],
) -> Result<Vec<Option<Vec<f64>>>, SolveError> {
    check_no_duplicate_histories(locks)?;
    let mut resolved = vec![None; game.num_decision_nodes()];
    for lock in locks {
        place_lock(turn_node_views(game), &mut resolved, lock)?;
    }
    Ok(resolved)
}

/// Validates turn locks without resolving them.
pub fn validate_locks_turn(game: &TurnGame, locks: &[NodeLock]) -> Result<(), SolveError> {
    resolve_locks_turn(game, locks).map(|_| ())
}

/// Where flop-solve locks land: flop-street buffers, plus per-subtree
/// vectors for the turn/river nodes inside each turn-card subtree.
#[derive(Clone, Debug)]
pub struct FlopLockPlan {
    /// Per flop decision id (`None` = unlocked).
    pub flop: Vec<Option<Vec<f64>>>,
    /// Per subtree index (aligned with `FlopGame::subtrees`): per
    /// subtree-local decision id (`None` = unlocked). Empty for dead
    /// subtrees.
    pub subtrees: Vec<Vec<Option<Vec<f64>>>>,
}

/// Splits a namespaced flop subtree key (`"{flop}|t:{card}..."`, see the
/// module docs) into (flop history, turn-card token, subtree-local
/// TurnGame history). Returns `None` when the key is not a subtree key or
/// is malformed.
fn split_subtree_key(key: &str) -> Option<(&str, &str, String)> {
    let (flop_history, rest) = key.split_once("|t:")?;
    // Turn cards are two characters (rank + suit, e.g. "As", "Td").
    if rest.len() < 2 {
        return None;
    }
    let (card_token, suffix) = rest.split_at(2);
    let local = if suffix.is_empty() {
        "root".to_string()
    } else if let Some(river) = suffix.strip_prefix("|r:") {
        // "{base}|r:{...}" is the subtree root's river child in the output
        // scheme; locally that node is "root|r:{...}".
        format!("root|r:{river}")
    } else if let Some(path) = suffix.strip_prefix('/') {
        path.to_string()
    } else {
        return None;
    };
    Some((flop_history, card_token, local))
}

/// Resolves flop locks into a [`FlopLockPlan`], validating every lock
/// against the flop tree and the subtree it names.
pub fn resolve_locks_flop(
    game: &FlopGame,
    locks: &[NodeLock],
) -> Result<FlopLockPlan, SolveError> {
    check_no_duplicate_histories(locks)?;
    let mut plan = FlopLockPlan {
        flop: vec![None; game.num_decision_nodes()],
        subtrees: game
            .subtrees
            .iter()
            .map(|sub| match &sub.game {
                Some(g) => vec![None; g.num_decision_nodes()],
                None => Vec::new(),
            })
            .collect(),
    };

    // Flop decision-node histories by string, for the plain (non-subtree)
    // dispatch and for ambiguity detection in place_lock.
    let flop_views = |game: &FlopGame| {
        (0..game.num_decision_nodes()).map(move |did| {
            let d = game.decision_node(did);
            (did, d.history.as_str(), d.player, d.actions.len())
        })
    };

    for lock in locks {
        if lock.history.contains("|t:") {
            let (flop_history, card_token, local_history) =
                split_subtree_key(&lock.history).ok_or_else(|| {
                    SolveError::InvalidLock(format!(
                        "malformed subtree lock history \"{}\" (expected \"<flop history>|t:<turn card>[/<path>]\")",
                        lock.history
                    ))
                })?;
            let group = game
                .subtree_groups
                .iter()
                .find(|g| g.flop_history == flop_history)
                .ok_or_else(|| {
                    SolveError::InvalidLock(format!(
                        "lock history \"{}\" names flop line \"{flop_history}\", which closes no flop street in this tree",
                        lock.history
                    ))
                })?;
            let mut placed = false;
            for &sub_idx in &group.subtrees {
                let sub = &game.subtrees[sub_idx];
                if plo_cards::format_cards(&[sub.turn_card]) != card_token {
                    continue;
                }
                let sub_game = sub.game.as_ref().ok_or_else(|| {
                    SolveError::InvalidLock(format!(
                        "lock history \"{}\" names a dead turn-card subtree (no live game)",
                        lock.history
                    ))
                })?;
                let local_lock = NodeLock {
                    history: local_history.clone(),
                    player: lock.player,
                    frequencies: lock.frequencies.clone(),
                };
                place_lock(
                    turn_node_views(sub_game),
                    &mut plan.subtrees[sub_idx],
                    &local_lock,
                )
                .map_err(|e| match e {
                    // Re-key subtree-local failures to the full output key
                    // the caller actually wrote.
                    SolveError::InvalidLock(msg) => SolveError::InvalidLock(
                        msg.replace(&local_history, &lock.history),
                    ),
                    other => other,
                })?;
                placed = true;
                break;
            }
            if !placed {
                return Err(SolveError::InvalidLock(format!(
                    "lock history \"{}\" names turn card \"{card_token}\", which is not dealt below flop line \"{flop_history}\"",
                    lock.history
                )));
            }
        } else {
            place_lock(flop_views(game), &mut plan.flop, lock)?;
        }
    }
    Ok(plan)
}

/// Validates flop locks without resolving them.
pub fn validate_locks_flop(game: &FlopGame, locks: &[NodeLock]) -> Result<(), SolveError> {
    resolve_locks_flop(game, locks).map(|_| ())
}
