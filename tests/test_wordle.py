from datetime import date

import pytest

from wordle.puzzle import hint_violation, is_word, puzzle_date, score

C, P, A = "correct", "present", "absent"


def test_puzzle_date_is_one_year_back():
    assert puzzle_date(date(2026, 10, 11)) == date(2025, 10, 11)
    assert puzzle_date(date(2025, 1, 1)) == date(2024, 1, 1)


def test_puzzle_date_leap_day_falls_back():
    assert puzzle_date(date(2028, 2, 29)) == date(2027, 2, 28)


@pytest.mark.parametrize("guess, answer, expected", [
    ("stack", "stack", [C, C, C, C, C]),
    ("crane", "stack", [P, A, C, A, A]),
    ("speed", "abide", [A, A, P, A, P]),  # only one E is in the answer
    ("eerie", "speed", [P, P, A, A, A]),  # two Es in the answer, none in place
    ("eerie", "steer", [P, P, P, A, A]),  # two Es + R, all out of place
    ("geese", "eerie", [A, C, P, A, C]),  # green E consumes before yellows
    ("llama", "hello", [P, P, A, A, A]),
])
def test_score_handles_repeated_letters(guess, answer, expected):
    assert score(guess, answer) == expected


def test_word_list():
    assert is_word("crane", "stack")
    assert is_word("CRANE", "stack")
    assert not is_word("aeiou", "stack")
    assert is_word("zzzzz", "zzzzz")  # today's answer is always accepted


@pytest.mark.parametrize("guess, previous, answer, problem", [
    ("snack", ["crane"], "stack", None),
    ("slate", ["crane"], "stack", "Guess must contain C"),       # ignores yellow C
    ("acted", ["crane"], "stack", "3rd letter must be A"),       # moves green A
    ("stack", ["crane", "snack"], "stack", None),
    ("slack", ["crane", "snack"], "stack", None),
    ("shack", ["crane", "snack"], "stack", None),
    ("smack", ["snack"], "stack", None),
    ("track", ["snack"], "stack", "1st letter must be S"),
    ("rebut", ["eerie"], "steer", "Guess must contain E 2 times"),
    ("speed", ["eerie"], "steer", "Guess must contain R"),
    ("eerie", [], "stack", None),
])
def test_guesses_must_use_hints(guess, previous, answer, problem):
    assert hint_violation(guess, previous, answer) == problem
