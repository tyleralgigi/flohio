"""No-limit Texas Hold'em table state machine. Pure game logic, no networking."""
from __future__ import annotations

import random
import secrets
from collections import deque
from dataclasses import dataclass, field

from .evaluator import RANKS, SUITS, best_hand, hand_name, pretty

MAX_SEATS = 9
BOT_STYLES = ("fish", "shark", "maniac")
BOT_NAMES = ["Jimbo", "Zany", "Sly", "Wily", "Droll", "Crafty", "Devious", "Clever", "Jolly", "Mad", "Crazy", "Greedy"]
_rng = random.SystemRandom()


class ActionError(Exception):
    """An illegal request from a player (shown to them as an error message)."""


def new_deck() -> list[str]:
    deck = [r + s for r in RANKS for s in SUITS]
    _rng.shuffle(deck)
    return deck


@dataclass
class Player:
    id: str
    token: str
    name: str
    seat: int
    stack: int
    buy_in: int
    connected: bool = False
    sitting_out: bool = False
    leaving: bool = False
    cam_on: bool = True
    mic_on: bool = True
    is_bot: bool = False
    bot_style: str = ""
    # per-hand state
    in_hand: bool = False
    hole: list[str] = field(default_factory=list)
    bet: int = 0  # chips put in on the current street
    contributed: int = 0  # chips put in over the whole hand
    folded: bool = False
    all_in: bool = False
    acted: bool = False
    can_raise: bool = True
    show_cards: bool = False
    last_action: str = ""

    def reset_hand(self):
        self.in_hand = False
        self.hole = []
        self.bet = 0
        self.contributed = 0
        self.folded = False
        self.all_in = False
        self.acted = False
        self.can_raise = True
        self.show_cards = False
        self.last_action = ""

    @property
    def live(self) -> bool:
        return self.in_hand and not self.folded

    @property
    def can_act(self) -> bool:
        return self.live and not self.all_in


class Table:
    BETTING_PHASES = ("preflop", "flop", "turn", "river")

    def __init__(self, code: str, small_blind: int, big_blind: int, starting_stack: int):
        self.code = code
        self.small_blind = small_blind
        self.big_blind = big_blind
        self.starting_stack = starting_stack
        self.allow_rebuy = True
        self.turn_time = 0  # seconds, 0 = no limit
        self.players: dict[str, Player] = {}
        self.host_id: str | None = None
        self.started = False
        self.phase = "waiting"  # waiting | preflop | flop | turn | river | complete
        self.hand_no = 0
        self.seq = 0  # bumps on every game-state transition (used for timers)
        self.dealer_seat = -1
        self.sb_seat: int | None = None
        self.bb_seat: int | None = None
        self.deck: list[str] = []
        self.board: list[str] = []
        self.current_bet = 0
        self.min_raise = 0
        self.hand_bb = big_blind
        self.to_act: str | None = None
        self.runout = False  # everyone is all-in; remaining cards are being dealt
        self.results: list[dict] = []
        self.feed: deque[dict] = deque(maxlen=150)
        self._feed_id = 0

    # ------------------------------------------------------------------ helpers
    @property
    def in_progress(self) -> bool:
        return self.phase in self.BETTING_PHASES

    def log(self, text: str, kind: str = "log", name: str | None = None):
        self._feed_id += 1
        self.feed.append({"id": self._feed_id, "kind": kind, "text": text, "name": name})

    def _sorted(self, players=None) -> list[Player]:
        return sorted(players if players is not None else self.players.values(), key=lambda p: p.seat)

    def _after(self, seat: int, players=None) -> list[Player]:
        """Players in clockwise order starting with the first seat after `seat`."""
        ps = self._sorted(players)
        return [p for p in ps if p.seat > seat] + [p for p in ps if p.seat <= seat]

    def _live(self) -> list[Player]:
        return [p for p in self.players.values() if p.live]

    def eligible(self) -> list[Player]:
        return [
            p for p in self.players.values()
            if p.stack > 0 and not p.sitting_out and p.connected and not p.leaving
        ]

    def by_token(self, token: str) -> Player | None:
        return next((p for p in self.players.values() if secrets.compare_digest(p.token, token)), None)

    # ------------------------------------------------------------------ seating
    def add_player(self, name: str) -> Player:
        name = name.strip()[:20]
        if not name:
            raise ActionError("Please enter a name")
        if any(p.name.lower() == name.lower() for p in self.players.values()):
            raise ActionError("That name is already taken at this table")
        p = Player(
            id=secrets.token_hex(4),
            token=secrets.token_urlsafe(18),
            name=name,
            seat=self._free_seat(),
            stack=self.starting_stack,
            buy_in=self.starting_stack,
        )
        self.players[p.id] = p
        if self.host_id is None:
            self.host_id = p.id
        self.log(f"{name} joined the table")
        return p

    def add_bot(self, pid: str, style: str) -> Player:
        if pid != self.host_id:
            raise ActionError("Only the host can add bots")
        if style not in BOT_STYLES:
            raise ActionError("Unknown bot style")
        taken = {p.name.lower() for p in self.players.values()}
        names = [n for n in BOT_NAMES if n.lower() not in taken] or [f"Bot {secrets.token_hex(2)}"]
        p = Player(
            id=secrets.token_hex(4),
            token=secrets.token_urlsafe(18),
            name=_rng.choice(names),
            seat=self._free_seat(),
            stack=self.starting_stack,
            buy_in=self.starting_stack,
            connected=True,
            cam_on=False,
            mic_on=False,
            is_bot=True,
            bot_style=style,
        )
        self.players[p.id] = p
        self.log(f"{p.name} the {style} (bot) sat down")
        return p

    def _free_seat(self) -> int:
        taken = {p.seat for p in self.players.values()}
        free = [s for s in range(MAX_SEATS) if s not in taken]
        if not free:
            raise ActionError("Table is full")
        return free[0]

    def remove_player(self, pid: str):
        p = self.players.get(pid)
        if not p:
            return
        if self.in_progress and p.in_hand:
            # Keep them until the hand ends so their chips stay in the pot.
            p.leaving = True
            if p.live:
                self._fold_out_of_turn(p)
        elif pid in self.players:
            del self.players[pid]
        self.log(f"{p.name} left the table")
        self._fix_host()

    def _fix_host(self):
        if self.host_id not in self.players or self.players[self.host_id].leaving:
            remaining = [p for p in self._sorted() if not p.leaving and not p.is_bot]
            self.host_id = remaining[0].id if remaining else None
            if self.host_id:
                self.log(f"{self.players[self.host_id].name} is now the host")

    def set_sitting_out(self, pid: str, value: bool):
        p = self.players[pid]
        p.sitting_out = bool(value)
        self.log(f"{p.name} {'is sitting out' if value else 'is back'}")

    def rebuy(self, pid: str):
        p = self.players[pid]
        if not self.allow_rebuy:
            raise ActionError("Rebuys are disabled by the host")
        if p.stack > 0:
            raise ActionError("You can only rebuy when you're out of chips")
        if p.in_hand and self.in_progress:
            raise ActionError("Wait for the hand to finish")
        p.stack += self.starting_stack
        p.buy_in += self.starting_stack
        self.log(f"{p.name} rebought for {self.starting_stack}")

    def update_settings(self, pid: str, data: dict):
        if pid != self.host_id:
            raise ActionError("Only the host can change settings")
        try:
            sb = int(data.get("small_blind", self.small_blind))
            bb = int(data.get("big_blind", self.big_blind))
            stack = int(data.get("starting_stack", self.starting_stack))
            turn_time = int(data.get("turn_time", self.turn_time))
        except (TypeError, ValueError):
            raise ActionError("Settings must be whole numbers")
        if sb < 1 or bb < sb:
            raise ActionError("Blinds must be at least 1 and big blind >= small blind")
        if stack < bb:
            raise ActionError("Starting stack must be at least one big blind")
        if not (turn_time == 0 or 5 <= turn_time <= 600):
            raise ActionError("Turn timer must be 0 (off) or 5-600 seconds")
        if (sb, bb) != (self.small_blind, self.big_blind):
            when = "next hand" if self.in_progress else "now"
            self.log(f"Blinds set to {sb}/{bb} (from {when})")
        self.small_blind, self.big_blind = sb, bb
        self.starting_stack = stack
        self.turn_time = turn_time
        self.allow_rebuy = bool(data.get("allow_rebuy", self.allow_rebuy))

    # ------------------------------------------------------------------ hand flow
    def can_start_hand(self) -> bool:
        # Bots don't play on their own: someone human has to be at the table.
        humans_here = any(p.connected and not p.is_bot for p in self.players.values())
        return self.started and not self.in_progress and humans_here and len(self.eligible()) >= 2

    def start_hand(self) -> bool:
        for p in self.players.values():
            if p.is_bot and p.stack == 0 and self.allow_rebuy:
                p.stack += self.starting_stack
                p.buy_in += self.starting_stack
                self.log(f"{p.name} reloads for {self.starting_stack}")
        elig = self.eligible()
        if len(elig) < 2:
            self.phase = "waiting"
            self.to_act = None
            return False
        for p in self.players.values():
            p.reset_hand()
        self.seq += 1
        self.hand_no += 1
        self.hand_bb = self.big_blind
        self.deck = new_deck()
        self.board = []
        self.results = []
        self.runout = False

        order = self._after(self.dealer_seat, elig)
        dealer = order[0]
        self.dealer_seat = dealer.seat
        if len(order) == 2:  # heads-up: dealer posts the small blind and acts first preflop
            sb, bb = order[0], order[1]
        else:
            sb, bb = order[1], order[2]
        self.sb_seat, self.bb_seat = sb.seat, bb.seat
        for p in elig:
            p.in_hand = True

        self.log(f"--- Hand #{self.hand_no} — {dealer.name} has the button ---", kind="hand")
        self._post(sb, self.small_blind, "SB")
        self._post(bb, self.hand_bb, "BB")
        for _ in range(2):
            for p in self._after(dealer.seat, elig):
                p.hole.append(self.deck.pop())

        self.phase = "preflop"
        self.current_bet = max(p.bet for p in elig)
        self.min_raise = self.hand_bb
        self._advance(bb.seat)
        return True

    def _post(self, p: Player, amount: int, label: str):
        self._commit(p, amount)
        p.last_action = f"{label} {p.bet}"
        self.log(f"{p.name} posts {label} {p.bet}" + (" (all-in)" if p.all_in else ""))

    def _commit(self, p: Player, amount: int) -> int:
        amount = max(0, min(amount, p.stack))
        p.stack -= amount
        p.bet += amount
        p.contributed += amount
        if p.stack == 0:
            p.all_in = True
        return amount

    def _needs_action(self, p: Player) -> bool:
        return p.can_act and (not p.acted or p.bet < self.current_bet)

    def _advance(self, after_seat: int):
        """Pick the next player to act after `after_seat`, or close the betting round."""
        live = self._live()
        if len(live) == 1:
            self._award_uncontested(live[0])
            return
        actable = [p for p in live if not p.all_in]
        if not actable or (len(actable) == 1 and actable[0].bet >= self.current_bet):
            self._end_street()
            return
        for p in self._after(after_seat):
            if self._needs_action(p):
                self.to_act = p.id
                return
        self._end_street()

    def _end_street(self):
        self.to_act = None
        for p in self.players.values():
            p.bet = 0
            p.acted = False
            p.can_raise = True
            if p.live and not p.all_in:
                p.last_action = ""
        self.current_bet = 0
        self.min_raise = self.hand_bb
        if self.phase == "river":
            self._showdown()
            return
        live = self._live()
        if sum(1 for p in live if not p.all_in) <= 1:
            # Nobody left to bet against: table the hands and run out the board.
            self.runout = True
            for p in live:
                p.show_cards = True
            self.log("All in — running out the board")
            return
        self._deal_street()
        self._advance(self.dealer_seat)

    def _deal_street(self):
        self.seq += 1
        self.deck.pop()  # burn
        if self.phase == "preflop":
            self.board += [self.deck.pop() for _ in range(3)]
            self.phase = "flop"
        elif self.phase == "flop":
            self.board.append(self.deck.pop())
            self.phase = "turn"
        elif self.phase == "turn":
            self.board.append(self.deck.pop())
            self.phase = "river"
        self.log(f"{self.phase.title()}: " + " ".join(pretty(c) for c in self.board))

    def step_runout(self):
        """Deal one more street during an all-in runout (called on a timer)."""
        if not self.runout:
            return
        if self.phase == "river":
            self.runout = False
            self._showdown()
        else:
            self._deal_street()

    # ------------------------------------------------------------------ actions
    def legal_actions(self, pid: str) -> dict | None:
        p = self.players.get(pid)
        if not p or self.to_act != pid or self.runout:
            return None
        to_call = min(self.current_bet - p.bet, p.stack)
        max_to = p.bet + p.stack
        can_raise = self._can_raise(p)
        return {
            "to_call": to_call,
            "can_check": to_call <= 0,
            "can_raise": can_raise,
            "min_raise_to": min(self.current_bet + self.min_raise, max_to) if can_raise else 0,
            "max_raise_to": max_to if can_raise else 0,
            "is_bet": self.current_bet == 0,
        }

    def _can_raise(self, p: Player) -> bool:
        others_can_respond = any(q.can_act for q in self._live() if q is not p)
        return p.can_raise and p.bet + p.stack > self.current_bet and others_can_respond

    def act(self, pid: str, action: str, amount=0):
        if self.to_act != pid or self.runout or not self.in_progress:
            raise ActionError("It's not your turn")
        p = self.players[pid]
        to_call = min(self.current_bet - p.bet, p.stack)

        if action == "allin":
            action = "raise" if self._can_raise(p) else "call"
            amount = p.bet + p.stack

        if action == "fold":
            p.folded = True
            p.last_action = "Fold"
            self.log(f"{p.name} folds")
        elif action == "check" or (action == "call" and to_call <= 0):
            if to_call > 0:
                raise ActionError(f"You must call {to_call}, raise, or fold")
            p.last_action = "Check"
            self.log(f"{p.name} checks")
        elif action == "call":
            self._commit(p, to_call)
            p.last_action = "All-in" if p.all_in else f"Call {to_call}"
            self.log(f"{p.name} calls {to_call}" + (" (all-in)" if p.all_in else ""))
        elif action == "raise":
            if not self._can_raise(p):
                raise ActionError("You can't raise here")
            try:
                amount = int(amount)
            except (TypeError, ValueError):
                raise ActionError("Invalid raise amount")
            max_to = p.bet + p.stack
            amount = min(amount, max_to)
            min_to = self.current_bet + self.min_raise
            if amount < min_to and amount != max_to:
                raise ActionError(f"Minimum {'bet' if self.current_bet == 0 else 'raise'} is {min_to}")
            was_bet = self.current_bet == 0
            raise_by = amount - self.current_bet
            self._commit(p, amount - p.bet)
            others = [q for q in self._live() if q is not p]
            if raise_by >= self.min_raise:
                # Full raise: reopens betting for everyone.
                self.min_raise = raise_by
                for q in others:
                    q.acted = False
                    q.can_raise = True
            else:
                # Short all-in: players who already acted may only call or fold.
                for q in others:
                    if q.acted:
                        q.can_raise = False
            self.current_bet = amount
            verb = "bets" if was_bet else "raises to"
            p.last_action = f"All-in {amount}" if p.all_in else f"{'Bet' if was_bet else 'Raise'} {amount}"
            self.log(f"{p.name} {verb} {amount}" + (" (all-in)" if p.all_in else ""))
        else:
            raise ActionError("Unknown action")

        p.acted = True
        self.seq += 1
        self._advance(p.seat)

    def auto_act(self, pid: str):
        """Timeout/disconnect: check if free, otherwise fold."""
        p = self.players[pid]
        self.act(pid, "check" if p.bet >= self.current_bet else "fold")

    def _fold_out_of_turn(self, p: Player):
        if self.to_act == p.id:
            self.act(p.id, "fold")
            return
        p.folded = True
        p.last_action = "Fold"
        self.seq += 1
        live = self._live()
        if len(live) == 1:
            self._award_uncontested(live[0])
        elif self.to_act is None and not self.runout:
            self._advance(p.seat)

    # ------------------------------------------------------------------ payouts
    def _total_pot(self) -> int:
        return sum(p.contributed for p in self.players.values())

    def _award_uncontested(self, winner: Player):
        pot = self._total_pot()
        winner.stack += pot
        self.results = [{
            "label": "Pot", "amount": pot, "winners": [winner.id],
            "names": [winner.name], "hand": None, "cards": [],
        }]
        self.log(f"{winner.name} wins {pot}")
        self._finish_hand()

    def build_pots(self) -> list[tuple[int, list[Player]]]:
        live = self._live()
        contrib = {p.id: p.contributed for p in self.players.values() if p.contributed > 0}
        pots: list[tuple[int, list[Player]]] = []
        while any(v > 0 for v in contrib.values()):
            contenders = [p for p in live if contrib.get(p.id, 0) > 0]
            if not contenders:
                # Only dead money from folded players remains; it belongs to the last pot.
                leftover = sum(contrib.values())
                if pots:
                    amt, elig = pots[-1]
                    pots[-1] = (amt + leftover, elig)
                break
            level = min(contrib[p.id] for p in contenders)
            amount = 0
            for pid in contrib:
                take = min(contrib[pid], level)
                amount += take
                contrib[pid] -= take
            if pots and {p.id for p in pots[-1][1]} == {p.id for p in contenders}:
                pots[-1] = (pots[-1][0] + amount, contenders)
            else:
                pots.append((amount, contenders))
        return pots

    def _showdown(self):
        self.to_act = None
        self.runout = False
        live = self._live()
        for p in live:
            p.show_cards = True
        evals = {p.id: best_hand(p.hole + self.board) for p in live}
        self.results = []
        pots = self.build_pots()
        for i, (amount, elig) in enumerate(pots):
            label = "Main pot" if i == 0 else f"Side pot {i}"
            if len(pots) == 1:
                label = "Pot"
            best = max(evals[p.id][0] for p in elig)
            winners = [p for p in self._after(self.dealer_seat, elig) if evals[p.id][0] == best]
            share, rem = divmod(amount, len(winners))
            for j, w in enumerate(winners):
                w.stack += share + (1 if j < rem else 0)
            returned = len(elig) == 1
            hand = None if returned else hand_name(best)
            self.results.append({
                "label": "Returned" if returned else label,
                "amount": amount,
                "winners": [w.id for w in winners],
                "names": [w.name for w in winners],
                "hand": hand,
                "cards": [] if returned else evals[winners[0].id][1],
            })
            if returned:
                self.log(f"{winners[0].name} gets {amount} back (uncalled)")
            else:
                who = " and ".join(w.name for w in winners)
                verb = "split" if len(winners) > 1 else "wins"
                self.log(f"{who} {verb} {amount} with {hand}")
        for p in live:
            if not any(p.id in r["winners"] for r in self.results):
                self.log(f"{p.name} shows {pretty(p.hole[0])} {pretty(p.hole[1])}")
        self._finish_hand()

    def _finish_hand(self):
        self.phase = "complete"
        self.to_act = None
        self.runout = False
        self.seq += 1
        for pid in [p.id for p in self.players.values() if p.leaving]:
            del self.players[pid]
        self._fix_host()
        for p in self.players.values():
            if p.in_hand and p.stack == 0:
                p.last_action = "Busted"

    # ------------------------------------------------------------------ views
    def view(self, viewer_id: str) -> dict:
        players = []
        for p in self._sorted():
            if p.id == viewer_id or (p.show_cards and p.live):
                cards = list(p.hole)
            elif p.live and p.hole:
                cards = ["??", "??"]
            else:
                cards = []
            players.append({
                "id": p.id,
                "name": p.name,
                "seat": p.seat,
                "stack": p.stack,
                "bet": p.bet,
                "in_hand": p.in_hand,
                "folded": p.folded,
                "all_in": p.all_in,
                "sitting_out": p.sitting_out,
                "connected": p.connected,
                "cam_on": p.cam_on,
                "mic_on": p.mic_on,
                "is_bot": p.is_bot,
                "bot_style": p.bot_style,
                "last_action": p.last_action,
                "cards": cards,
                "net": p.stack + (p.contributed if self.in_progress else 0) - p.buy_in,
                "buy_in": p.buy_in,
            })
        total = self._total_pot() if self.in_progress else 0
        return {
            "code": self.code,
            "me": viewer_id,
            "host_id": self.host_id,
            "started": self.started,
            "phase": self.phase,
            "hand_no": self.hand_no,
            "board": self.board,
            "dealer_seat": self.dealer_seat if self.hand_no else None,
            "sb_seat": self.sb_seat,
            "bb_seat": self.bb_seat,
            "to_act": self.to_act,
            "runout": self.runout,
            "current_bet": self.current_bet,
            "pot": total - sum(p.bet for p in self.players.values()),
            "total_pot": total,
            "players": players,
            "results": self.results if self.phase == "complete" else [],
            "actions": self.legal_actions(viewer_id),
            "settings": {
                "small_blind": self.small_blind,
                "big_blind": self.big_blind,
                "starting_stack": self.starting_stack,
                "turn_time": self.turn_time,
                "allow_rebuy": self.allow_rebuy,
            },
            "feed": list(self.feed)[-80:],
        }
