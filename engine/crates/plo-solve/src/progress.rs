//! Mid-solve progress reporting (issue #48).
//!
//! The solvers emit nothing while they run, so a multi-hour solve is a
//! black box: nobody can tell whether it is near its exploitability
//! target or days away. When enabled, each solve loop periodically
//! measures the CURRENT average strategy with the same independent
//! best-response checker (`br.rs`) that produces the solve's final
//! exploitability number, and prints one line to **stderr**:
//!
//! ```text
//! PROGRESS iter=<n> expl_pct=<x.xxxx> elapsed_s=<integer seconds>
//! ```
//!
//! `expl_pct` is the checker's Nash distance in % of the starting pot —
//! the same quantity as the final report's `nash_distance_pct`, so a
//! progress reading is directly comparable to the spot's target and to
//! the finished solve's certified number. For a locked solve the
//! checker prices the locked profile exactly as the final check does
//! (the solve loops pass the same snapshot the final check receives,
//! locks included — see the call sites).
//!
//! Cadence: env var `PLO_PROGRESS_EVERY` = report every N iterations.
//! Parsed once per process. Default [`DEFAULT_PROGRESS_EVERY`];
//! `0` or an unparseable value disables reporting entirely.
//!
//! State safety: a progress reading only *observes* the solver. The
//! average-strategy snapshot is built by the same `&self` extraction
//! the final result uses (it allocates fresh `NodeStrategy` values and
//! never writes back), and the checkers take shared references only.
//! Nothing in the reporting path mutates regrets, cumulative strategy,
//! current strategy, locks, RNG, iteration order, or threading, so a
//! solve with reporting enabled produces a bit-identical result to one
//! without (the gate verifies this byte-for-byte).
//!
//! Cost: one checker pass per report. On the river that is cheap next
//! to an iteration; on the flop a checker pass prices all 49 turn
//! subtrees exactly and may cost noticeably more than one flop
//! iteration — the interval default is a starting point, and the gate
//! measures the real ratio before any tuning (see PROGRESS-NOTES.md).

use std::sync::OnceLock;
use std::time::Instant;

/// Env var naming the progress interval, in iterations.
pub const PROGRESS_ENV_VAR: &str = "PLO_PROGRESS_EVERY";

/// Default progress interval (iterations) when the env var is unset.
pub const DEFAULT_PROGRESS_EVERY: usize = 1000;

/// Parses the interval: unset → default; a valid non-negative integer
/// is used verbatim (`0` disables); anything else disables (a typo must
/// never crash or silently re-cadence a long solve — off is the safe
/// failure mode, and the operator asked for a number or nothing).
fn parse_progress_every(raw: Option<&str>) -> usize {
    match raw {
        None => DEFAULT_PROGRESS_EVERY,
        Some(s) => s.trim().parse::<usize>().unwrap_or(0),
    }
}

/// The process-wide progress interval, parsed from the environment once.
pub fn progress_every() -> usize {
    static EVERY: OnceLock<usize> = OnceLock::new();
    *EVERY.get_or_init(|| {
        parse_progress_every(std::env::var(PROGRESS_ENV_VAR).ok().as_deref())
    })
}

/// Per-solve reporter: owns the cadence and the solve's start instant.
pub struct ProgressReporter {
    every: usize,
    start: Instant,
}

impl ProgressReporter {
    /// Starts a reporter for one solve (its clock starts now).
    pub fn new() -> Self {
        Self {
            every: progress_every(),
            start: Instant::now(),
        }
    }

    /// Whether a report is due after completing iteration `iter`.
    #[inline]
    pub fn due(&self, iter: usize) -> bool {
        self.every > 0 && iter % self.every == 0
    }

    /// Prints the PROGRESS line for iteration `iter`, where `expl_pct`
    /// is the checker's Nash distance (% of pot) for the average
    /// strategy as of that iteration. stderr only — stdout and the
    /// result JSON stay byte-identical to an unreported solve.
    pub fn report(&self, iter: usize, expl_pct: f64) {
        eprintln!(
            "PROGRESS iter={} expl_pct={:.4} elapsed_s={}",
            iter,
            expl_pct,
            self.start.elapsed().as_secs()
        );
    }
}

impl Default for ProgressReporter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::parse_progress_every;

    #[test]
    fn unset_defaults_to_1000() {
        assert_eq!(parse_progress_every(None), 1000);
    }

    #[test]
    fn zero_disables() {
        assert_eq!(parse_progress_every(Some("0")), 0);
    }

    #[test]
    fn valid_values_pass_through() {
        assert_eq!(parse_progress_every(Some("5")), 5);
        assert_eq!(parse_progress_every(Some(" 250 ")), 250);
    }

    #[test]
    fn invalid_values_disable() {
        assert_eq!(parse_progress_every(Some("abc")), 0);
        assert_eq!(parse_progress_every(Some("-3")), 0);
        assert_eq!(parse_progress_every(Some("1.5")), 0);
        assert_eq!(parse_progress_every(Some("")), 0);
    }
}
