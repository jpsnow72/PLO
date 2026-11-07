//! Vectorised Discounted CFR (DCFR) solver for heads-up PLO river games.
//!
//! Implements Brown & Sandholm (2019) Discounted CFR with default parameters
//! $\alpha = 1.5$, $\beta = 0.0$, $\gamma = 2.0$, and alternating player updates
//! over the full unbucketed river combo space.

use std::cmp::Ordering;

use plo_eval::WeightedCombo;

use crate::br::{compute_exploitability, ExploitabilityReport};
use crate::game::{Action, Node, NodeId, Player, RiverGame, TerminalNode};

/// Configuration parameters for the Discounted CFR river solver.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct DcfrConfig {
    /// Maximum number of DCFR iterations to run (default: `1000`).
    pub max_iterations: usize,
    /// Target Nash Distance in `%` of starting pot for early stopping (default: `0.05`).
    /// Set to `0.0` to disable early stopping and always run `max_iterations`.
    pub target_exploitability_pct: f64,
    /// Interval (in iterations) at which to check exploitability for early stopping (default: `25`).
    pub check_interval: usize,
    /// Positive regret discount exponent $\alpha$ (default: `1.5`).
    pub alpha: f64,
    /// Negative regret discount exponent $\beta$ (default: `0.0`).
    pub beta: f64,
    /// Strategy accumulation discount exponent $\gamma$ (default: `2.0`).
    pub gamma: f64,
}

impl Default for DcfrConfig {
    fn default() -> Self {
        Self {
            max_iterations: 1000,
            target_exploitability_pct: 0.05,
            check_interval: 25,
            alpha: 1.5,
            beta: 0.0,
            gamma: 2.0,
        }
    }
}

/// Average strategy at a single decision node across all active combos of the acting player.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeStrategy {
    /// Sequential decision node index (`0..game.num_decision_nodes()`).
    pub decision_id: usize,
    /// Node index in `game.nodes`.
    pub node_id: NodeId,
    /// Acting player at this decision node.
    pub player: Player,
    /// Action history string reaching this node.
    pub history: String,
    /// Legal actions at this decision node.
    pub actions: Vec<Action>,
    /// Number of active combos for `player`.
    pub num_combos: usize,
    /// Action probabilities stored in combo-major order:
    /// `frequencies[combo_idx * actions.len() + action_idx]`.
    pub frequencies: Vec<f64>,
}

impl NodeStrategy {
    /// Returns the probability of `action_idx` for `combo_idx`.
    #[inline]
    pub fn freq(&self, combo_idx: usize, action_idx: usize) -> f64 {
        let num_actions = self.actions.len();
        self.frequencies[combo_idx * num_actions + action_idx]
    }

    /// Returns the slice of action probabilities (length `actions.len()`, summing to `1.0`)
    /// for `combo_idx`.
    #[inline]
    pub fn combo_strategy(&self, combo_idx: usize) -> &[f64] {
        let num_actions = self.actions.len();
        let start = combo_idx * num_actions;
        &self.frequencies[start..start + num_actions]
    }
}

/// Per-combo expected value at the root of the river game.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ComboEv {
    /// The 4-card weighted combo.
    pub combo: WeightedCombo,
    /// Conditional expected value in chips at the start of the river (where folding immediately = `0.0`).
    pub ev: f64,
}

/// Complete output of solving a river spot with Discounted CFR.
#[derive(Clone, Debug)]
pub struct SolveResult {
    /// Average strategy per decision node (`0..game.num_decision_nodes()`).
    pub strategies: Vec<NodeStrategy>,
    /// Per-combo expected values for OOP at the root.
    pub oop_evs: Vec<ComboEv>,
    /// Per-combo expected values for IP at the root.
    pub ip_evs: Vec<ComboEv>,
    /// Overall expected value in chips for OOP at the root.
    pub oop_game_ev: f64,
    /// Overall expected value in chips for IP at the root.
    pub ip_game_ev: f64,
    /// Total number of DCFR iterations executed.
    pub iterations: usize,
    /// Exact exploitability report measured by the independent checker (`br.rs`).
    pub exploitability: ExploitabilityReport,
}

/// Precomputed CSR lookup table of unblocked opponent combo indices partitioned into
/// `(wins, ties, losses)` for fast vectorised terminal evaluation.
struct PlayerKernel {
    /// For each combo `i` in `0..num_my`, `[start_wins, start_ties, start_losses, end_losses]`.
    offsets: Vec<[u32; 4]>,
    /// Flattened opponent combo indices `j` disjoint from combo `i`.
    opp_indices: Vec<u32>,
}

impl PlayerKernel {
    fn build(game: &RiverGame, player: Player) -> Self {
        let p_idx = player.index();
        let q_idx = player.opponent().index();
        let my_combos = &game.combos[p_idx];
        let opp_combos = &game.combos[q_idx];
        let my_ranks = &game.hand_ranks[p_idx];
        let opp_ranks = &game.hand_ranks[q_idx];

        let mut offsets = Vec::with_capacity(my_combos.len());
        let mut opp_indices = Vec::with_capacity(my_combos.len() * opp_combos.len());

        let mut wins_buf = Vec::with_capacity(opp_combos.len());
        let mut ties_buf = Vec::with_capacity(opp_combos.len());
        let mut losses_buf = Vec::with_capacity(opp_combos.len());

        for (i, mc) in my_combos.iter().enumerate() {
            wins_buf.clear();
            ties_buf.clear();
            losses_buf.clear();
            let r_my = my_ranks[i];

            for (j, oc) in opp_combos.iter().enumerate() {
                if !mc.mask.overlaps(oc.mask) {
                    match r_my.cmp(&opp_ranks[j]) {
                        Ordering::Greater => wins_buf.push(j as u32),
                        Ordering::Equal => ties_buf.push(j as u32),
                        Ordering::Less => losses_buf.push(j as u32),
                    }
                }
            }

            let s0 = opp_indices.len() as u32;
            opp_indices.extend_from_slice(&wins_buf);
            let s1 = opp_indices.len() as u32;
            opp_indices.extend_from_slice(&ties_buf);
            let s2 = opp_indices.len() as u32;
            opp_indices.extend_from_slice(&losses_buf);
            let s3 = opp_indices.len() as u32;

            offsets.push([s0, s1, s2, s3]);
        }

        Self {
            offsets,
            opp_indices,
        }
    }

    #[inline]
    fn eval_fold(&self, opp_reach: &[f64], payoff: f64, out: &mut [f64]) {
        if payoff == 0.0 {
            out.fill(0.0);
            return;
        }
        for (i, &[s0, _, _, s3]) in self.offsets.iter().enumerate() {
            let mut sum = 0.0f64;
            for &j in &self.opp_indices[s0 as usize..s3 as usize] {
                // SAFETY: `j` is always `< opp_reach.len()`.
                sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            out[i] = sum * payoff;
        }
    }

    #[inline]
    fn eval_showdown(
        &self,
        opp_reach: &[f64],
        win_payoff: f64,
        tie_payoff: f64,
        loss_payoff: f64,
        out: &mut [f64],
    ) {
        for (i, &[s0, s1, s2, s3]) in self.offsets.iter().enumerate() {
            let mut win_sum = 0.0f64;
            for &j in &self.opp_indices[s0 as usize..s1 as usize] {
                win_sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            let mut tie_sum = 0.0f64;
            for &j in &self.opp_indices[s1 as usize..s2 as usize] {
                tie_sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            let mut loss_sum = 0.0f64;
            for &j in &self.opp_indices[s2 as usize..s3 as usize] {
                loss_sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            out[i] = win_payoff * win_sum + tie_payoff * tie_sum + loss_payoff * loss_sum;
        }
    }
}

/// Mutable per-decision-node buffers used during DCFR iterations.
struct NodeBuffer {
    player: Player,
    num_actions: usize,
    num_combos: usize,
    /// Cumulative discounted regrets `regrets[combo_idx * num_actions + action_idx]`.
    regrets: Vec<f64>,
    /// Cumulative weighted strategies `cum_strategy[combo_idx * num_actions + action_idx]`.
    cum_strategy: Vec<f64>,
    /// Current iteration's regret-matched strategy `current_strategy[combo_idx * num_actions + action_idx]`.
    current_strategy: Vec<f64>,
}

impl NodeBuffer {
    fn new(player: Player, num_actions: usize, num_combos: usize) -> Self {
        let len = num_actions * num_combos;
        let uniform = if num_actions > 0 {
            1.0 / (num_actions as f64)
        } else {
            0.0
        };
        Self {
            player,
            num_actions,
            num_combos,
            regrets: vec![0.0; len],
            cum_strategy: vec![0.0; len],
            current_strategy: vec![uniform; len],
        }
    }

    /// Recomputes `current_strategy` from `regrets` via Regret Matching.
    #[inline]
    fn recompute_current_strategy(&mut self) {
        let num_actions = self.num_actions;
        let uniform = 1.0 / (num_actions as f64);

        for i in 0..self.num_combos {
            let base = i * num_actions;
            let reg_slice = &self.regrets[base..base + num_actions];
            let strat_slice = &mut self.current_strategy[base..base + num_actions];

            let mut pos_sum = 0.0f64;
            for &r in reg_slice {
                if r > 0.0 {
                    pos_sum += r;
                }
            }

            if pos_sum > 0.0 {
                let inv = 1.0 / pos_sum;
                for a in 0..num_actions {
                    let r = reg_slice[a];
                    strat_slice[a] = if r > 0.0 { r * inv } else { 0.0 };
                }
            } else {
                strat_slice.fill(uniform);
            }
        }
    }

    /// Extracts the normalized average strategy for this decision node.
    fn to_node_strategy(&self, game: &RiverGame, decision_id: usize) -> NodeStrategy {
        let d = game.decision_node(decision_id);
        let num_actions = self.num_actions;
        let uniform = 1.0 / (num_actions as f64);
        let mut frequencies = vec![0.0f64; num_actions * self.num_combos];

        for i in 0..self.num_combos {
            let base = i * num_actions;
            let cum_slice = &self.cum_strategy[base..base + num_actions];
            let out_slice = &mut frequencies[base..base + num_actions];

            let sum: f64 = cum_slice.iter().sum();
            if sum > 0.0 {
                let inv = 1.0 / sum;
                for a in 0..num_actions {
                    out_slice[a] = cum_slice[a] * inv;
                }
            } else {
                // Fallback to current regret-matched strategy if node had 0 reach for this combo.
                let cur_slice = &self.current_strategy[base..base + num_actions];
                let cur_sum: f64 = cur_slice.iter().sum();
                if cur_sum > 0.0 {
                    let inv = 1.0 / cur_sum;
                    for a in 0..num_actions {
                        out_slice[a] = cur_slice[a] * inv;
                    }
                } else {
                    out_slice.fill(uniform);
                }
            }
        }

        NodeStrategy {
            decision_id,
            node_id: d.node_id,
            player: d.player,
            history: d.history.clone(),
            actions: d.actions.clone(),
            num_combos: self.num_combos,
            frequencies,
        }
    }
}

/// Solves a [`RiverGame`] using vectorised Discounted CFR (`DcfrConfig`).
pub fn solve_river(game: &RiverGame, config: &DcfrConfig) -> SolveResult {
    let kernels = [
        PlayerKernel::build(game, Player::Oop),
        PlayerKernel::build(game, Player::Ip),
    ];

    let mut buffers: Vec<NodeBuffer> = (0..game.num_decision_nodes())
        .map(|did| {
            let d = game.decision_node(did);
            let num_combos = game.player_combos(d.player).len();
            NodeBuffer::new(d.player, d.actions.len(), num_combos)
        })
        .collect();

    let init_oop_reach: Vec<f64> = game.combos[0].iter().map(|c| c.weight).collect();
    let init_ip_reach: Vec<f64> = game.combos[1].iter().map(|c| c.weight).collect();

    let mut iterations_done = 0usize;
    let mut final_report: Option<ExploitabilityReport> = None;

    for iter in 1..=config.max_iterations {
        iterations_done = iter;
        let t = iter as f64;
        let t_alpha = t.powf(config.alpha);
        let pos_discount = t_alpha / (t_alpha + 1.0);
        let t_beta = if config.beta == 0.0 {
            1.0
        } else {
            t.powf(config.beta)
        };
        let neg_discount = t_beta / (t_beta + 1.0);
        let strat_weight = t.powf(config.gamma);

        // Half-iteration 1: traverse for OOP (updating OOP regrets and OOP cumulative strategy)
        for buf in &mut buffers {
            if buf.player == Player::Oop {
                buf.recompute_current_strategy();
            }
        }
        dcfr_traverse(
            game,
            &kernels[Player::Oop.index()],
            &mut buffers,
            0,
            Player::Oop,
            &init_oop_reach,
            &init_ip_reach,
            pos_discount,
            neg_discount,
            strat_weight,
        );

        // Half-iteration 2: traverse for IP (updating IP regrets and IP cumulative strategy)
        for buf in &mut buffers {
            if buf.player == Player::Ip {
                buf.recompute_current_strategy();
            }
        }
        dcfr_traverse(
            game,
            &kernels[Player::Ip.index()],
            &mut buffers,
            0,
            Player::Ip,
            &init_ip_reach,
            &init_oop_reach,
            pos_discount,
            neg_discount,
            strat_weight,
        );

        // Check early stopping criteria if enabled
        if config.target_exploitability_pct > 0.0
            && config.check_interval > 0
            && (iter % config.check_interval == 0 || iter == config.max_iterations)
        {
            let strategies: Vec<NodeStrategy> = (0..game.num_decision_nodes())
                .map(|did| buffers[did].to_node_strategy(game, did))
                .collect();
            let report = compute_exploitability(game, &strategies);
            if report.nash_distance_pct <= config.target_exploitability_pct {
                final_report = Some(report);
                break;
            }
            if iter == config.max_iterations {
                final_report = Some(report);
            }
        }
    }

    let strategies: Vec<NodeStrategy> = (0..game.num_decision_nodes())
        .map(|did| buffers[did].to_node_strategy(game, did))
        .collect();

    let exploitability =
        final_report.unwrap_or_else(|| compute_exploitability(game, &strategies));

    let oop_evs: Vec<ComboEv> = game.combos[0]
        .iter()
        .copied()
        .zip(exploitability.oop_strategy_combo_evs.iter().copied())
        .map(|(combo, ev)| ComboEv { combo, ev })
        .collect();

    let ip_evs: Vec<ComboEv> = game.combos[1]
        .iter()
        .copied()
        .zip(exploitability.ip_strategy_combo_evs.iter().copied())
        .map(|(combo, ev)| ComboEv { combo, ev })
        .collect();

    SolveResult {
        strategies,
        oop_evs,
        ip_evs,
        oop_game_ev: exploitability.oop_strategy_ev,
        ip_game_ev: exploitability.ip_strategy_ev,
        iterations: iterations_done,
        exploitability,
    }
}

#[allow(clippy::too_many_arguments)]
fn dcfr_traverse(
    game: &RiverGame,
    kernel: &PlayerKernel,
    buffers: &mut [NodeBuffer],
    node_id: NodeId,
    traverser: Player,
    my_reach: &[f64],
    opp_reach: &[f64],
    pos_discount: f64,
    neg_discount: f64,
    strat_weight: f64,
) -> Vec<f64> {
    let p_idx = traverser.index();
    let q_idx = traverser.opponent().index();
    let num_my = game.combos[p_idx].len();
    let num_opp = game.combos[q_idx].len();

    match &game.nodes[node_id] {
        Node::Terminal(term) => {
            let mut out = vec![0.0f64; num_my];
            match *term {
                TerminalNode::Fold { folder, committed } => {
                    let payoff = if folder == traverser {
                        -committed[p_idx]
                    } else {
                        game.starting_pot + committed[q_idx]
                    };
                    kernel.eval_fold(opp_reach, payoff, &mut out);
                }
                TerminalNode::Showdown { committed } => {
                    let win_payoff = game.starting_pot + committed[q_idx];
                    let tie_payoff = 0.5 * game.starting_pot;
                    let loss_payoff = -committed[p_idx];
                    kernel.eval_showdown(opp_reach, win_payoff, tie_payoff, loss_payoff, &mut out);
                }
            }
            out
        }
        Node::Decision(d) => {
            let decision_id = d.decision_id;
            let num_actions = d.actions.len();

            if d.player == traverser {
                // Copy current strategy for this node so we can recurse mutably on child nodes.
                let cur_strat = buffers[decision_id].current_strategy.clone();

                // Accumulate average strategy weighted by `strat_weight * my_reach[i]`.
                {
                    let cum_strat = &mut buffers[decision_id].cum_strategy;
                    for i in 0..num_my {
                        let w = strat_weight * my_reach[i];
                        if w > 0.0 {
                            let base = i * num_actions;
                            for a in 0..num_actions {
                                cum_strat[base + a] += w * cur_strat[base + a];
                            }
                        }
                    }
                }

                // Evaluate all actions and compute node counterfactual value.
                let mut action_cfvs: Vec<Vec<f64>> = Vec::with_capacity(num_actions);
                let mut node_cfv = vec![0.0f64; num_my];
                let mut next_my_reach = vec![0.0f64; num_my];

                for a in 0..num_actions {
                    let child_id = d.children[a];
                    for i in 0..num_my {
                        next_my_reach[i] = my_reach[i] * cur_strat[i * num_actions + a];
                    }
                    let child_cfv = dcfr_traverse(
                        game,
                        kernel,
                        buffers,
                        child_id,
                        traverser,
                        &next_my_reach,
                        opp_reach,
                        pos_discount,
                        neg_discount,
                        strat_weight,
                    );
                    for i in 0..num_my {
                        node_cfv[i] += cur_strat[i * num_actions + a] * child_cfv[i];
                    }
                    action_cfvs.push(child_cfv);
                }

                // Update and discount cumulative regrets at this node.
                let regrets = &mut buffers[decision_id].regrets;
                for i in 0..num_my {
                    let base = i * num_actions;
                    let ev_i = node_cfv[i];
                    for a in 0..num_actions {
                        let inst_regret = action_cfvs[a][i] - ev_i;
                        let updated = regrets[base + a] + inst_regret;
                        regrets[base + a] = if updated >= 0.0 {
                            updated * pos_discount
                        } else {
                            updated * neg_discount
                        };
                    }
                }

                node_cfv
            } else {
                // Opponent decision node: propagate `opp_reach` according to opponent's current strategy.
                let opp_strat = buffers[decision_id].current_strategy.clone();
                let mut node_cfv = vec![0.0f64; num_my];
                let mut next_opp_reach = vec![0.0f64; num_opp];

                for a in 0..num_actions {
                    let child_id = d.children[a];
                    let mut any_opp = false;
                    for j in 0..num_opp {
                        let r = opp_reach[j] * opp_strat[j * num_actions + a];
                        next_opp_reach[j] = r;
                        if r > 0.0 {
                            any_opp = true;
                        }
                    }
                    if !any_opp {
                        continue;
                    }
                    let child_cfv = dcfr_traverse(
                        game,
                        kernel,
                        buffers,
                        child_id,
                        traverser,
                        my_reach,
                        &next_opp_reach,
                        pos_discount,
                        neg_discount,
                        strat_weight,
                    );
                    for i in 0..num_my {
                        node_cfv[i] += child_cfv[i];
                    }
                }

                node_cfv
            }
        }
    }
}
