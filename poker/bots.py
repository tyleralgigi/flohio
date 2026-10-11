"""Bot players: Monte Carlo hand strength + pot odds, flavoured by a playing style.

`snapshot()` runs under the room lock and copies what the bot can see;
`decide()` is pure and slow-ish (simulations), so the server runs it in a thread.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from itertools import combinations

from .evaluator import RANKS, SUITS, rank5

FULL_DECK = [r + s for r in RANKS for s in SUITS]


@dataclass(frozen=True)
class Style:
    iters: int  # simulations per decision
    noise: float  # random error added to estimated equity
    strong: float  # how far above "average" equity counts as a value hand (0-1)
    good: float  # how far above average counts as a decent hand
    aggression: float  # chance of betting/raising a strong hand
    bluff: float  # chance of betting/raising with nothing
    call_margin: float  # extra equity demanded over pot odds before calling
    sizing: tuple[float, float]  # bet size range as a fraction of the pot
    shove: float  # chance of just going all-in instead of a sized raise


STYLES = {
    # Calls too much, rarely raises, makes mistakes.
    "fish": Style(iters=120, noise=0.12, strong=0.45, good=0.15, aggression=0.25,
                  bluff=0.03, call_margin=-0.10, sizing=(0.3, 0.6), shove=0.0),
    # Solid: values hands, respects pot odds, bluffs now and then.
    "shark": Style(iters=320, noise=0.03, strong=0.33, good=0.12, aggression=0.7,
                   bluff=0.08, call_margin=0.02, sizing=(0.5, 0.85), shove=0.02),
    # Bets and raises constantly, big sizes, frequent bluffs.
    "maniac": Style(iters=150, noise=0.08, strong=0.22, good=0.05, aggression=0.9,
                    bluff=0.28, call_margin=-0.06, sizing=(0.75, 1.5), shove=0.08),
}


def _best(cards) -> tuple:
    return max(rank5(c) for c in combinations(cards, 5))


def equity(hole: list[str], board: list[str], opponents: int, iters: int, rng: random.Random) -> float:
    """Chance of winning against `opponents` random hands (ties count as a share)."""
    opponents = max(1, min(opponents, 5))  # cap for speed; more is barely different
    known = set(hole) | set(board)
    deck = [c for c in FULL_DECK if c not in known]
    need = 5 - len(board)
    total = 0.0
    for _ in range(iters):
        draw = rng.sample(deck, need + 2 * opponents)
        full_board = board + draw[:need]
        mine = _best(hole + full_board)
        ties = 0
        for i in range(opponents):
            score = _best(draw[need + 2 * i: need + 2 * i + 2] + full_board)
            if score > mine:
                break
            if score == mine:
                ties += 1
        else:
            total += 1 / (ties + 1)
    return total / iters


def snapshot(table, bot) -> dict:
    actions = table.legal_actions(bot.id)
    return {
        "style": bot.bot_style,
        "hole": list(bot.hole),
        "board": list(table.board),
        "opponents": sum(1 for p in table.players.values() if p.live and p is not bot),
        "pot": sum(p.contributed for p in table.players.values()),
        "current_bet": table.current_bet,
        "stack": bot.stack,
        "big_blind": table.hand_bb,
        **actions,
    }


def decide(s: dict, rng: random.Random | None = None) -> tuple[str, int]:
    rng = rng or random.Random()
    style = STYLES.get(s["style"], STYLES["shark"])
    eq = equity(s["hole"], s["board"], s["opponents"], style.iters, rng)
    eq += rng.uniform(-style.noise, style.noise)

    avg = 1 / (s["opponents"] + 1)
    strong = avg + (1 - avg) * style.strong
    good = avg + (1 - avg) * style.good
    to_call = s["to_call"]
    pot = s["pot"]
    r = rng.random()

    def raise_to(lo: float, hi: float) -> tuple[str, int]:
        if rng.random() < style.shove:
            return ("raise", s["max_raise_to"])
        size = rng.uniform(lo, hi) * (pot + to_call)
        amount = int(s["current_bet"] + max(size, s["big_blind"]))
        amount = max(s["min_raise_to"], min(s["max_raise_to"], amount))
        if amount > 0.7 * s["max_raise_to"]:  # that close to all-in: just shove
            amount = s["max_raise_to"]
        return ("raise", amount)

    if s["can_check"]:
        if s["can_raise"] and eq >= strong and r < style.aggression + 0.2:
            return raise_to(*style.sizing)
        if s["can_raise"] and eq >= good and r < style.aggression * 0.5:
            return raise_to(style.sizing[0] * 0.8, style.sizing[0] * 1.2)
        if s["can_raise"] and r < style.bluff:
            return raise_to(*style.sizing)
        return ("check", 0)

    pot_odds = to_call / (pot + to_call)
    if s["can_raise"] and eq >= strong and r < style.aggression:
        return raise_to(*style.sizing)
    if eq >= pot_odds + style.call_margin:
        return ("call", 0)
    if s["can_raise"] and r < style.bluff * 0.5:
        return raise_to(*style.sizing)
    return ("fold", 0)
