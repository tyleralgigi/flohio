(() => {
  'use strict';

  const LEN = 5;
  const MAX = 6;
  const FLIP_MS = 300;  // stagger between tiles; matches .flip delay in style.css
  const GAME_KEY = 'vgw.game';
  const STATS_KEY = 'vgw.stats';
  const RANK = { absent: 1, present: 2, correct: 3 };
  const PRAISE = ['Genius', 'Magnificent', 'Impressive', 'Splendid', 'Great', 'Phew'];

  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');
  const keyboardEl = $('keyboard');

  let puzzle = null;   // {date, number, editor}
  let game = null;     // {date, guesses: [{word, result}], draft, status, answer}; saved to localStorage
  let current = '';
  let busy = true;

  // ------------------------------------------------------------- storage
  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
  function emptyStats() {
    return { played: 0, wins: 0, streak: 0, maxStreak: 0, dist: Array(MAX).fill(0), lastWin: null };
  }

  // ------------------------------------------------------------- board
  function buildBoard() {
    boardEl.innerHTML = '';
    for (let r = 0; r < MAX; r++) {
      const row = document.createElement('div');
      row.className = 'row';
      for (let c = 0; c < LEN; c++) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.style.setProperty('--i', c);
        row.appendChild(tile);
      }
      boardEl.appendChild(row);
    }
  }
  const rowEl = (r) => boardEl.children[r];

  function paintRow(r, word, result) {
    [...rowEl(r).children].forEach((tile, i) => {
      tile.textContent = word[i] || '';
      tile.className = 'tile' + (result ? ' ' + result[i] : word[i] ? ' filled' : '');
    });
  }

  function paintCurrent() {
    if (game.status === 'playing') paintRow(game.guesses.length, current);
  }

  // ------------------------------------------------------------- keyboard
  const LAYOUT = ['qwertyuiop', ' asdfghjkl ', '+zxcvbnm-'];
  function buildKeyboard() {
    keyboardEl.innerHTML = '';
    for (const line of LAYOUT) {
      const row = document.createElement('div');
      row.className = 'kb-row';
      for (const ch of line) {
        const key = document.createElement('button');
        key.type = 'button';
        if (ch === ' ') {
          key.className = 'key spacer';
          key.tabIndex = -1;
        } else if (ch === '+') {
          key.className = 'key wide';
          key.textContent = 'Enter';
          key.dataset.key = 'Enter';
        } else if (ch === '-') {
          key.className = 'key wide';
          key.textContent = '⌫';
          key.setAttribute('aria-label', 'Backspace');
          key.dataset.key = 'Backspace';
        } else {
          key.className = 'key';
          key.textContent = ch;
          key.dataset.key = ch;
        }
        row.appendChild(key);
      }
      keyboardEl.appendChild(row);
    }
  }

  function paintKeys() {
    const best = {};
    for (const { word, result } of game.guesses) {
      [...word].forEach((ch, i) => {
        if (!best[ch] || RANK[result[i]] > RANK[best[ch]]) best[ch] = result[i];
      });
    }
    keyboardEl.querySelectorAll('.key[data-key]').forEach((key) => {
      const state = best[key.dataset.key];
      key.className = key.className.replace(/ (correct|present|absent)/g, '') + (state ? ' ' + state : '');
    });
  }

  // ------------------------------------------------------------- feedback
  function toast(text, ms = 1500) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toasts').prepend(el);
    if (ms) setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 300); }, ms);
  }

  function shake(r) {
    const row = rowEl(r);
    row.classList.remove('shake');
    void row.offsetWidth;  // restart the animation
    row.classList.add('shake');
  }

  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  // ------------------------------------------------------------- input
  function press(key) {
    if (busy || !game || game.status !== 'playing') return;
    if (key === 'Enter') return submit();
    if (key === 'Backspace') current = current.slice(0, -1);
    else if (/^[a-z]$/i.test(key) && current.length < LEN) current += key.toLowerCase();
    else return;
    paintCurrent();
    game.draft = current;
    save(GAME_KEY, game);
  }

  async function submit() {
    const r = game.guesses.length;
    if (current.length < LEN) {
      shake(r);
      return toast('Not enough letters');
    }
    busy = true;
    let data;
    try {
      const res = await fetch('/api/wordle/guess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: game.date, guess: current, previous: game.guesses.map((g) => g.word) }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Something went wrong');
    } catch (err) {
      busy = false;
      shake(r);
      return toast(typeof err.message === 'string' ? err.message : 'Something went wrong');
    }

    const word = current;
    current = game.draft = '';
    game.guesses.push({ word, result: data.result });
    if (data.solved) game.status = 'won';
    else if (game.guesses.length >= MAX) game.status = 'lost';
    if (data.answer) game.answer = data.answer;
    save(GAME_KEY, game);
    if (game.status !== 'playing') recordResult();

    await reveal(r, word, data.result);
    paintKeys();

    if (game.status === 'won') {
      rowEl(r).classList.add('win');
      toast(PRAISE[r]);
      await wait(1800);
      showStats();
    } else if (game.status === 'lost') {
      toast(game.answer.toUpperCase(), 0);
      await wait(1500);
      showStats();
    }
    busy = false;
  }

  async function reveal(r, word, result) {
    const tiles = [...rowEl(r).children];
    tiles.forEach((tile, i) => {
      tile.classList.add('flip');
      // swap colour at the midpoint of each tile's flip
      setTimeout(() => {
        tile.textContent = word[i];
        tile.className = `tile flip ${result[i]}`;
      }, i * FLIP_MS + 250);
    });
    await wait((LEN - 1) * FLIP_MS + 500);
    tiles.forEach((tile) => tile.classList.remove('flip'));
  }

  // ------------------------------------------------------------- stats
  function recordResult() {
    const stats = load(STATS_KEY, emptyStats());
    if (stats.lastPlayed === game.date) return;  // already counted
    stats.lastPlayed = game.date;
    stats.played++;
    if (game.status === 'won') {
      stats.wins++;
      stats.dist[game.guesses.length - 1]++;
      stats.streak = stats.lastWin === previousDay(game.date) ? stats.streak + 1 : 1;
      stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
      stats.lastWin = game.date;
    } else {
      stats.streak = 0;
    }
    save(STATS_KEY, stats);
  }

  function previousDay(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  function showStats() {
    const stats = load(STATS_KEY, emptyStats());
    $('st-played').textContent = stats.played;
    $('st-win').textContent = stats.played ? Math.round((100 * stats.wins) / stats.played) : 0;
    $('st-streak').textContent = stats.streak;
    $('st-max').textContent = stats.maxStreak;

    const most = Math.max(1, ...stats.dist);
    const currentRow = game && game.status === 'won' ? game.guesses.length - 1 : -1;
    $('dist').innerHTML = stats.dist.map((n, i) => `
      <div class="dist-row${i === currentRow ? ' current' : ''}">
        <span>${i + 1}</span>
        <div class="bar-fill" style="width:${Math.max(7, (100 * n) / most)}%">${n}</div>
      </div>`).join('');

    const done = game && game.status !== 'playing';
    const line = $('result-line');
    line.hidden = !done;
    if (done) {
      line.innerHTML = game.status === 'won'
        ? `Solved in ${game.guesses.length}/${MAX}`
        : 'The word was <strong></strong>';
      if (game.status === 'lost') line.querySelector('strong').textContent = game.answer || '?????';
    }
    $('share-btn').hidden = !done;
    $('stats').hidden = false;
  }

  async function share() {
    const emoji = { correct: '🟩', present: '🟨', absent: '⬛' };
    const score = game.status === 'won' ? game.guesses.length : 'X';
    const text = [
      `Flohdle ${puzzle.number} ${score}/${MAX}`,
      '',
      ...game.guesses.map((g) => g.result.map((s) => emoji[s]).join('')),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied results to clipboard');
    } catch {
      toast("Couldn't copy to clipboard");
    }
  }

  // ------------------------------------------------------------- start
  async function init() {
    buildBoard();
    buildKeyboard();
    try {
      const res = await fetch('/api/wordle/puzzle');
      puzzle = await res.json();
      if (!res.ok) throw new Error(puzzle.detail);
    } catch (err) {
      $('subtitle').textContent = "Couldn't load today's puzzle";
      toast((err && err.message) || 'Puzzle unavailable', 0);
      return;
    }
    $('subtitle').textContent = `#${puzzle.number}`;

    const saved = load(GAME_KEY, null);
    game = saved && saved.date === puzzle.date
      ? saved
      : { date: puzzle.date, guesses: [], status: 'playing', answer: null };
    game.guesses.forEach((g, r) => paintRow(r, g.word, g.result));
    current = game.draft || '';
    paintCurrent();
    paintKeys();
    busy = false;

    if (game.status !== 'playing') showStats();
    else if (!load(STATS_KEY, null) && !game.guesses.length) {
      toast("Guess the word in 6 tries. Every guess must be a real word that uses all the hints so far.", 4000);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { $('stats').hidden = true; return; }
    if (!$('stats').hidden) return;
    if (e.key === 'Enter' && e.target.closest && e.target.closest('button')) e.preventDefault();
    press(e.key);
  });
  keyboardEl.addEventListener('click', (e) => {
    const key = e.target.closest('.key[data-key]');
    if (key) { press(key.dataset.key); key.blur(); }
  });
  $('stats-btn').addEventListener('click', showStats);
  $('stats-close').addEventListener('click', () => { $('stats').hidden = true; });
  $('stats').addEventListener('click', (e) => { if (e.target === $('stats')) $('stats').hidden = true; });
  $('share-btn').addEventListener('click', share);

  init();
})();
