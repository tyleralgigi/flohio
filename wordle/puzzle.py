"""Wordle puzzles: answers come from the NYT archive, one year behind today."""
from __future__ import annotations

import json
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

NYT_URL = "https://www.nytimes.com/svc/wordle/v2/{}.json"
WORD_LENGTH = 5
MAX_GUESSES = 6
ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"]

# Every word Wordle accepts as a guess (past answers + allowed guesses).
WORDS = frozenset(Path(__file__).with_name("words.txt").read_text().split())

_cache: dict[str, dict] = {}


class PuzzleError(Exception):
    pass


def puzzle_date(today: date | None = None) -> date:
    """Today's date minus one year (Feb 29 falls back to Feb 28)."""
    today = today or date.today()
    try:
        return today.replace(year=today.year - 1)
    except ValueError:
        return today.replace(year=today.year - 1, day=28)


def fetch_puzzle(day: date) -> dict:
    """Fetch (and cache) the NYT puzzle for a day. Blocking; run it in a thread."""
    key = day.isoformat()
    if key not in _cache:
        req = urllib.request.Request(NYT_URL.format(key), headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.load(resp)
        except Exception as exc:
            raise PuzzleError(f"Couldn't load the puzzle for {key}") from exc
        solution = str(data.get("solution", "")).lower()
        if len(solution) != WORD_LENGTH or not solution.isalpha():
            raise PuzzleError(f"Unexpected puzzle data for {key}")
        _cache[key] = {
            "date": key,
            "number": data.get("days_since_launch"),
            "editor": data.get("editor"),
            "solution": solution,
        }
    return _cache[key]


def score(guess: str, answer: str) -> list[str]:
    """Colour each letter: 'correct', 'present' or 'absent', handling repeated letters."""
    guess, answer = guess.lower(), answer.lower()
    result = ["absent"] * len(guess)
    unmatched = Counter()
    for i, (g, a) in enumerate(zip(guess, answer)):
        if g == a:
            result[i] = "correct"
        else:
            unmatched[a] += 1
    for i, g in enumerate(guess):
        if result[i] != "correct" and unmatched[g]:
            result[i] = "present"
            unmatched[g] -= 1
    return result


def is_word(guess: str, answer: str) -> bool:
    guess = guess.lower()
    return guess in WORDS or guess == answer.lower()


def hint_violation(guess: str, previous: list[str], answer: str) -> str | None:
    """Why `guess` ignores a hint revealed by an earlier guess, or None if it uses them all.

    Green letters must stay in place; yellow (and green) letters must appear at least as
    many times as they were revealed in any one earlier guess.
    """
    guess = guess.lower()
    have = Counter(guess)
    for prev in previous:
        prev = prev.lower()
        result = score(prev, answer)
        for i, (ch, res) in enumerate(zip(prev, result)):
            if res == "correct" and guess[i] != ch:
                return f"{ORDINALS[i]} letter must be {ch.upper()}"
        need = Counter(ch for ch, res in zip(prev, result) if res != "absent")
        for ch, n in need.items():
            if have[ch] < n:
                return f"Guess must contain {ch.upper()}" + (f" {n} times" if n > 1 else "")
    return None
