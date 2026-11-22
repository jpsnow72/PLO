//! No-Limit Hold'em river game definitions.

use std::cmp::Ordering;

use plo_cards::{Card, HandMask};
use plo_eval::{eval_holdem, HandRank, HoldemCombo, HoldemRange};

use crate::br::ExploitabilityReport;
use crate::cfr::{DcfrConfig, NodeStrategy};
use crate::game::{Action, DecisionNode, Node, NodeId, Player, SolveError, TerminalNode, CHIP_EPS};

/// Bet and raise sizes are fractions of the pot (or pot after calling), plus optional all-ins.
#[derive(Clone, Debug, PartialEq)]
pub struct HoldemTreeConfig {
    pub bet_sizes: Vec<f64>,
    pub raise_sizes: Vec<f64>,
    pub include_all_in_bet: bool,
    pub include_all_in_raise: bool,
    pub max_raises: usize,
}

impl Default for HoldemTreeConfig {
    fn default() -> Self {
        Self {
            bet_sizes: vec![0.33, 0.75, 1.0],
            raise_sizes: vec![1.0],
            include_all_in_bet: true,
            include_all_in_raise: true,
            max_raises: 2,
        }
    }
}

/// Input for a heads-up No-Limit Hold'em river solve.
#[derive(Clone, Debug)]
pub struct HoldemSpot {
    pub board: [Card; 5],
    pub oop_range: HoldemRange,
    pub ip_range: HoldemRange,
    pub starting_pot: f64,
    pub effective_stack: f64,
    pub tree_config: HoldemTreeConfig,
}

/// Validated Hold'em river game with a no-limit action tree.
#[derive(Clone, Debug)]
pub struct HoldemGame {
    pub board: [Card; 5],
    pub board_mask: HandMask,
    pub starting_pot: f64,
    pub effective_stack: f64,
    pub tree_config: HoldemTreeConfig,
    pub combos: [Vec<HoldemCombo>; 2],
    pub hand_ranks: [Vec<HandRank>; 2],
    pub total_valid_weight: f64,
    pub nodes: Vec<Node>,
    pub decision_node_ids: Vec<NodeId>,
}

impl HoldemGame {
    pub fn new(spot: HoldemSpot) -> Result<Self, SolveError> {
        let board_mask = HandMask::from_cards(&spot.board);
        if board_mask.count() != 5 {
            return Err(SolveError::DuplicateBoardCards);
        }
        if !spot.starting_pot.is_finite() || spot.starting_pot <= 0.0 {
            return Err(SolveError::InvalidStartingPot(spot.starting_pot));
        }
        if !spot.effective_stack.is_finite() || spot.effective_stack < 0.0 {
            return Err(SolveError::InvalidEffectiveStack(spot.effective_stack));
        }

        let oop: Vec<_> = spot
            .oop_range
            .combos()
            .iter()
            .copied()
            .filter(|combo| !combo.mask.overlaps(board_mask))
            .collect();
        let ip: Vec<_> = spot
            .ip_range
            .combos()
            .iter()
            .copied()
            .filter(|combo| !combo.mask.overlaps(board_mask))
            .collect();
        if oop.is_empty() {
            return Err(SolveError::EmptyUnblockedRange(Player::Oop));
        }
        if ip.is_empty() {
            return Err(SolveError::EmptyUnblockedRange(Player::Ip));
        }

        let ranks = [
            oop.iter()
                .map(|combo| eval_holdem(combo.cards, spot.board))
                .collect(),
            ip.iter()
                .map(|combo| eval_holdem(combo.cards, spot.board))
                .collect(),
        ];
        let total_valid_weight: f64 = oop
            .iter()
            .flat_map(|o| {
                ip.iter()
                    .filter(move |i| !o.mask.overlaps(i.mask))
                    .map(move |i| o.weight * i.weight)
            })
            .sum();
        if total_valid_weight <= 0.0 {
            return Err(SolveError::AllComboPairsBlocked);
        }

        let mut nodes = Vec::new();
        let mut decision_node_ids = Vec::new();
        build_tree(
            &mut nodes,
            &mut decision_node_ids,
            spot.starting_pot,
            spot.effective_stack,
            &spot.tree_config,
            Player::Oop,
            [0.0; 2],
            0.0,
            0,
            false,
            true,
            "root".to_string(),
        );
        Ok(Self {
            board: spot.board,
            board_mask,
            starting_pot: spot.starting_pot,
            effective_stack: spot.effective_stack,
            tree_config: spot.tree_config,
            combos: [oop, ip],
            hand_ranks: ranks,
            total_valid_weight,
            nodes,
            decision_node_ids,
        })
    }

    pub fn num_decision_nodes(&self) -> usize {
        self.decision_node_ids.len()
    }

    pub fn decision_node(&self, decision_id: usize) -> &DecisionNode {
        match &self.nodes[self.decision_node_ids[decision_id]] {
            Node::Decision(node) => node,
            Node::Terminal(_) => unreachable!(),
        }
    }
}

/// Legal no-limit opening sizes, with the effective stack as the only upper bound.
pub fn holdem_bet_sizes(pot: f64, stack: f64, config: &HoldemTreeConfig) -> Vec<(f64, bool)> {
    let mut sizes: Vec<f64> = config
        .bet_sizes
        .iter()
        .filter(|fraction| fraction.is_finite() && **fraction > 0.0)
        .map(|fraction| (fraction * pot).min(stack))
        .filter(|size| *size > CHIP_EPS)
        .collect();
    if config.include_all_in_bet && stack > CHIP_EPS {
        sizes.push(stack);
    }
    normalize_sizes(sizes, stack)
}

/// Legal no-limit raise-to sizes. Short all-ins remain legal below the minimum raise.
pub fn holdem_raise_sizes(
    pot_after_call: f64,
    actor_committed: f64,
    opp_committed: f64,
    last_raise: f64,
    stack: f64,
    raises_so_far: usize,
    config: &HoldemTreeConfig,
) -> Vec<(f64, bool)> {
    if raises_so_far >= config.max_raises || stack <= opp_committed + CHIP_EPS {
        return Vec::new();
    }
    let min_raise_to = opp_committed + last_raise.max(opp_committed - actor_committed);
    let mut sizes: Vec<f64> = config
        .raise_sizes
        .iter()
        .filter(|fraction| fraction.is_finite() && **fraction > 0.0)
        .map(|fraction| (opp_committed + fraction * pot_after_call).min(stack))
        .filter(|size| *size > opp_committed + CHIP_EPS && *size + CHIP_EPS >= min_raise_to)
        .collect();
    if config.include_all_in_raise && stack > opp_committed + CHIP_EPS {
        sizes.push(stack);
    }
    normalize_sizes(sizes, stack)
        .into_iter()
        .filter(|(to, all_in)| *all_in || *to + CHIP_EPS >= min_raise_to)
        .collect()
}

fn normalize_sizes(mut sizes: Vec<f64>, stack: f64) -> Vec<(f64, bool)> {
    sizes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut result: Vec<(f64, bool)> = Vec::new();
    for size in sizes {
        let all_in = (size - stack).abs() <= CHIP_EPS;
        if let Some((last, was_all_in)) = result.last_mut() {
            if (size - *last).abs() <= CHIP_EPS {
                *was_all_in |= all_in;
                if all_in {
                    *last = stack;
                }
                continue;
            }
        }
        result.push((if all_in { stack } else { size }, all_in));
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn build_tree(
    nodes: &mut Vec<Node>,
    decision_node_ids: &mut Vec<NodeId>,
    pot: f64,
    stack: f64,
    config: &HoldemTreeConfig,
    player: Player,
    committed: [f64; 2],
    last_raise: f64,
    raises_so_far: usize,
    oop_checked: bool,
    raise_allowed: bool,
    history: String,
) -> NodeId {
    let p = player.index();
    let q = player.opponent().index();
    let actor = committed[p];
    let opponent = committed[q];
    let to_call = (opponent - actor).max(0.0);
    let current_pot = pot + committed[0] + committed[1];
    let mut actions = Vec::new();
    if to_call <= CHIP_EPS {
        actions.push(Action::Check);
        actions.extend(
            holdem_bet_sizes(current_pot, stack, config)
                .into_iter()
                .map(|(to, is_all_in)| Action::Bet { to, is_all_in }),
        );
    } else {
        actions.push(Action::Fold);
        actions.push(Action::Call {
            to: opponent,
            call_amount: to_call,
        });
        if raise_allowed {
            actions.extend(
                holdem_raise_sizes(
                    current_pot + to_call,
                    actor,
                    opponent,
                    last_raise,
                    stack,
                    raises_so_far,
                    config,
                )
                .into_iter()
                .map(|(to, is_all_in)| Action::Raise {
                    to,
                    raise_by: to - opponent,
                    is_all_in,
                }),
            );
        }
    }
    let node_id = nodes.len();
    let decision_id = decision_node_ids.len();
    decision_node_ids.push(node_id);
    nodes.push(Node::Decision(DecisionNode {
        node_id,
        decision_id,
        player,
        history: history.clone(),
        committed,
        current_pot,
        to_call,
        raises_so_far,
        actions: actions.clone(),
        children: Vec::new(),
    }));

    let mut children = Vec::new();
    for action in &actions {
        let child_history = if history == "root" {
            action.history_token()
        } else {
            format!("{history}/{}", action.history_token())
        };
        let child = match *action {
            Action::Check if player == Player::Oop && !oop_checked => build_tree(
                nodes,
                decision_node_ids,
                pot,
                stack,
                config,
                Player::Ip,
                committed,
                0.0,
                0,
                true,
                true,
                child_history,
            ),
            Action::Check => push_terminal(nodes, TerminalNode::Showdown { committed }),
            Action::Fold => push_terminal(
                nodes,
                TerminalNode::Fold {
                    folder: player,
                    committed,
                },
            ),
            Action::Call { to, .. } => {
                let mut next = committed;
                next[p] = to;
                push_terminal(nodes, TerminalNode::Showdown { committed: next })
            }
            Action::Bet { to, .. } => {
                let mut next = committed;
                next[p] = to;
                build_tree(
                    nodes,
                    decision_node_ids,
                    pot,
                    stack,
                    config,
                    player.opponent(),
                    next,
                    to - actor,
                    0,
                    false,
                    true,
                    child_history,
                )
            }
            Action::Raise { to, raise_by, .. } => {
                let mut next = committed;
                next[p] = to;
                build_tree(
                    nodes,
                    decision_node_ids,
                    pot,
                    stack,
                    config,
                    player.opponent(),
                    next,
                    raise_by,
                    raises_so_far + 1,
                    false,
                    raise_by + CHIP_EPS >= last_raise,
                    child_history,
                )
            }
        };
        children.push(child);
    }
    if let Node::Decision(decision) = &mut nodes[node_id] {
        decision.children = children;
    }
    node_id
}

fn push_terminal(nodes: &mut Vec<Node>, terminal: TerminalNode) -> NodeId {
    let id = nodes.len();
    nodes.push(Node::Terminal(terminal));
    id
}

/// Average-strategy result of a Hold'em river solve.
#[derive(Clone, Debug)]
pub struct HoldemSolveResult {
    pub strategies: Vec<NodeStrategy>,
    pub iterations: usize,
    pub exploitability: ExploitabilityReport,
}

struct Kernel {
    offsets: Vec<[usize; 4]>,
    opponents: Vec<u32>,
}

impl Kernel {
    fn new(game: &HoldemGame, player: Player) -> Self {
        let p = player.index();
        let q = player.opponent().index();
        let mut offsets = Vec::with_capacity(game.combos[p].len());
        let mut opponents = Vec::new();
        for (i, own) in game.combos[p].iter().enumerate() {
            let mut wins = Vec::new();
            let mut ties = Vec::new();
            let mut losses = Vec::new();
            for (j, other) in game.combos[q].iter().enumerate() {
                if own.mask.overlaps(other.mask) {
                    continue;
                }
                match game.hand_ranks[p][i].cmp(&game.hand_ranks[q][j]) {
                    Ordering::Greater => wins.push(j as u32),
                    Ordering::Equal => ties.push(j as u32),
                    Ordering::Less => losses.push(j as u32),
                }
            }
            let start = opponents.len();
            opponents.extend(wins);
            let tie_start = opponents.len();
            opponents.extend(ties);
            let loss_start = opponents.len();
            opponents.extend(losses);
            let end = opponents.len();
            offsets.push([start, tie_start, loss_start, end]);
        }
        Self { offsets, opponents }
    }

    fn fold(&self, reach: &[f64], payoff: f64, out: &mut [f64]) {
        for (i, [start, _, _, end]) in self.offsets.iter().copied().enumerate() {
            out[i] = self.opponents[start..end]
                .iter()
                .map(|&j| reach[j as usize])
                .sum::<f64>()
                * payoff;
        }
    }

    fn showdown(&self, reach: &[f64], win: f64, tie: f64, loss: f64, out: &mut [f64]) {
        for (i, [start, tie_start, loss_start, end]) in self.offsets.iter().copied().enumerate() {
            let sum = |from: usize, to: usize| {
                self.opponents[from..to]
                    .iter()
                    .map(|&j| reach[j as usize])
                    .sum::<f64>()
            };
            out[i] = win * sum(start, tie_start)
                + tie * sum(tie_start, loss_start)
                + loss * sum(loss_start, end);
        }
    }
}

struct Buffer {
    player: Player,
    actions: usize,
    combos: usize,
    regrets: Vec<f64>,
    strategy_sum: Vec<f64>,
    strategy: Vec<f64>,
}

impl Buffer {
    fn new(player: Player, actions: usize, combos: usize) -> Self {
        let count = actions * combos;
        Self {
            player,
            actions,
            combos,
            regrets: vec![0.0; count],
            strategy_sum: vec![0.0; count],
            strategy: vec![1.0 / actions as f64; count],
        }
    }

    fn regret_match(&mut self) {
        for i in 0..self.combos {
            let base = i * self.actions;
            let positive: f64 = self.regrets[base..base + self.actions]
                .iter()
                .map(|regret| regret.max(0.0))
                .sum();
            if positive > 0.0 {
                for a in 0..self.actions {
                    self.strategy[base + a] = self.regrets[base + a].max(0.0) / positive;
                }
            } else {
                self.strategy[base..base + self.actions].fill(1.0 / self.actions as f64);
            }
        }
    }

    fn extract(&self, game: &HoldemGame, decision_id: usize) -> NodeStrategy {
        let decision = game.decision_node(decision_id);
        let mut frequencies = vec![0.0; self.strategy_sum.len()];
        for i in 0..self.combos {
            let base = i * self.actions;
            let sum: f64 = self.strategy_sum[base..base + self.actions].iter().sum();
            if sum > 0.0 {
                for a in 0..self.actions {
                    frequencies[base + a] = self.strategy_sum[base + a] / sum;
                }
            } else {
                frequencies[base..base + self.actions]
                    .copy_from_slice(&self.strategy[base..base + self.actions]);
            }
        }
        NodeStrategy {
            decision_id,
            node_id: decision.node_id,
            player: decision.player,
            history: decision.history.clone(),
            actions: decision.actions.clone(),
            num_combos: self.combos,
            frequencies,
        }
    }
}

/// Solves a Hold'em river game using alternating Discounted CFR.
pub fn solve_holdem_river(game: &HoldemGame, config: &DcfrConfig) -> HoldemSolveResult {
    let kernels = [
        Kernel::new(game, Player::Oop),
        Kernel::new(game, Player::Ip),
    ];
    let mut buffers: Vec<Buffer> = (0..game.num_decision_nodes())
        .map(|id| {
            let node = game.decision_node(id);
            Buffer::new(
                node.player,
                node.actions.len(),
                game.combos[node.player.index()].len(),
            )
        })
        .collect();
    let reaches = [
        game.combos[0]
            .iter()
            .map(|combo| combo.weight)
            .collect::<Vec<_>>(),
        game.combos[1]
            .iter()
            .map(|combo| combo.weight)
            .collect::<Vec<_>>(),
    ];

    let mut iterations = 0;
    let mut final_report = None;
    for iteration in 1..=config.max_iterations {
        iterations = iteration;
        let t = iteration as f64;
        let positive_discount = t.powf(config.alpha) / (t.powf(config.alpha) + 1.0);
        let negative_discount = if config.beta == 0.0 {
            1.0
        } else {
            let t_beta = t.powf(config.beta);
            t_beta / (t_beta + 1.0)
        };
        let strategy_weight = t.powf(config.gamma);
        for player in [Player::Oop, Player::Ip] {
            for buffer in &mut buffers {
                if buffer.player == player {
                    buffer.regret_match();
                }
            }
            holdem_cfr_traverse(
                game,
                &kernels[player.index()],
                &mut buffers,
                0,
                player,
                &reaches[player.index()],
                &reaches[player.opponent().index()],
                positive_discount,
                negative_discount,
                strategy_weight,
            );
        }
        if config.target_exploitability_pct > 0.0
            && config.check_interval > 0
            && (iteration % config.check_interval == 0 || iteration == config.max_iterations)
        {
            let strategies: Vec<_> = (0..game.num_decision_nodes())
                .map(|id| buffers[id].extract(game, id))
                .collect();
            let report = crate::holdem_br::compute_holdem_exploitability(game, &strategies);
            if report.nash_distance_pct <= config.target_exploitability_pct {
                final_report = Some(report);
                break;
            } else if iteration == config.max_iterations {
                final_report = Some(report);
            }
        }
    }
    let strategies: Vec<NodeStrategy> = (0..game.num_decision_nodes())
        .map(|id| buffers[id].extract(game, id))
        .collect();
    let exploitability = final_report
        .unwrap_or_else(|| crate::holdem_br::compute_holdem_exploitability(game, &strategies));
    HoldemSolveResult {
        strategies,
        iterations,
        exploitability,
    }
}

#[allow(clippy::too_many_arguments)]
fn holdem_cfr_traverse(
    game: &HoldemGame,
    kernel: &Kernel,
    buffers: &mut [Buffer],
    node_id: NodeId,
    traverser: Player,
    my_reach: &[f64],
    opp_reach: &[f64],
    positive_discount: f64,
    negative_discount: f64,
    strategy_weight: f64,
) -> Vec<f64> {
    let p = traverser.index();
    let q = traverser.opponent().index();
    match &game.nodes[node_id] {
        Node::Terminal(terminal) => {
            let mut values = vec![0.0; game.combos[p].len()];
            match *terminal {
                TerminalNode::Fold { folder, committed } => {
                    let payoff = if folder == traverser {
                        -committed[p]
                    } else {
                        game.starting_pot + committed[q]
                    };
                    kernel.fold(opp_reach, payoff, &mut values);
                }
                TerminalNode::Showdown { committed } => kernel.showdown(
                    opp_reach,
                    game.starting_pot + committed[q],
                    game.starting_pot * 0.5,
                    -committed[p],
                    &mut values,
                ),
            }
            values
        }
        Node::Decision(decision) => {
            let did = decision.decision_id;
            let num_actions = decision.actions.len();
            if decision.player == traverser {
                let strategy = buffers[did].strategy.clone();
                for i in 0..game.combos[p].len() {
                    let reach = strategy_weight * my_reach[i];
                    for a in 0..num_actions {
                        buffers[did].strategy_sum[i * num_actions + a] +=
                            reach * strategy[i * num_actions + a];
                    }
                }

                let mut action_values = Vec::with_capacity(num_actions);
                let mut node_values = vec![0.0; game.combos[p].len()];
                let mut next_reach = vec![0.0; game.combos[p].len()];
                for a in 0..num_actions {
                    for i in 0..next_reach.len() {
                        next_reach[i] = my_reach[i] * strategy[i * num_actions + a];
                    }
                    let values = holdem_cfr_traverse(
                        game,
                        kernel,
                        buffers,
                        decision.children[a],
                        traverser,
                        &next_reach,
                        opp_reach,
                        positive_discount,
                        negative_discount,
                        strategy_weight,
                    );
                    for i in 0..node_values.len() {
                        node_values[i] += strategy[i * num_actions + a] * values[i];
                    }
                    action_values.push(values);
                }
                let regrets = &mut buffers[did].regrets;
                for i in 0..node_values.len() {
                    for a in 0..num_actions {
                        let index = i * num_actions + a;
                        let updated = regrets[index] + action_values[a][i] - node_values[i];
                        regrets[index] = if updated >= 0.0 {
                            updated * positive_discount
                        } else {
                            updated * negative_discount
                        };
                    }
                }
                node_values
            } else {
                let strategy = buffers[did].strategy.clone();
                let mut node_values = vec![0.0; game.combos[p].len()];
                let mut next_reach = vec![0.0; game.combos[q].len()];
                for a in 0..num_actions {
                    let mut any_reach = false;
                    for j in 0..next_reach.len() {
                        next_reach[j] = opp_reach[j] * strategy[j * num_actions + a];
                        any_reach |= next_reach[j] > 0.0;
                    }
                    if any_reach {
                        let values = holdem_cfr_traverse(
                            game,
                            kernel,
                            buffers,
                            decision.children[a],
                            traverser,
                            my_reach,
                            &next_reach,
                            positive_discount,
                            negative_discount,
                            strategy_weight,
                        );
                        for i in 0..node_values.len() {
                            node_values[i] += values[i];
                        }
                    }
                }
                node_values
            }
        }
    }
}
