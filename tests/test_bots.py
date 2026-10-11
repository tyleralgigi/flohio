import random
import time

import pytest

from poker import bots
from poker.table import ActionError, Table


def test_equity_sanity():
    rng = random.Random(7)
    aces = bots.equity(["As", "Ah"], [], 1, 400, rng)
    junk = bots.equity(["7c", "2d"], [], 1, 400, rng)
    assert aces > 0.75 and junk < 0.45
    nuts = bots.equity(["As", "Ks"], ["Qs", "Js", "Ts"], 3, 100, rng)
    assert nuts == 1.0


def test_only_host_adds_bots_and_bots_never_host():
    t = Table("T", 5, 10, 500)
    host = t.add_player("Host")
    guest = t.add_player("Guest")
    with pytest.raises(ActionError):
        t.add_bot(guest.id, "shark")
    bot = t.add_bot(host.id, "fish")
    assert bot.is_bot and bot.connected
    t.remove_player(host.id)
    assert t.host_id == guest.id
    t.remove_player(guest.id)
    assert t.host_id is None


def test_bots_need_a_human_present():
    t = Table("T", 5, 10, 500)
    host = t.add_player("Host")
    host.connected = True
    t.add_bot(host.id, "shark")
    t.started = True
    assert t.can_start_hand()
    host.connected = False
    assert not t.can_start_hand()


@pytest.mark.parametrize("seed", [1, 2])
def test_bots_play_legal_hands(seed):
    rng = random.Random(seed)
    t = Table("T", 5, 10, 500)
    host = t.add_player("Host")
    host.connected = True
    host.sitting_out = True  # watch the bots play each other
    for style in ("fish", "shark", "maniac", "shark"):
        t.add_bot(host.id, style)
    t.started = True
    slowest = 0.0
    for _ in range(15):
        assert t.start_hand()
        total = sum(p.stack + p.contributed for p in t.players.values())
        while t.in_progress:
            if t.runout:
                t.step_runout()
                continue
            bot = t.players[t.to_act]
            start = time.perf_counter()
            action, amount = bots.decide(bots.snapshot(t, bot), rng)
            slowest = max(slowest, time.perf_counter() - start)
            t.act(bot.id, action, amount)  # raises if the bot picked an illegal move
            in_pot = sum(p.contributed for p in t.players.values()) if t.in_progress else 0
            assert sum(p.stack for p in t.players.values()) + in_pot == total
    assert slowest < 2.0
