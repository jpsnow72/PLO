//! Thread-count resolution and fork policy for the parallel DCFR traversal
//! (Ticket E5a).
//!
//! The only parallelism in the solver lives inside
//! [`crate::turn::turn_traverse`]: at a chance node, the 48 river-runout
//! subtrees are evaluated by a pool of scoped threads over disjoint
//! partitions of the solver's buffer array (see `turn.rs` for the
//! partitioning argument). Everything about *how many* threads to use and
//! *when* a subtree is worth forking is decided here, in one place.
//!
//! Thread count resolution:
//! - `PLO_SOLVER_THREADS` set to an integer `>= 1` wins as-is (values larger
//!   than the core count are honoured; the fork planner never creates more
//!   worker groups than there are chance children to feed).
//! - Missing, unparsable, or `0` falls back to
//!   [`std::thread::available_parallelism`], and to `1` if even that is
//!   unavailable.
//! - `PLO_SOLVER_THREADS=1` reproduces the pre-E5a single-thread behaviour
//!   exactly (the fork branch is never taken).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

/// Environment variable that configures the solver thread count.
pub const THREADS_ENV_VAR: &str = "PLO_SOLVER_THREADS";

/// Minimum total action slots (sum over a chance node's runout subtrees of
/// `combos x actions` per decision node) before evaluating those subtrees on
/// worker threads is worthwhile. Below this, scoped-thread spawn and join
/// overhead is a meaningful fraction of the traversal work. This is a tuning
/// constant, not a correctness parameter: results are identical on either
/// side of the threshold (see the determinism argument in `turn.rs`).
pub(crate) const MIN_FORK_SLOTS: usize = 1024;

/// Process-wide count of chance-node forks taken (diagnostic). Lets tests
/// and benchmark runs confirm the parallel path actually engaged.
static FORK_EVENTS: AtomicUsize = AtomicUsize::new(0);

/// The resolved solver thread count for this process: the value of
/// `PLO_SOLVER_THREADS` if valid, else the machine's available parallelism.
/// Resolved once and cached (the environment is not re-read per solve).
pub fn solver_threads() -> usize {
    static CACHED: OnceLock<usize> = OnceLock::new();
    *CACHED.get_or_init(|| {
        resolve_threads(
            std::env::var(THREADS_ENV_VAR).ok().as_deref(),
            available_parallelism(),
        )
    })
}

/// Pure thread-count resolution (split from [`solver_threads`] so the policy
/// is unit-testable without mutating the process environment).
pub fn resolve_threads(env_value: Option<&str>, available: usize) -> usize {
    if let Some(raw) = env_value {
        if let Ok(n) = raw.trim().parse::<usize>() {
            if n >= 1 {
                return n;
            }
        }
    }
    if available >= 1 {
        available
    } else {
        1
    }
}

fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// Whether a chance node whose runout subtrees hold `subtree_slots` total
/// action slots should be evaluated on worker threads.
pub(crate) fn should_fork(threads: usize, subtree_slots: usize) -> bool {
    threads >= 2 && subtree_slots >= MIN_FORK_SLOTS
}

/// Records one chance-node fork (called by the traversal only; relaxed
/// ordering is fine for a diagnostic counter).
pub(crate) fn note_fork_event() {
    FORK_EVENTS.fetch_add(1, Ordering::Relaxed);
}

/// Total chance-node forks taken so far in this process. Diagnostic only:
/// tests assert it stays `0` for single-threaded solves and increases for
/// multithreaded solves of a large enough spot.
pub fn parallel_fork_events() -> usize {
    FORK_EVENTS.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_value_wins_when_valid() {
        assert_eq!(resolve_threads(Some("1"), 8), 1);
        assert_eq!(resolve_threads(Some("6"), 8), 6);
        // Explicit values are honoured even above the core count; the fork
        // planner caps worker groups at the number of chance children.
        assert_eq!(resolve_threads(Some("64"), 8), 64);
        // Whitespace around the number is tolerated.
        assert_eq!(resolve_threads(Some(" 4 "), 8), 4);
    }

    #[test]
    fn invalid_env_values_fall_back_to_available() {
        assert_eq!(resolve_threads(None, 8), 8);
        assert_eq!(resolve_threads(Some(""), 8), 8);
        assert_eq!(resolve_threads(Some("0"), 8), 8);
        assert_eq!(resolve_threads(Some("-3"), 8), 8);
        assert_eq!(resolve_threads(Some("six"), 8), 8);
        assert_eq!(resolve_threads(Some("2.5"), 8), 8);
    }

    #[test]
    fn unavailable_parallelism_falls_back_to_one() {
        assert_eq!(resolve_threads(None, 0), 1);
        assert_eq!(resolve_threads(Some("junk"), 0), 1);
    }

    #[test]
    fn fork_policy_thresholds() {
        assert!(!should_fork(1, usize::MAX));
        assert!(!should_fork(4, MIN_FORK_SLOTS - 1));
        assert!(should_fork(2, MIN_FORK_SLOTS));
        assert!(should_fork(4, MIN_FORK_SLOTS * 10));
    }

    #[test]
    fn solver_threads_is_at_least_one() {
        assert!(solver_threads() >= 1);
    }
}
