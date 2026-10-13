'use strict';
// Playing cards drawn as smooth SVG on a 71x95 grid, built for reading at a glance: every
// card is just a big suit in its top-left half and a big rank (2-10, A, K, Q, J) in its
// bottom-right half.
(function () {
  const W = 71;
  const H = 95;
  const RED = '#d42a35';
  const BLACK = '#1c1c22';
  const SUIT_COLORS = { h: RED, d: RED, s: BLACK, c: BLACK };
  const FACE = '#fdfcf8';
  const EDGE = '#c9c4b8';
  const BACK_RED = '#c8303a';
  const BACK_DARK = '#8f1d26';
  const FONT = `font-family="'Helvetica Neue', Arial, sans-serif" font-weight="700"`;

  // Suits drawn in a 100x100 box.
  const SUIT_PATHS = {
    h: '<path d="M50 90C22 68 4 50 4 30 4 15 15 5 29 5c10 0 17 6 21 14 4-8 11-14 21-14 14 0 25 10 25 25 0 20-18 38-46 60z"/>',
    d: '<path d="M50 2 88 50 50 98 12 50z"/>',
    s: '<path d="M50 3C62 22 95 38 95 61c0 15-12 24-25 24-8 0-13-4-17-9 1 10 5 16 13 21H34c8-5 12-11 13-21-4 5-9 9-17 9C17 85 5 76 5 61 5 38 38 22 50 3z"/>',
    c: '<circle cx="50" cy="27" r="22"/><circle cx="25" cy="58" r="22"/><circle cx="75" cy="58" r="22"/>'
      + '<circle cx="50" cy="52" r="12"/><path d="M47 55h6c1 18 5 30 14 42H33c9-12 13-24 14-42z"/>',
  };

  // A suit of `size` centred on (cx, cy).
  function suitAt(suit, cx, cy, size) {
    return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${size / 100})">${SUIT_PATHS[suit]}</g>`;
  }

  function body(fill, stroke) {
    return `<rect x=".75" y=".75" width="${W - 1.5}" height="${H - 1.5}" rx="5.5" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
  }

  function face(code) {
    const rank = code[0];
    const suit = code[1];
    const color = SUIT_COLORS[suit];
    const text = rank === 'T' ? '10' : rank;
    // "10" is squeezed a little so it fits the same corner as a single character.
    const squeeze = rank === 'T' ? ' textLength="50" lengthAdjust="spacingAndGlyphs"' : '';
    return body(FACE, EDGE)
      + `<g fill="${color}">${suitAt(suit, 24, 26, 36)}</g>`
      + `<text x="${W - 6}" y="${H - 8}" font-size="46" text-anchor="end" ${FONT} fill="${color}"${squeeze}>${text}</text>`;
  }

  // Diagonal lines both ways across a box, every `step` units: a diamond lattice. (Plain lines
  // rather than an SVG <pattern>, whose id would clash between the many cards on the page.)
  function lattice(x0, y0, x1, y1, step) {
    let d = '';
    for (let k = y0 - x1 + step / 2; k < y1 - x0; k += step) { // y = x + k
      const a = Math.max(x0, y0 - k);
      const b = Math.min(x1, y1 - k);
      d += `M${a} ${a + k}L${b} ${b + k}`;
    }
    for (let k = x0 + y0 + step / 2; k < x1 + y1; k += step) { // y = k - x
      const a = Math.max(x0, k - y1);
      const b = Math.min(x1, k - y0);
      d += `M${a} ${k - a}L${b} ${k - b}`;
    }
    return d;
  }

  // The back: a white border around a red panel with a fine diamond lattice and a centre medallion.
  function back() {
    return body(FACE, EDGE)
      + `<rect x="5" y="5" width="${W - 10}" height="${H - 10}" rx="3" fill="${BACK_RED}" stroke="${BACK_DARK}" stroke-width="1"/>`
      + `<path d="${lattice(5.5, 5.5, W - 5.5, H - 5.5, 7)}" stroke="${BACK_DARK}" stroke-width="1.3"/>`
      + `<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="2" fill="none" stroke="${FACE}" stroke-opacity=".55" stroke-width=".8"/>`
      + `<circle cx="${W / 2}" cy="${H / 2}" r="14" fill="${BACK_RED}" stroke="${FACE}" stroke-width="1.6"/>`
      + `<g fill="${FACE}">${suitAt('s', W / 2, H / 2, 15)}</g>`;
  }

  const cache = new Map();
  function svg(code) {
    if (!cache.has(code)) {
      const inner = code === '??' ? back() : face(code);
      cache.set(code, `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${inner}</svg>`);
    }
    return cache.get(code);
  }

  const RANK_NAMES = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10' };
  const SUIT_NAMES = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
  function label(code) {
    return code === '??' ? 'Face-down card' : `${RANK_NAMES[code[0]] || code[0]} of ${SUIT_NAMES[code[1]]}`;
  }

  // `i` staggers the idle sway so cards don't bob in unison. `flip` builds a two-sided card
  // (face plus back) so CSS can turn it over; see .card.flip in style.css.
  function html(code, cls = '', i = 0, flip = false) {
    const inner = flip && code !== '??'
      ? `<div class="flipper"><div class="face front">${svg(code)}</div><div class="face rear">${svg('??')}</div></div>`
      : svg(code);
    const classes = ['card', code === '??' ? 'back' : '', flip && code !== '??' ? 'flip' : '', cls].filter(Boolean).join(' ');
    return `<div class="${classes}" style="--i:${i}" title="${label(code)}">${inner}</div>`;
  }

  window.Cards = { html, svg, SUIT_COLORS };
})();
