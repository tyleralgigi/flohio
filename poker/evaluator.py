"""Seven-card Texas Hold'em hand evaluation.

Cards are two-character strings: rank (23456789TJQKA) + suit (shdc), e.g. "As", "Td".
"""
from collections import Counter
from itertools import combinations

RANKS = "23456789TJQKA"
SUITS = "shdc"
SUIT_SYMBOLS = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}

CATEGORY_NAMES = [
    "High Card",
    "Pair",
    "Two Pair",
    "Three of a Kind",
    "Straight",
    "Flush",
    "Full House",
    "Four of a Kind",
    "Straight Flush",
]

_RANK_WORDS = {
    2: ("Two", "Twos"), 3: ("Three", "Threes"), 4: ("Four", "Fours"), 5: ("Five", "Fives"),
    6: ("Six", "Sixes"), 7: ("Seven", "Sevens"), 8: ("Eight", "Eights"), 9: ("Nine", "Nines"),
    10: ("Ten", "Tens"), 11: ("Jack", "Jacks"), 12: ("Queen", "Queens"), 13: ("King", "Kings"),
    14: ("Ace", "Aces"),
}


def rank_value(card: str) -> int:
    return RANKS.index(card[0]) + 2


def pretty(card: str) -> str:
    rank = "10" if card[0] == "T" else card[0]
    return rank + SUIT_SYMBOLS[card[1]]


def rank5(cards) -> tuple:
    """Score exactly five cards. Higher tuples beat lower tuples."""
    vals = sorted((rank_value(c) for c in cards), reverse=True)
    flush = len({c[1] for c in cards}) == 1
    groups = sorted(Counter(vals).items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    ordered = [v for v, _ in groups]

    straight_high = None
    uniq = sorted(set(vals), reverse=True)
    if len(uniq) == 5:
        if uniq[0] - uniq[4] == 4:
            straight_high = uniq[0]
        elif uniq == [14, 5, 4, 3, 2]:
            straight_high = 5  # the wheel

    if straight_high and flush:
        return (8, straight_high)
    if groups[0][1] == 4:
        return (7, *ordered)
    if groups[0][1] == 3 and groups[1][1] == 2:
        return (6, *ordered)
    if flush:
        return (5, *vals)
    if straight_high:
        return (4, straight_high)
    if groups[0][1] == 3:
        return (3, *ordered)
    if groups[0][1] == 2 and groups[1][1] == 2:
        return (2, *ordered)
    if groups[0][1] == 2:
        return (1, *ordered)
    return (0, *vals)


def best_hand(cards):
    """Return (score, best_five_cards) for 5-7 cards."""
    best = None
    for combo in combinations(cards, 5):
        score = rank5(combo)
        if best is None or score > best[0]:
            best = (score, list(combo))
    return best


def hand_name(score: tuple) -> str:
    cat = score[0]
    one = lambda v: _RANK_WORDS[v][0]
    many = lambda v: _RANK_WORDS[v][1]
    if cat == 8:
        return "Royal Flush" if score[1] == 14 else f"Straight Flush, {one(score[1])} high"
    if cat == 7:
        return f"Four of a Kind, {many(score[1])}"
    if cat == 6:
        return f"Full House, {many(score[1])} full of {many(score[2])}"
    if cat == 5:
        return f"Flush, {one(score[1])} high"
    if cat == 4:
        return f"Straight, {one(score[1])} high"
    if cat == 3:
        return f"Three of a Kind, {many(score[1])}"
    if cat == 2:
        return f"Two Pair, {many(score[1])} and {many(score[2])}"
    if cat == 1:
        return f"Pair of {many(score[1])}"
    return f"High Card, {one(score[1])}"
