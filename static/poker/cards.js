'use strict';
// Balatro-style pixel-art playing cards, drawn as crisp SVG on a 71x95 pixel grid.
(function () {
  const W = 71;
  const H = 95;
  const SUIT_COLORS = { h: '#f03464', d: '#f06b3f', s: '#403995', c: '#235955' };
  const FACE = '#f6f1e3';
  const EDGE = '#b9b09b';
  const SHADE = '#e2d9c4';
  const BACK_RED = '#d8423d';
  const BACK_DARK = '#a92f2c';
  const BACK_LIGHT = '#ee6d5f';
  const GOLD = '#f2b51d';
  const GOLD_SHADOW = '#8a5a12';

  // 7px-wide pixel suits.
  const SUIT_PX = {
    h: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
    d: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
    s: ['...#...', '..###..', '.#####.', '#######', '#######', '.##.##.', '...#...'],
    c: ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
  };

  // 5px-tall bitmap numerals.
  const GLYPHS = {
    A: ['.##.', '#..#', '####', '#..#', '#..#'],
    2: ['###.', '...#', '.##.', '#...', '####'],
    3: ['###.', '...#', '.##.', '...#', '###.'],
    4: ['#..#', '#..#', '####', '...#', '...#'],
    5: ['####', '#...', '###.', '...#', '###.'],
    6: ['.##.', '#...', '###.', '#..#', '.##.'],
    7: ['####', '...#', '..#.', '.#..', '.#..'],
    8: ['.##.', '#..#', '.##.', '#..#', '.##.'],
    9: ['.##.', '#..#', '.###', '...#', '.##.'],
    1: ['.#.', '##.', '.#.', '.#.', '###'],
    0: ['.##.', '#..#', '#..#', '#..#', '.##.'],
    J: ['.###', '...#', '...#', '#..#', '.##.'],
    Q: ['.##.', '#..#', '#..#', '#.#.', '.#.#'],
    K: ['#..#', '#.#.', '##..', '#.#.', '#..#'],
  };

  const CROWNS = {
    K: ['#...#...#', '##.###.##', '#########', '#########'],
    Q: ['....#....', '.#.###.#.', '#########', '.#######.'],
    J: ['..#####..', '.#######.', '#########', '#.#.#.#.#'],
  };

  // Pip columns (left x of a 14px-wide pip) and row positions (0 = top, 1 = bottom).
  const COLS = { L: 14, C: 28, R: 43 };
  const LAYOUTS = {
    2: [['C', 0], ['C', 1]],
    3: [['C', 0], ['C', 0.5], ['C', 1]],
    4: [['L', 0], ['R', 0], ['L', 1], ['R', 1]],
    5: [['L', 0], ['R', 0], ['C', 0.5], ['L', 1], ['R', 1]],
    6: [['L', 0], ['R', 0], ['L', 0.5], ['R', 0.5], ['L', 1], ['R', 1]],
    7: [['L', 0], ['R', 0], ['C', 0.25], ['L', 0.5], ['R', 0.5], ['L', 1], ['R', 1]],
    8: [['L', 0], ['R', 0], ['C', 0.25], ['L', 0.5], ['R', 0.5], ['C', 0.75], ['L', 1], ['R', 1]],
    9: [['L', 0], ['R', 0], ['L', 1 / 3], ['R', 1 / 3], ['C', 0.5], ['L', 2 / 3], ['R', 2 / 3], ['L', 1], ['R', 1]],
    T: [['L', 0], ['R', 0], ['C', 1 / 6], ['L', 1 / 3], ['R', 1 / 3], ['L', 2 / 3], ['R', 2 / 3], ['C', 5 / 6], ['L', 1], ['R', 1]],
  };

  // Draw a bitmap as merged horizontal runs of rects. `flip` rotates it 180 degrees.
  function px(rows, x, y, scale, color, flip = false) {
    const src = flip ? [...rows].reverse().map(r => [...r].reverse().join('')) : rows;
    let out = '';
    src.forEach((row, r) => {
      let c = 0;
      while (c < row.length) {
        if (row[c] !== '#') { c++; continue; }
        let end = c;
        while (end < row.length && row[end] === '#') end++;
        out += `<rect x="${x + c * scale}" y="${y + r * scale}" width="${(end - c) * scale}" height="${scale}"/>`;
        c = end;
      }
    });
    return `<g fill="${color}">${out}</g>`;
  }

  // Card silhouette with stepped (pixel) corners, inset by `i`.
  function body(color, i) {
    const w = W - 2 * i - 4;
    const h = H - 2 * i - 4;
    return `<path fill="${color}" d="M${i + 2} ${i}h${w}v1h1v1h1v${h}h-1v1h-1v1h-${w}v-1h-1v-1h-1v-${h}h1v-1h1z"/>`;
  }

  function corner(rank, suit, color) {
    const chars = rank === 'T' ? ['1', '0'] : [rank];
    let x = 3;
    let out = '';
    for (const ch of chars) {
      out += px(GLYPHS[ch], x, 3, 3, color);
      x += (GLYPHS[ch][0].length + 1) * 3;
    }
    out += px(SUIT_PX[suit], 5, 20, 1, color);
    return out;
  }

  function pips(rank, suit, color) {
    const bmp = SUIT_PX[suit];
    if (rank === 'A') {
      return px(bmp, 21, Math.round(H / 2 - bmp.length * 2), 4, color);
    }
    return LAYOUTS[rank].map(([col, f]) => {
      const cy = 27 + f * 41;
      return px(bmp, COLS[col], Math.round(cy - bmp.length), 2, color, f > 0.5);
    }).join('');
  }

  function court(rank, suit, color) {
    const bmp = SUIT_PX[suit];
    return `<rect x="14" y="20" width="43" height="55" fill="${color}" opacity=".16"/>`
      + `<g fill="${color}"><rect x="14" y="20" width="43" height="2"/><rect x="14" y="73" width="43" height="2"/>`
      + `<rect x="14" y="20" width="2" height="55"/><rect x="55" y="20" width="2" height="55"/></g>`
      + px(CROWNS[rank], 23, 26, 3, GOLD_SHADOW)
      + px(CROWNS[rank], 22, 25, 3, GOLD)
      + px(GLYPHS[rank], 27, 40, 4, color)
      + px(bmp, 32, 64, 1, color);
  }

  function face(code) {
    const rank = code[0];
    const suit = code[1];
    const color = SUIT_COLORS[suit];
    const middle = 'JQK'.includes(rank) ? court(rank, suit, color) : pips(rank, suit, color);
    const c = corner(rank, suit, color);
    return body(EDGE, 0) + body(FACE, 1)
      + `<rect x="3" y="${H - 4}" width="${W - 6}" height="2" fill="${SHADE}"/>`
      + c + `<g transform="rotate(180 ${W / 2} ${H / 2})">${c}</g>`
      + middle;
  }

  function back() {
    const small = ['.#.', '###', '.#.'];
    const outer = ['....#....', '...###...', '..#####..', '.#######.', '#########', '.#######.', '..#####..', '...###...', '....#....'];
    const middle = ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'];
    let lattice = '';
    for (let y = 8; y < H - 10; y += 8) {
      for (let x = 8 + ((y / 8) % 2) * 4; x < W - 10; x += 8) lattice += px(small, x, y, 1, BACK_LIGHT);
    }
    return body(EDGE, 0) + body(FACE, 1) + body(BACK_DARK, 4) + body(BACK_RED, 5)
      + lattice
      + px(outer, 22, 34, 3, BACK_DARK)
      + px(middle, 25, 37, 3, FACE)
      + px(small, 31, 43, 3, BACK_RED);
  }

  const cache = new Map();
  function svg(code) {
    if (!cache.has(code)) {
      const inner = code === '??' ? back() : face(code);
      cache.set(code, `<svg viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" aria-hidden="true">${inner}</svg>`);
    }
    return cache.get(code);
  }

  const RANK_NAMES = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10' };
  const SUIT_NAMES = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
  function label(code) {
    return code === '??' ? 'Face-down card' : `${RANK_NAMES[code[0]] || code[0]} of ${SUIT_NAMES[code[1]]}`;
  }

  // `i` staggers the idle sway so cards don't bob in unison.
  function html(code, cls = '', i = 0) {
    return `<div class="card ${code === '??' ? 'back' : ''} ${cls}" style="--i:${i}" title="${label(code)}">${svg(code)}</div>`;
  }

  window.Cards = { html, svg, SUIT_COLORS };
})();
