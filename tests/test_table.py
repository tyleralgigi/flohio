import random

import pytest

from poker.evaluator import best_hand, hand_name, rank5
from poker.table import ActionError, Table


def make_table(stacks, sb=5, bb=10):
    t = Table("TEST", sb, bb, 1000)
    players = []
    for i, stack in enumerate(stacks):
        p = t.add_player(f"P{i}")
        p.stack = p.buy_in = stack
        p.connected = True
        players.append(p)
    t.started = True
    return t, players


def total_chips(t):
    return sum(p.stack + p.contributed for p in t.players.values()) if t.in_progress else sum(
        p.stack for p in t.players.values())


# ----------------------------------------------------------------- evaluator
def test_hand_ranking_order():
    hands = [
        ["As", "Ks", "Qs", "Js", "Ts"],  # royal
        ["9h", "9d", "9s", "9c", "2h"],  # quads
        ["3h", "3d", "3s", "7c", "7h"],  # full house
        ["2d", "8d", "Td", "Jd", "Ad"],  # flush
        ["5s", "4h", "3d", "2c", "Ah"],  # wheel straight
        ["Qh", "Qd", "Qs", "2c", "7h"],  # trips
        ["Kh", "Kd", "4s", "4c", "7h"],  # two pair
        ["Jh", "Jd", "4s", "3c", "7h"],  # pair
        ["Ah", "Jd", "4s", "3c", "7h"],  # high card
    ]
    scores = [rank5(h) for h in hands]
    assert scores == sorted(scores, reverse=True)


def test_wheel_loses_to_six_high_straight():
    assert rank5(["6s", "5h", "4d", "3c", "2h"]) > rank5(["5s", "4h", "3d", "2c", "Ah"])


def test_best_of_seven_and_names():
    score, five = best_hand(["Ah", "Kh", "2h", "7h", "9h", "Kd", "Ks"])
    assert score[0] == 5 and hand_name(score) == "Flush, Ace high"
    assert len(five) == 5
    assert hand_name(rank5(["Kh", "Kd", "Ks", "4c", "4h"])) == "Full House, Kings full of Fours"


def test_kickers_matter():
    assert rank5(["Ah", "Ad", "Ks", "4c", "3h"]) > rank5(["As", "Ac", "Qs", "Jc", "Th"])


# ----------------------------------------------------------------- blinds & order
def test_heads_up_dealer_posts_small_blind_and_acts_first():
    t, (a, b) = make_table([1000, 1000])
    t.start_hand()
    dealer = next(p for p in (a, b) if p.seat == t.dealer_seat)
    other = b if dealer is a else a
    assert dealer.bet == 5 and other.bet == 10
    assert t.to_act == dealer.id
    t.act(dealer.id, "call")
    assert t.to_act == other.id  # big blind option
    t.act(other.id, "check")
    assert t.phase == "flop"
    assert t.to_act == other.id  # BB acts first post-flop heads up


def test_three_handed_order_and_bb_option():
    t, ps = make_table([1000, 1000, 1000])
    t.start_hand()
    sb, bb, dealer = t._after(t.dealer_seat)
    assert sb.bet == 5 and bb.bet == 10
    assert t.to_act == dealer.id
    t.act(dealer.id, "call")
    t.act(sb.id, "call")
    assert t.to_act == bb.id
    t.act(bb.id, "raise", 30)
    assert t.to_act == dealer.id  # action reopened
    t.act(dealer.id, "call")
    t.act(sb.id, "fold")
    assert t.phase == "flop"
    assert t.to_act == bb.id


def test_button_moves():
    t, ps = make_table([1000, 1000, 1000])
    t.start_hand()
    first = t.dealer_seat
    t.act(t.to_act, "fold")
    t.act(t.to_act, "fold")
    assert t.phase == "complete"
    t.start_hand()
    assert t.dealer_seat != first


# ----------------------------------------------------------------- raising rules
def test_min_raise_enforced():
    t, ps = make_table([1000, 1000, 1000])
    t.start_hand()
    with pytest.raises(ActionError):
        t.act(t.to_act, "raise", 15)  # min raise is to 20
    t.act(t.to_act, "raise", 50)  # raise by 40
    with pytest.raises(ActionError):
        t.act(t.to_act, "raise", 80)  # must be at least 90
    t.act(t.to_act, "raise", 90)


def test_short_all_in_does_not_reopen_betting():
    t, ps = make_table([1000, 1000, 1000])
    t.start_hand()
    sb, bb, dealer = t._after(t.dealer_seat)
    sb.stack = 50  # 55 total including the posted small blind
    t.act(dealer.id, "raise", 40)  # raise by 30
    sb_total = sb.bet + sb.stack
    t.act(sb.id, "allin")  # all-in to 55 total: raise of 15 < 30 -> not a full raise
    assert sb.all_in and t.current_bet == sb_total
    t.act(bb.id, "call")
    assert t.to_act == dealer.id
    actions = t.legal_actions(dealer.id)
    assert actions["can_raise"] is False  # dealer already acted and faces only a short raise
    t.act(dealer.id, "call")
    assert t.phase == "flop"


# ----------------------------------------------------------------- pots
def test_side_pots_and_chip_conservation():
    t, (a, b, c) = make_table([100, 300, 1000])
    t.start_hand()
    start_total = 1400
    # Everyone all in.
    while t.to_act:
        t.act(t.to_act, "allin")
    while t.runout:
        t.step_runout()
    assert t.phase == "complete"
    assert sum(p.stack for p in t.players.values()) == start_total
    # c has the uncovered excess returned at minimum.
    assert c.stack >= 700
    labels = [r["label"] for r in t.results]
    assert "Main pot" in labels


def test_build_pots_with_folded_dead_money():
    t, (a, b, c) = make_table([1000, 1000, 1000])
    t.start_hand()
    for p in (a, b, c):
        p.bet = 0
    a.contributed, b.contributed, c.contributed = 50, 200, 200
    a.all_in = True
    c.folded = True
    pots = t.build_pots()
    assert [amt for amt, _ in pots] == [150, 300]
    assert {p.id for p in pots[0][1]} == {a.id, b.id}
    assert {p.id for p in pots[1][1]} == {b.id}


def test_split_pot_on_board_play():
    t, (a, b) = make_table([1000, 1000])
    t.start_hand()
    t.act(t.to_act, "call")
    t.act(t.to_act, "check")
    t.board = ["As", "Ks", "Qs", "Js", "Ts"]
    t.deck = ["2c"] * 10
    a.hole, b.hole = ["2h", "3h"], ["4d", "5d"]
    t.phase = "river"
    t.act(t.to_act, "check")
    t.act(t.to_act, "check")
    assert t.phase == "complete"
    assert a.stack == b.stack == 1000
    assert t.results[0]["hand"] == "Royal Flush"


def test_leaving_mid_hand_keeps_chips_in_pot():
    t, (a, b, c) = make_table([1000, 1000, 1000])
    t.start_hand()
    sb, bb, dealer = t._after(t.dealer_seat)
    t.act(dealer.id, "raise", 100)
    t.remove_player(dealer.id)  # leaves after raising, while it's not their turn
    assert dealer.id in t.players  # kept until the hand ends
    while t.to_act:
        t.act(t.to_act, "fold")
    assert t.phase == "complete"
    assert dealer.id not in t.players
    # The leaver's raise stays in the pot; the last player in collects everything.
    assert sum(p.stack for p in t.players.values()) == 3000 - 900


def test_random_hands_conserve_chips():
    rng = random.Random(1234)
    t, ps = make_table([rng.randint(20, 400) for _ in range(6)])
    total = sum(p.stack for p in ps)
    for _ in range(300):
        if not t.start_hand():
            for p in t.players.values():
                if p.stack == 0:
                    p.stack += 200
                    total += 200
            continue
        while t.in_progress:
            if t.runout:
                t.step_runout()
                continue
            pid = t.to_act
            la = t.legal_actions(pid)
            choice = rng.random()
            if la["can_raise"] and choice < 0.25:
                amt = rng.randint(la["min_raise_to"], la["max_raise_to"])
                t.act(pid, "raise", amt)
            elif choice < 0.4 and not la["can_check"]:
                t.act(pid, "fold")
            else:
                t.act(pid, "check" if la["can_check"] else "call")
            assert total_chips(t) == total
        assert sum(p.stack for p in t.players.values()) == total
