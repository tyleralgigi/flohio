"""Very Good Poker: host a no-limit Hold'em lobby and play with friends over webcam.

Run:  python main.py            (http://localhost:8000)
      python main.py --port 9000 --ssl-certfile cert.pem --ssl-keyfile key.pem
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import secrets
import time
from datetime import date
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from poker import bots
from poker.table import ActionError, Table
from wordle import puzzle as wordle

STATIC_DIR = Path(__file__).parent / "static"
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I confusion
DISCONNECT_GRACE = 20  # seconds before a disconnected player's turn is auto-played
EMPTY_ROOM_TTL = 30 * 60  # delete rooms nobody has been connected to for this long
SHOWDOWN_PAUSE = 6
FOLD_PAUSE = 3
RUNOUT_STEP = 1.5
BOT_THINK = (0.8, 2.2)  # seconds a bot "thinks" before acting

# Override with e.g. ICE_SERVERS='[{"urls":"turn:my.turn:3478","username":"u","credential":"p"}]'
ICE_SERVERS = json.loads(os.environ.get("ICE_SERVERS", "null")) or [
    {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}
]


class Room:
    def __init__(self, table: Table):
        self.table = table
        self.conns: dict[str, WebSocket] = {}
        self.lock = asyncio.Lock()
        self.disconnected_at: dict[str, float] = {}
        self.turn_key = None
        self.turn_deadline: float | None = None
        self.runout_at = 0.0
        self.next_hand_at = 0.0
        self.bot_act_at = 0.0
        self.bot_busy = False
        self.empty_since: float | None = time.time()
        self.ticker = asyncio.create_task(self._tick_loop())

    # -- messaging ---------------------------------------------------------
    async def send(self, pid: str, msg: dict):
        ws = self.conns.get(pid)
        if ws:
            try:
                await ws.send_json(msg)
            except Exception:
                pass

    async def broadcast(self, msg: dict, exclude: str | None = None):
        for pid in list(self.conns):
            if pid != exclude:
                await self.send(pid, msg)

    async def push_state(self):
        now = time.time()
        deadline = self._effective_deadline()
        remaining = max(0.0, deadline - now) if deadline else None
        total = self.table.turn_time or DISCONNECT_GRACE
        for pid in list(self.conns):
            state = self.table.view(pid)
            state["turn_remaining"] = remaining
            state["turn_total"] = total
            await self.send(pid, {"type": "state", "state": state})

    # -- timing ------------------------------------------------------------
    def _effective_deadline(self) -> float | None:
        t = self.table
        if not t.to_act or t.players[t.to_act].is_bot:
            return None
        deadline = self.turn_deadline
        if t.to_act in self.disconnected_at:
            grace = self.disconnected_at[t.to_act] + DISCONNECT_GRACE
            deadline = min(deadline, grace) if deadline else grace
        return deadline

    async def changed(self):
        """Call (holding the lock) after any change to table state."""
        t = self.table
        now = time.time()
        key = (t.hand_no, t.seq)
        if key != self.turn_key:
            self.turn_key = key
            self.turn_deadline = now + t.turn_time if (t.to_act and t.turn_time) else None
            if t.to_act and t.players[t.to_act].is_bot:
                self.bot_act_at = now + random.uniform(*BOT_THINK)
            if t.runout:
                self.runout_at = now + RUNOUT_STEP
            if t.phase == "complete":
                showdown = any(r["hand"] for r in t.results)
                self.next_hand_at = now + (SHOWDOWN_PAUSE if showdown else FOLD_PAUSE)
        await self.push_state()

    async def _tick_loop(self):
        while True:
            await asyncio.sleep(0.5)
            async with self.lock:
                t = self.table
                now = time.time()
                if self.conns:
                    self.empty_since = None
                elif self.empty_since is None:
                    self.empty_since = now
                elif now - self.empty_since > EMPTY_ROOM_TTL:
                    rooms.pop(t.code, None)
                    return
                try:
                    deadline = self._effective_deadline()
                    if deadline and now >= deadline:
                        t.log(f"{t.players[t.to_act].name} ran out of time")
                        t.auto_act(t.to_act)
                        await self.changed()
                    elif (t.to_act and t.players[t.to_act].is_bot and not self.bot_busy
                          and now >= self.bot_act_at):
                        self.bot_busy = True
                        asyncio.create_task(self._bot_move((t.hand_no, t.seq)))
                    elif t.runout and now >= self.runout_at:
                        t.step_runout()
                        await self.changed()
                    elif t.can_start_hand() and now >= self.next_hand_at:
                        t.start_hand()
                        await self.changed()
                except Exception as exc:  # never let the ticker die
                    print(f"[{t.code}] ticker error: {exc!r}")

    async def _bot_move(self, key):
        try:
            async with self.lock:
                t = self.table
                if (t.hand_no, t.seq) != key or not t.to_act:
                    return
                bot = t.players[t.to_act]
                snap = bots.snapshot(t, bot)
            action, amount = await asyncio.to_thread(bots.decide, snap)
            async with self.lock:
                if (t.hand_no, t.seq) != key or t.to_act != bot.id:
                    return  # the table moved on while we were thinking
                try:
                    t.act(bot.id, action, amount)
                except ActionError:
                    t.auto_act(bot.id)
                await self.changed()
        except Exception as exc:
            print(f"[{self.table.code}] bot error: {exc!r}")
            async with self.lock:  # don't let a broken bot stall the table
                t = self.table
                if (t.hand_no, t.seq) == key and t.to_act and t.players[t.to_act].is_bot:
                    t.auto_act(t.to_act)
                    await self.changed()
        finally:
            self.bot_busy = False

    # -- client messages ---------------------------------------------------
    async def handle(self, pid: str, msg: dict):
        kind = msg.get("type")
        if kind == "signal":
            # WebRTC signaling relay: offers, answers, ICE candidates.
            to = msg.get("to")
            if to in self.conns and to != pid:
                await self.send(to, {"type": "signal", "from": pid, "data": msg.get("data")})
            return

        async with self.lock:
            t = self.table
            if pid not in t.players:
                return
            p = t.players[pid]
            is_host = pid == t.host_id
            try:
                if kind == "action":
                    t.act(pid, msg.get("action"), msg.get("amount", 0))
                elif kind == "start":
                    if not is_host:
                        raise ActionError("Only the host can start the game")
                    t.started = bool(msg.get("value", True))
                    t.log("Game started" if t.started else "Game paused after this hand")
                    self.next_hand_at = time.time() + 1
                elif kind == "settings":
                    t.update_settings(pid, msg.get("settings") or {})
                elif kind == "add_bot":
                    t.add_bot(pid, str(msg.get("style", "shark")))
                elif kind == "sitout":
                    t.set_sitting_out(pid, msg.get("value", True))
                elif kind == "rebuy":
                    t.rebuy(pid)
                elif kind == "media":
                    p.cam_on = bool(msg.get("cam"))
                    p.mic_on = bool(msg.get("mic"))
                elif kind == "chat":
                    text = str(msg.get("text", "")).strip()[:300]
                    if not text:
                        return
                    t.log(text, kind="chat", name=p.name)
                elif kind == "kick":
                    target = msg.get("id")
                    if not is_host:
                        raise ActionError("Only the host can remove players")
                    if target in t.players and target != pid:
                        await self.send(target, {"type": "kicked"})
                        ws = self.conns.pop(target, None)
                        t.remove_player(target)
                        await self.broadcast({"type": "peer_left", "id": target})
                        if ws:
                            await ws.close()
                elif kind == "leave":
                    t.remove_player(pid)
                    self.conns.pop(pid, None)
                    await self.broadcast({"type": "peer_left", "id": pid})
                else:
                    return
            except ActionError as exc:
                await self.send(pid, {"type": "error", "message": str(exc)})
                return
            await self.changed()


rooms: dict[str, Room] = {}
app = FastAPI(title="Very Good Poker")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class CreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=20)
    small_blind: int = Field(ge=1, default=5)
    big_blind: int = Field(ge=1, default=10)
    starting_stack: int = Field(ge=1, default=1000)


class JoinRequest(BaseModel):
    code: str
    name: str = Field(min_length=1, max_length=20)


def _new_code() -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(5))
        if code not in rooms:
            return code


@app.get("/")
async def home(code: str = ""):
    if code:  # invite links from before the home page existed
        return RedirectResponse(f"/poker?code={quote(code)}")
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/poker")
async def poker_page():
    return FileResponse(STATIC_DIR / "poker" / "index.html")


@app.post("/api/poker/create")
async def create_lobby(req: CreateRequest):
    if req.big_blind < req.small_blind:
        raise HTTPException(400, "Big blind must be at least the small blind")
    if req.starting_stack < req.big_blind:
        raise HTTPException(400, "Starting stack must be at least one big blind")
    code = _new_code()
    table = Table(code, req.small_blind, req.big_blind, req.starting_stack)
    player = table.add_player(req.name)
    rooms[code] = Room(table)
    return {"code": code, "token": player.token}


@app.post("/api/poker/join")
async def join_lobby(req: JoinRequest):
    room = rooms.get(req.code.strip().upper())
    if not room:
        raise HTTPException(404, "No lobby with that code")
    async with room.lock:
        try:
            player = room.table.add_player(req.name)
        except ActionError as exc:
            raise HTTPException(400, str(exc))
        await room.changed()
    return {"code": room.table.code, "token": player.token}


@app.websocket("/ws/poker/{code}")
async def game_socket(websocket: WebSocket, code: str, token: str = ""):
    await websocket.accept()
    room = rooms.get(code.upper())
    player = room.table.by_token(token) if room and token else None
    if not player:
        await websocket.send_json({"type": "invalid_session"})
        await websocket.close()
        return
    pid = player.id

    async with room.lock:
        old = room.conns.get(pid)
        room.conns[pid] = websocket
        player.connected = True
        room.disconnected_at.pop(pid, None)
        peers = [other for other in room.conns if other != pid]
        await websocket.send_json({"type": "welcome", "id": pid, "peers": peers, "ice_servers": ICE_SERVERS})
        if old is None:
            await room.broadcast({"type": "peer_joined", "id": pid}, exclude=pid)
            room.table.log(f"{player.name} connected")
        await room.changed()
    if old is not None:  # same player opened a second tab / reconnected
        try:
            await old.send_json({"type": "replaced"})
            await old.close()
        except Exception:
            pass

    try:
        while True:
            msg = await websocket.receive_json()
            if isinstance(msg, dict):
                await room.handle(pid, msg)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        async with room.lock:
            if room.conns.get(pid) is websocket:
                del room.conns[pid]
                p = room.table.players.get(pid)
                if p:
                    p.connected = False
                    room.disconnected_at[pid] = time.time()
                    room.table.log(f"{p.name} disconnected")
                await room.broadcast({"type": "peer_left", "id": pid})
                await room.changed()


# ------------------------------------------------------------------ wordle
class GuessRequest(BaseModel):
    date: str
    guess: str = Field(min_length=wordle.WORD_LENGTH, max_length=wordle.WORD_LENGTH)
    previous: list[str] = Field(default=[], max_length=wordle.MAX_GUESSES - 1)  # earlier guesses, in order


async def _load_puzzle(day: date) -> dict:
    try:
        return await asyncio.to_thread(wordle.fetch_puzzle, day)
    except wordle.PuzzleError as exc:
        raise HTTPException(502, str(exc))


@app.get("/wordle")
async def wordle_page():
    return FileResponse(STATIC_DIR / "wordle" / "index.html")


@app.get("/api/wordle/puzzle")
async def wordle_puzzle():
    p = await _load_puzzle(wordle.puzzle_date())
    return {"date": p["date"], "number": p["number"], "editor": p["editor"]}


@app.post("/api/wordle/guess")
async def wordle_guess(req: GuessRequest):
    try:
        day = date.fromisoformat(req.date)
    except ValueError:
        raise HTTPException(400, "Bad date")
    if day > date.today():
        raise HTTPException(400, "That puzzle isn't out yet")
    words = [*req.previous, req.guess]
    if not all(len(w) == wordle.WORD_LENGTH and w.isalpha() for w in words):
        raise HTTPException(400, "Letters only")
    answer = (await _load_puzzle(day))["solution"]
    if not wordle.is_word(req.guess, answer):
        raise HTTPException(400, "Not in word list")
    problem = wordle.hint_violation(req.guess, req.previous, answer)
    if problem:
        raise HTTPException(400, problem)
    result = wordle.score(req.guess, answer)
    solved = req.guess.lower() == answer
    done = solved or len(words) >= wordle.MAX_GUESSES
    return {"result": result, "solved": solved, "answer": answer if done else None}


def _lan_ip() -> str | None:
    """This machine's LAN address (connecting a UDP socket sends no packets)."""
    import socket

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser(description="Very Good Poker server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    parser.add_argument("--ssl-certfile", help="HTTPS certificate (webcams need HTTPS off localhost)")
    parser.add_argument("--ssl-keyfile")
    args = parser.parse_args()

    import uvicorn

    scheme = "https" if args.ssl_certfile else "http"
    if args.host in ("0.0.0.0", "::"):
        print(f"\n  Open in your browser:  {scheme}://localhost:{args.port}")
        lan_ip = _lan_ip()
        if lan_ip:
            print(f"  On your network:       {scheme}://{lan_ip}:{args.port}")
        print()

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        ssl_certfile=args.ssl_certfile,
        ssl_keyfile=args.ssl_keyfile,
    )


if __name__ == "__main__":
    main()
