#!/usr/bin/env python3
"""Build the PLO library spot catalog from the plan taxonomy and range data.

Standard library only.  The script encodes the taxonomy from
``library-plan-2026-11-07.md``; it does not parse the prose plan.  Range
coverage is computed from the emitted preflop set documents plus the class
table's combo multiplicities.

Coverage convention (the brief's literal individual-combo convention):
all concrete combos in a hand class inherit that class's action frequency.
Combos are ranked by that frequency; classes are consumed in that order and
the boundary class may be consumed partially so exactly ``cap`` concrete
combos are kept (unless the action has fewer positive-frequency combos).
Coverage is kept combo weight divided by total action combo weight.  It is
not conditioned on board-card removal: the plan assigns that to the solver.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


ROOT = Path(__file__).resolve().parents[1]
TOTAL_COMBOS = 270_725
CAPS = {"flop": 300, "turn": 600, "river": 1_500}

GROUP_BTN_BB = "SRP BTN vs BB"
GROUP_CO_MP_BB = "SRP CO vs BB, MP vs BB"
GROUP_SB_BB = "SRP SB vs BB"
GROUP_3BET = "3-bet pots"
GROUP_LATE = "Single-raise late-position"
GROUP_DEEP = "Turn/river deep-dives on canonical boards"
GROUP_9MAX = "9max SRP (UTG/MP opens vs BB)"

EXPECTED_GROUP_COUNTS = {
    GROUP_BTN_BB: 60,
    GROUP_CO_MP_BB: 40,
    GROUP_SB_BB: 24,
    GROUP_3BET: 60,
    GROUP_LATE: 16,
    GROUP_DEEP: 60,
    GROUP_9MAX: 40,
}
EXPECTED_STREET_COUNTS = {"flop": 86, "turn": 104, "river": 110}


@dataclass(frozen=True)
class BoardSeed:
    family: str
    flop: tuple[str, str, str]
    double_paired: bool = False


@dataclass(frozen=True)
class RangeSide:
    set_id: Optional[str]
    action: str


@dataclass(frozen=True)
class Pair:
    key: str
    table_size: str
    matchup_slug: str
    matchup: str
    oop_position: str
    ip_position: str
    oop: RangeSide
    ip: RangeSide
    pot_type: str = "srp"
    missing_reason: Optional[str] = None


# Two flop representatives per family.  A three-card flop cannot literally be
# double-paired (that requires four board cards), so the double-paired family
# is represented by paired seeds whose standard turn card pairs the kicker;
# it is used only for turn/river roots.  See CATALOG-NOTES.md.
BOARD_SEEDS = [
    BoardSeed("dry A-high rainbow", ("As", "Kd", "7c")),
    BoardSeed("dry A-high rainbow", ("Ah", "Qd", "4c")),
    BoardSeed("broadway connected", ("Qs", "Jd", "Tc")),
    BoardSeed("broadway connected", ("Ks", "Qh", "Jd")),
    BoardSeed("middle connected", ("9s", "8d", "7c")),
    BoardSeed("middle connected", ("Ts", "9h", "8d")),
    BoardSeed("low connected", ("6s", "5d", "4c")),
    BoardSeed("low connected", ("5s", "4h", "3d")),
    BoardSeed("paired high", ("As", "Ad", "Kc")),
    BoardSeed("paired high", ("Ks", "Kh", "Qd")),
    BoardSeed("paired low", ("7s", "7d", "2c")),
    BoardSeed("paired low", ("5s", "5h", "3d")),
    BoardSeed("trips", ("As", "Ad", "Ac")),
    BoardSeed("trips", ("8s", "8d", "8c")),
    BoardSeed("monotone", ("As", "Ks", "7s")),
    BoardSeed("monotone", ("Qh", "Jh", "4h")),
    BoardSeed("two-tone flush-draw", ("As", "Ks", "7d")),
    BoardSeed("two-tone flush-draw", ("Qh", "Jh", "4d")),
    BoardSeed("wet draw-heavy", ("Js", "Ts", "8d")),
    BoardSeed("wet draw-heavy", ("9h", "8h", "6d")),
    BoardSeed("dry K/Q-high", ("Ks", "8d", "3c")),
    BoardSeed("dry K/Q-high", ("Qs", "9d", "4c")),
    BoardSeed("low dry", ("8s", "5d", "2c")),
    BoardSeed("low dry", ("7s", "4d", "2c")),
    BoardSeed("wheel-heavy", ("As", "4d", "3c")),
    BoardSeed("wheel-heavy", ("Ah", "5d", "2c")),
    BoardSeed("double-paired", ("As", "Ad", "Ks"), double_paired=True),
    BoardSeed("double-paired", ("Qs", "Qd", "Js"), double_paired=True),
]

_RANK_VALUE = {
    "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
    "T": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
}
_RANKS_ASC = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]
_SUITS = ["s", "h", "d", "c"]


def _ranks_adjacent(a: str, b: str) -> bool:
    av, bv = _RANK_VALUE[a], _RANK_VALUE[b]
    return abs(av - bv) == 1 or {av, bv} == {2, 14}


def _blank_cards(board: Iterable[str], count: int) -> list[str]:
    """Choose deterministic low-impact runouts.

    A candidate rank may not already be on the board and may not be adjacent
    to any board rank (ace is adjacent to both king and deuce).  This keeps a
    flop family's defining texture from being casually overwritten by the
    catalog's standard runout.  Suits are scanned s/h/d/c for determinism.
    """
    board = tuple(board)
    board_ranks = {card[0] for card in board}
    out: list[str] = []
    for rank in _RANKS_ASC:
        if rank in board_ranks:
            continue
        if any(_ranks_adjacent(rank, board_rank) for board_rank in board_ranks):
            continue
        for suit in _SUITS:
            card = f"{rank}{suit}"
            if card not in board:
                out.append(card)
                break
        if len(out) == count:
            return out
    raise ValueError(f"Could not choose {count} blank runouts for {board}")


def _turn_card(seed: BoardSeed) -> str:
    if seed.double_paired:
        # Pair the unpaired kicker rank, using the first suit not in the seed.
        rank = seed.flop[2][0]
        used_suits = {card[1] for card in seed.flop}
        suit = next(s for s in _SUITS if s not in used_suits)
        return f"{rank}{suit}"
    return _blank_cards(seed.flop, 1)[0]


def _river_card(seed: BoardSeed) -> str:
    board4 = seed.flop + (_turn_card(seed),)
    return _blank_cards(board4, 1)[0]


def board_for_seed(seed: BoardSeed, street: str) -> tuple[str, ...]:
    if street == "flop":
        if seed.double_paired:
            raise ValueError("A double-paired family has no three-card flop")
        return seed.flop
    if street == "turn":
        return seed.flop + (_turn_card(seed),)
    if street == "river":
        return seed.flop + (_turn_card(seed), _river_card(seed))
    raise ValueError(street)


def seed_at(start: int, offset: int, street: str) -> BoardSeed:
    eligible = [s for s in BOARD_SEEDS if street != "flop" or not s.double_paired]
    return eligible[(start + offset) % len(eligible)]


def _set(table: str, slug: str) -> str:
    return f"constructed-v1-{table}-{slug}"


def _pair(
    key: str,
    table: str,
    matchup_slug: str,
    matchup: str,
    oop_position: str,
    ip_position: str,
    oop_set: Optional[str],
    oop_action: str,
    ip_set: Optional[str],
    ip_action: str,
    pot_type: str = "srp",
    missing_reason: Optional[str] = None,
) -> Pair:
    return Pair(
        key=key,
        table_size=table,
        matchup_slug=matchup_slug,
        matchup=matchup,
        oop_position=oop_position,
        ip_position=ip_position,
        oop=RangeSide(oop_set, oop_action),
        ip=RangeSide(ip_set, ip_action),
        pot_type=pot_type,
        missing_reason=missing_reason,
    )


def _srp_open_call(
    key: str,
    table: str,
    opener: str,
    opener_slug: str,
    responder: str,
    responder_slug: str,
    *,
    responder_first: bool = True,
) -> Pair:
    """Build a single-raised-pot pair from an RFI set and a vs-RFI call set."""
    opener_side = RangeSide(_set(table, f"{opener_slug}-rfi"), "raise")
    responder_side = RangeSide(
        _set(table, f"{responder_slug}-vs-{opener_slug}"), "call"
    )
    if responder_first:
        # The responder is OOP (all BB/SB-defence pairs in this helper).
        return _pair(
            key, table, f"{opener_slug}-vs-{responder_slug}", 
            f"{opener} opens, {responder} calls",
            responder, opener, responder_side.set_id, responder_side.action,
            opener_side.set_id, opener_side.action,
        )
    return _pair(
        key, table, f"{opener_slug}-vs-{responder_slug}",
        f"{opener} opens, {responder} calls",
        opener, responder, opener_side.set_id, opener_side.action,
        responder_side.set_id, responder_side.action,
    )


PAIRS: dict[str, Pair] = {}


def _register(pair: Pair) -> Pair:
    PAIRS[pair.key] = pair
    return pair


# 6-max SRP pairs.
_register(_srp_open_call("6-btn-bb", "6max", "BTN", "btn", "BB", "bb"))
_register(_srp_open_call("6-co-bb", "6max", "CO", "co", "BB", "bb"))
_register(_srp_open_call("6-mp-bb", "6max", "MP", "mp", "BB", "bb"))
_register(
    _pair(
        "6-sb-bb", "6max", "sb-vs-bb", "SB opens, BB calls", "SB", "BB",
        _set("6max", "sb-sbplay"), "raise",
        _set("6max", "bb-vs-sb"), "call",
    )
)
_register(_srp_open_call(
    "6-co-btn-call", "6max", "CO", "co", "BTN", "btn", responder_first=False
))
_register(_srp_open_call(
    "6-mp-btn-call", "6max", "MP", "mp", "BTN", "btn", responder_first=False
))
_register(_srp_open_call("6-btn-sb-call", "6max", "BTN", "btn", "SB", "sb"))

# 9-max SRP pairs.  The plan's "UTG/MP" wording is interpreted over the actual
# 9-max seats for which v1 has both sides: UTG, UTG+1, UTG+2, LJ and HJ.
for key, opener, slug in [
    ("9-utg-bb", "UTG", "utg"),
    ("9-utgplus1-bb", "UTG+1", "utgplus1"),
    ("9-utgplus2-bb", "UTG+2", "utgplus2"),
    ("9-lj-bb", "LJ", "lj"),
    ("9-hj-bb", "HJ", "hj"),
    ("9-co-bb", "CO", "co"),
    ("9-btn-bb", "BTN", "btn"),
]:
    _register(_srp_open_call(key, "9max", opener, slug, "BB", "bb"))
_register(
    _pair(
        "9-sb-bb", "9max", "sb-vs-bb", "SB opens, BB calls", "SB", "BB",
        _set("9max", "sb-sbplay"), "raise",
        _set("9max", "bb-vs-sb"), "call",
    )
)
_register(_srp_open_call(
    "9-hj-btn-call", "9max", "HJ", "hj", "BTN", "btn", responder_first=False
))
_register(_srp_open_call(
    "9-co-btn-call", "9max", "CO", "co", "BTN", "btn", responder_first=False
))

# 3-bet-pot pairs.  The 3-bettor's three_bet slice exists inside a vs_rfi set,
# but v1 has no set for the opener's continuation against that 3-bet.  The RFI
# set is deliberately not substituted for that missing continuation.
_register(
    _pair(
        "6-btn-bb-3bet", "6max", "btn-vs-bb-3bet",
        "BTN opens, BB 3-bets, BTN continues", "BB", "BTN",
        _set("6max", "bb-vs-btn"), "three_bet",
        None, "call_vs_3bet", pot_type="3bet",
        missing_reason=(
            "No v1 range set contains BTN's continuation against a BB 3-bet; "
            "BTN's RFI set is not a call-vs-3-bet range and was not substituted."
        ),
    )
)
_register(
    _pair(
        "6-btn-sb-3bet", "6max", "btn-vs-sb-3bet",
        "BTN opens, SB 3-bets, BTN continues", "SB", "BTN",
        _set("6max", "sb-vs-btn"), "three_bet",
        None, "call_vs_3bet", pot_type="3bet",
        missing_reason=(
            "No v1 range set contains BTN's continuation against an SB 3-bet; "
            "BTN's RFI set is not a call-vs-3-bet range and was not substituted."
        ),
    )
)
_register(
    _pair(
        "6-co-btn-3bet", "6max", "co-vs-btn-3bet",
        "CO opens, BTN 3-bets, CO continues", "CO", "BTN",
        None, "call_vs_3bet",
        _set("6max", "btn-vs-co"), "three_bet", pot_type="3bet",
        missing_reason=(
            "No v1 range set contains CO's continuation against a BTN 3-bet; "
            "CO's RFI set is not a call-vs-3-bet range and was not substituted."
        ),
    )
)

DEEP_PAIR_KEYS = [
    "6-btn-bb", "6-co-bb", "6-mp-bb", "6-sb-bb", "6-co-btn-call",
    "6-mp-btn-call", "6-btn-sb-call", "9-utg-bb", "9-utgplus1-bb",
    "9-utgplus2-bb", "9-lj-bb", "9-hj-bb", "9-co-bb", "9-btn-bb",
    "9-sb-bb", "9-hj-btn-call", "9-co-btn-call",
]


class RangeData:
    def __init__(self, preflop_dir: Path):
        self.preflop_dir = preflop_dir
        self.index = json.loads((preflop_dir / "index.json").read_text())
        self.index_by_id = {entry["id"]: entry for entry in self.index["rangesets"]}
        class_table = json.loads((preflop_dir / "class-table.json").read_text())
        if class_table["class_count"] != 16_432 or class_table["total_combos"] != TOTAL_COMBOS:
            raise ValueError("Unexpected class-table totals")
        self.multiplicity = {
            row["hand"]: int(row["multiplicity"]) for row in class_table["classes"]
        }
        if len(self.multiplicity) != 16_432:
            raise ValueError("Class table does not contain 16,432 classes")
        if sum(self.multiplicity.values()) != TOTAL_COMBOS:
            raise ValueError("Class-table multiplicities do not sum to 270,725")
        self.sets: dict[str, dict] = {}
        for entry in self.index["rangesets"]:
            doc = json.loads((preflop_dir / entry["path"]).read_text())
            if doc["id"] != entry["id"]:
                raise ValueError(f"Set id mismatch for {entry['id']}")
            if set(doc["hands"]) != set(self.multiplicity):
                raise ValueError(f"Set {entry['id']} does not use the class-table keys")
            self.sets[entry["id"]] = doc
        self._coverage_cache: dict[tuple[str, str, int], dict] = {}

    def coverage(self, set_id: str, action: str, cap: int) -> dict:
        key = (set_id, action, cap)
        if key in self._coverage_cache:
            return self._coverage_cache[key]
        doc = self.sets[set_id]
        rows: list[tuple[float, int, str]] = []
        total_weight = 0.0
        action_combos = 0
        for hand, actions in doc["hands"].items():
            freq = float(actions.get(action, 0.0))
            if freq > 0:
                mult = self.multiplicity[hand]
                rows.append((freq, mult, hand))
                total_weight += freq * mult
                action_combos += mult
        if total_weight <= 0:
            raise ValueError(f"Set {set_id} has no positive {action} weight")
        rows.sort(key=lambda row: (-row[0], row[2]))
        remaining = cap
        kept_weight = 0.0
        kept_combos = 0
        for freq, mult, _hand in rows:
            if remaining == 0:
                break
            take = min(mult, remaining)
            kept_weight += freq * take
            kept_combos += take
            remaining -= take
        result = {
            "coverage_pct": round(100.0 * kept_weight / total_weight, 4),
            "kept_combos": kept_combos,
            "action_combos": action_combos,
            "action_weight": round(total_weight, 4),
        }
        self._coverage_cache[key] = result
        return result


def size_menu(street: str) -> dict:
    flop = {
        "bet_sizes": [0.33, 0.75],
        "raise_sizes": [1.0],
        "include_all_in": True,
    }
    turn = {
        "bet_sizes": [0.5, 0.75],
        "raise_sizes": [1.0],
        "include_all_in": True,
    }
    river = {
        "bet_sizes": [0.75],
        "raise_sizes": [1.0],
        "include_all_in": True,
    }
    if street == "flop":
        return {"flop": flop, "turn": turn, "river": river}
    if street == "turn":
        return {"turn": turn, "river": river}
    if street == "river":
        return {"river": river}
    raise ValueError(street)


def root_state(pair: Pair, street: str, deep_dive: bool) -> tuple[float, float, float]:
    """Return (pot_chips, stacks_chips, SPR) at the solve root.

    Catalog normalization: each side has 100 chips behind at the flop root.
    SRP flop pot is 10 chips (SPR 10, inside the plan's ~8-12); 3-bet flop
    pot is 30 chips (SPR 3.333, inside the plan's ~3-4).  Later-street roots
    apply the declared standard line's bet/call or check/check exactly.
    """
    if pair.pot_type == "srp":
        pot, stacks = 10.0, 100.0
    elif pair.pot_type == "3bet":
        pot, stacks = 30.0, 100.0
    else:
        raise ValueError(pair.pot_type)

    if street == "flop":
        pass
    elif not deep_dive:
        # Primary subtree line: IP bets 33% of the flop pot and OOP calls;
        # river roots then check through the turn, so turn and river roots
        # have the same pot/stacks under this standard line.
        bet = 0.33 * pot
        pot += 2 * bet
        stacks -= bet
    elif street == "river":
        # Deep-dive river line: flop checks through, then IP bets 50% of
        # the turn pot and OOP calls.
        bet = 0.50 * pot
        pot += 2 * bet
        stacks -= bet
    # Deep-dive turn roots check through the flop: base pot/stacks stand.
    pot = round(pot, 4)
    stacks = round(stacks, 4)
    return pot, stacks, round(stacks / pot, 4)


def standard_line(board: tuple[str, ...], street: str, deep_dive: bool) -> Optional[str]:
    if street == "flop":
        return None
    turn_card = board[3]
    if deep_dive:
        if street == "turn":
            return f"flop: OOP check; IP check; turn: {turn_card}"
        river_card = board[4]
        return (
            f"flop: OOP check; IP check; turn: {turn_card}; "
            f"turn: OOP check; IP bet 50% of pot; OOP call; river: {river_card}"
        )
    if street == "turn":
        return (
            f"flop: OOP check; IP bet 33% of pot; OOP call; turn: {turn_card}"
        )
    river_card = board[4]
    return (
        f"flop: OOP check; IP bet 33% of pot; OOP call; turn: {turn_card}; "
        f"turn: OOP check; IP check; river: {river_card}"
    )


def estimate(street: str) -> dict:
    if street == "flop":
        return {
            "minimum": 5.0,
            "maximum": 9.0,
            "unit": "core-hours",
            "label": "estimate",
            "basis": "Library plan compute budget: flop solves at ~5-9 single-core hours each.",
        }
    return {
        "minimum": None,
        "maximum": None,
        "unit": "core-hours",
        "label": "estimate_not_allocated_per_entry",
        "basis": (
            "Library plan gives only an aggregate for turn/river solves "
            "(216 solves, minutes each, under 40 core-hours total) and does "
            "not allocate a defensible per-entry range."
        ),
    }


def _slug_cards(board: Iterable[str]) -> str:
    return "-".join(card.lower() for card in board)


def make_entry(
    data: RangeData,
    *,
    group: str,
    pair: Pair,
    street: str,
    seed: BoardSeed,
    deep_dive: bool = False,
) -> dict:
    board = board_for_seed(seed, street)
    cap = CAPS[street]
    pot, stacks, spr = root_state(pair, street, deep_dive)

    def side_result(side: RangeSide) -> tuple[Optional[float], Optional[int], Optional[int]]:
        if side.set_id is None:
            return None, None, None
        result = data.coverage(side.set_id, side.action, cap)
        return result["coverage_pct"], result["kept_combos"], result["action_combos"]

    oop_cov, oop_kept, oop_action_combos = side_result(pair.oop)
    ip_cov, ip_kept, ip_action_combos = side_result(pair.ip)
    needs_range = pair.oop.set_id is None or pair.ip.set_id is None
    prefix = "deep-dive-" if deep_dive else ""
    entry = {
        "id": (
            f"{prefix}{pair.table_size}-{pair.matchup_slug}-"
            f"{_slug_cards(board)}-{street}"
        ),
        "group": group,
        "table_size": pair.table_size,
        "matchup": pair.matchup,
        "oop_position": pair.oop_position,
        "ip_position": pair.ip_position,
        "oop_set": pair.oop.set_id,
        "ip_set": pair.ip.set_id,
        "range_action_oop": pair.oop.action,
        "range_action_ip": pair.ip.action,
        "board": " ".join(board),
        "board_family": seed.family,
        "board_seed": " ".join(seed.flop),
        "street": street,
        "line": standard_line(board, street, deep_dive),
        "pot_type": pair.pot_type,
        "spr": spr,
        "pot_chips": pot,
        "stacks_chips": stacks,
        "size_menu": size_menu(street),
        "cap_per_side": cap,
        "capped_combos_oop": oop_kept,
        "capped_combos_ip": ip_kept,
        "source_action_combos_oop": oop_action_combos,
        "source_action_combos_ip": ip_action_combos,
        "coverage_oop_pct": oop_cov,
        "coverage_ip_pct": ip_cov,
        "tier": "precise" if street == "river" else "balanced",
        "est_core_hours": estimate(street),
        "status": "needs-range" if needs_range else "ready",
        "status_reason": pair.missing_reason if needs_range else None,
    }
    return entry


def build_catalog(data: RangeData) -> dict:
    entries: list[dict] = []

    def add(
        group: str,
        pair_key: str,
        street: str,
        count: int,
        seed_start: int,
    ) -> None:
        pair = PAIRS[pair_key]
        for i in range(count):
            entries.append(
                make_entry(
                    data,
                    group=group,
                    pair=pair,
                    street=street,
                    seed=seed_at(seed_start, i, street),
                )
            )

    # SRP BTN vs BB: the plan fixes 24 flop / 18 turn / 18 river.
    add(GROUP_BTN_BB, "6-btn-bb", "flop", 24, 0)
    add(GROUP_BTN_BB, "6-btn-bb", "turn", 18, 0)
    add(GROUP_BTN_BB, "6-btn-bb", "river", 18, 0)

    # SRP CO/MP vs BB: 20 per matchup, flop-weighted (9/5/6).
    for pair_key, start in [("6-co-bb", 15), ("6-mp-bb", 22)]:
        add(GROUP_CO_MP_BB, pair_key, "flop", 9, start)
        add(GROUP_CO_MP_BB, pair_key, "turn", 5, start)
        add(GROUP_CO_MP_BB, pair_key, "river", 6, start)

    # SRP SB vs BB: an even mixed split (8/8/8).
    add(GROUP_SB_BB, "6-sb-bb", "flop", 8, 17)
    add(GROUP_SB_BB, "6-sb-bb", "turn", 8, 17)
    add(GROUP_SB_BB, "6-sb-bb", "river", 8, 17)

    # 3-bet pots: 20 per matchup (7/6/7).  All are needs-range in v1 because
    # the opener's call-vs-3-bet continuation set does not exist.
    for pair_key, start in [
        ("6-btn-bb-3bet", 4),
        ("6-btn-sb-3bet", 14),
        ("6-co-btn-3bet", 24),
    ]:
        add(GROUP_3BET, pair_key, "flop", 7, start)
        add(GROUP_3BET, pair_key, "turn", 6, start)
        add(GROUP_3BET, pair_key, "river", 7, start)

    # Single-raise late position: turn/river only.  Pairs are CO open/BTN
    # call, MP open/BTN call, and BTN open/SB call (3/3, 3/3, 2/2).
    for pair_key, turn_start, river_start, turn_count, river_count in [
        ("6-co-btn-call", 2, 9, 3, 3),
        ("6-mp-btn-call", 12, 19, 3, 3),
        ("6-btn-sb-call", 22, 5, 2, 2),
    ]:
        add(GROUP_LATE, pair_key, "turn", turn_count, turn_start)
        add(GROUP_LATE, pair_key, "river", river_count, river_start)

    # Deep dives: 30 turn + 30 river over all ready SRP pairs and the
    # canonical seed cycle, using the deep-dive standard line (flop
    # check/check; river roots add a 50%-pot turn bet/call).
    deep_pairs = [PAIRS[key] for key in DEEP_PAIR_KEYS]
    for street, count, pair_offset, seed_start in [
        ("turn", 30, 0, 0),
        ("river", 30, 7, 11),
    ]:
        for i in range(count):
            entries.append(
                make_entry(
                    data,
                    group=GROUP_DEEP,
                    pair=deep_pairs[(i + pair_offset) % len(deep_pairs)],
                    street=street,
                    seed=seed_at(seed_start, i, street),
                    deep_dive=True,
                )
            )

    # 9-max SRP: four opener pairs x 10.  Three use 4/3/3 and HJ uses
    # 3/3/4, giving the group's 15/12/13 street split.
    for pair_key, start, counts in [
        ("9-utg-bb", 0, (4, 3, 3)),
        ("9-utgplus1-bb", 7, (4, 3, 3)),
        ("9-lj-bb", 14, (4, 3, 3)),
        ("9-hj-bb", 21, (3, 3, 4)),
    ]:
        add(GROUP_9MAX, pair_key, "flop", counts[0], start)
        add(GROUP_9MAX, pair_key, "turn", counts[1], start)
        add(GROUP_9MAX, pair_key, "river", counts[2], start)

    if len(entries) != 300:
        raise ValueError(f"Catalog allocation produced {len(entries)} entries, not 300")
    ids = [entry["id"] for entry in entries]
    if len(ids) != len(set(ids)):
        dupes = [item for item, count in Counter(ids).items() if count > 1]
        raise ValueError(f"Duplicate catalog ids: {dupes[:5]}")

    group_counts = dict(Counter(entry["group"] for entry in entries))
    street_counts = dict(Counter(entry["street"] for entry in entries))
    status_counts = dict(Counter(entry["status"] for entry in entries))
    flop_count = street_counts.get("flop", 0)
    catalog = {
        "schema_version": 1,
        "name": "PLO library spot catalog",
        "generated_by": "tools/build_spot_catalog.py",
        "source_plan": "library-plan-2026-11-07.md (taxonomy encoded in the generator)",
        "source_data": {
            "preflop_index": "data/preflop/index.json",
            "preflop_sets": "data/preflop/sets/*.json",
            "class_table": "data/preflop/class-table.json",
        },
        "coverage_method": (
            "For each side's declared range action, rank hand classes by that "
            "action's frequency, expand classes by class-table multiplicity, "
            "keep exactly cap_per_side concrete combos (the boundary class "
            "may be partial), and divide kept combo weight by total action "
            "combo weight. Coverage is not conditioned on board removal."
        ),
        "estimate_label": "All est_core_hours values are estimates from the library plan, not measurements of these catalog entries.",
        "summary": {
            "entry_count": len(entries),
            "group_counts": group_counts,
            "street_counts": street_counts,
            "status_counts": status_counts,
            "estimated_flop_core_hours": {
                "minimum": flop_count * 5,
                "maximum": flop_count * 9,
                "label": "estimate",
            },
            "estimated_turn_river_core_hours": {
                "maximum": 40,
                "label": "estimate",
                "basis": "Library plan aggregate for 216 turn/river solves; this catalog has 214 turn/river entries, so the plan aggregate is retained as a labelled planning bound rather than re-derived per entry.",
            },
        },
        "entries": entries,
    }
    return catalog


def _coverage_stats(entries: list[dict], street: str) -> dict:
    vals = [
        value
        for entry in entries
        if entry["street"] == street
        for value in (entry["coverage_oop_pct"], entry["coverage_ip_pct"])
        if value is not None
    ]
    return {
        "street": street,
        "sides": len(vals),
        "min_pct": round(min(vals), 4),
        "median_pct": round(statistics.median(vals), 4),
        "max_pct": round(max(vals), 4),
    }


def verify_catalog(catalog: dict, data: RangeData) -> dict:
    entries = catalog["entries"]
    assert len(entries) == 300, f"Expected 300 entries, got {len(entries)}"
    group_counts = Counter(entry["group"] for entry in entries)
    assert dict(group_counts) == EXPECTED_GROUP_COUNTS, dict(group_counts)
    street_counts = Counter(entry["street"] for entry in entries)
    assert dict(street_counts) == EXPECTED_STREET_COUNTS, dict(street_counts)
    ids = [entry["id"] for entry in entries]
    assert len(ids) == len(set(ids)), "Catalog ids are not unique"

    seed_by_flop = {" ".join(seed.flop): seed for seed in BOARD_SEEDS}
    needs_range = 0
    for entry in entries:
        street = entry["street"]
        cards = entry["board"].split()
        expected_cards = {"flop": 3, "turn": 4, "river": 5}[street]
        assert len(cards) == expected_cards, entry["id"]
        assert len(set(cards)) == expected_cards, entry["id"]
        seed = seed_by_flop[entry["board_seed"]]
        assert board_for_seed(seed, street) == tuple(cards), entry["id"]
        assert entry["board_family"] == seed.family, entry["id"]
        assert entry["cap_per_side"] == CAPS[street], entry["id"]
        assert entry["tier"] == ("precise" if street == "river" else "balanced"), entry["id"]
        assert entry["size_menu"] == size_menu(street), entry["id"]
        if street == "flop":
            assert entry["line"] is None, entry["id"]
        else:
            assert entry["line"] and cards[3] in entry["line"], entry["id"]
            if street == "river":
                assert cards[4] in entry["line"], entry["id"]
        pot, stacks, spr = root_state(
            _pair_for_entry(entry), street, entry["group"] == GROUP_DEEP
        )
        assert math.isclose(entry["pot_chips"], pot, abs_tol=1e-9), entry["id"]
        assert math.isclose(entry["stacks_chips"], stacks, abs_tol=1e-9), entry["id"]
        assert math.isclose(entry["spr"], spr, abs_tol=1e-9), entry["id"]

        for side_name, set_key, action_key, cov_key, kept_key, combos_key in [
            ("oop", "oop_set", "range_action_oop", "coverage_oop_pct", "capped_combos_oop", "source_action_combos_oop"),
            ("ip", "ip_set", "range_action_ip", "coverage_ip_pct", "capped_combos_ip", "source_action_combos_ip"),
        ]:
            set_id = entry[set_key]
            if set_id is None:
                assert entry[cov_key] is None and entry[kept_key] is None and entry[combos_key] is None, entry["id"]
                continue
            assert set_id in data.sets, entry["id"]
            recomputed = data.coverage(set_id, entry[action_key], entry["cap_per_side"])
            assert math.isclose(entry[cov_key], recomputed["coverage_pct"], abs_tol=0.00011), (
                entry["id"], side_name, entry[cov_key], recomputed["coverage_pct"]
            )
            assert entry[kept_key] == recomputed["kept_combos"], entry["id"]
            assert entry[combos_key] == recomputed["action_combos"], entry["id"]

        if entry["status"] == "needs-range":
            needs_range += 1
            assert entry["status_reason"], entry["id"]
            assert (entry["oop_set"] is None) != (entry["ip_set"] is None), entry["id"]
        else:
            assert entry["status"] == "ready", entry["id"]
            assert entry["oop_set"] is not None and entry["ip_set"] is not None, entry["id"]
            assert entry["status_reason"] is None, entry["id"]

    assert needs_range == 60, f"Expected 60 needs-range entries, got {needs_range}"
    return {
        "entries": len(entries),
        "group_counts": dict(group_counts),
        "street_counts": dict(street_counts),
        "needs_range": needs_range,
        "coverage": [_coverage_stats(entries, street) for street in ("flop", "turn", "river")],
    }


def _pair_for_entry(entry: dict) -> Pair:
    """Reconstruct the minimal pair needed to verify root-state geometry."""
    return Pair(
        key="verify",
        table_size=entry["table_size"],
        matchup_slug="verify",
        matchup=entry["matchup"],
        oop_position=entry["oop_position"],
        ip_position=entry["ip_position"],
        oop=RangeSide(entry["oop_set"], entry["range_action_oop"]),
        ip=RangeSide(entry["ip_set"], entry["range_action_ip"]),
        pot_type=entry["pot_type"],
        missing_reason=entry["status_reason"],
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "data" / "library" / "spot-catalog.json",
        help="Catalog path to write (or, with --verify, to read).",
    )
    parser.add_argument(
        "--preflop-dir",
        type=Path,
        default=ROOT / "data" / "preflop",
        help="Directory containing index.json, sets/, and class-table.json.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Re-read --out and assert counts, boards, geometry, and coverage math.",
    )
    args = parser.parse_args(argv)
    out = args.out if args.out.is_absolute() else ROOT / args.out
    preflop_dir = (
        args.preflop_dir if args.preflop_dir.is_absolute() else ROOT / args.preflop_dir
    )
    data = RangeData(preflop_dir)

    if args.verify:
        catalog = json.loads(out.read_text())
        result = verify_catalog(catalog, data)
        print(f"VERIFY PASS: {json.dumps(result, indent=2, sort_keys=True)}")
        return 0

    catalog = build_catalog(data)
    # Verify in memory before writing so a bad generator cannot leave a
    # plausible-looking but internally inconsistent catalog behind.
    verify_catalog(catalog, data)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(catalog, indent=2, sort_keys=False) + "\n")
    print(
        f"Wrote {out} with {len(catalog['entries'])} entries "
        f"({catalog['summary']['status_counts']})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
