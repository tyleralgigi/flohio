'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const SESSION_KEY = 'vgp.session';
const NAME_KEY = 'vgp.name';
const PREFS_KEY = 'vgp.prefs';
const SIDEBAR_KEY = 'vgp.sidebar';
const NUM_SLOTS = 9;
// Dealing a hand: a quick shuffle, then every hole card within DEAL_TIME ms. The server's
// DEAL_PAUSE covers all of it before anyone's clock starts.
const SHUFFLE_TIME = 400;
const DEAL_TIME = 1100;
const FLY_TIME = 380; // ms for a card to travel from the deck (roughly when it lands)
const BOARD_STEP = 260; // ms between board cards
const CHIP_TIME = 420; // ms for chips to slide across the felt
const SWEEP_PAUSE = { showdown: 1500, fold: 600 }; // ms the pot sits before sliding to the winner

const app = {
  code: null, token: null, me: null, ws: null, state: null,
  leaving: false, reconnectTimer: null,
  localStream: null, micOn: true, camOn: true,
  iceServers: [], peers: new Map(), remote: new Map(), pendingIce: new Map(),
  slots: [], layoutN: -1, lastFeedId: 0, boardKey: '', boardHand: 0, boardLen: 0,
  deadline: null, turnTotal: null, lastTick: null, settingsDirty: false,
  checkFold: null, autoActKey: null, unread: 0,
  stickers: [], effects: [], effectThumbs: [], reactTab: 'stickers',
  potKey: '', potToken: 0, potShown: 0,
};

// ------------------------------------------------------------------ utils
function store(key, val) {
  try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = n => Number(n).toLocaleString();

let toastTimer;
function toast(msg, kind = 'error') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind === 'info' ? 'info' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Please check your inputs');
  return data;
}

const cardHtml = (c, cls = '', i = 0, flip = false) => Cards.html(c, cls, i, flip);
const BOT_LABELS = { fish: 'Fish', shark: 'Shark', maniac: 'Maniac' };

// ------------------------------------------------------------------ preferences
const DEFAULT_PREFS = { sfx: 70, voice: 100, ui: 100, motion: true }; // volumes and UI size are percentages
const prefs = { ...DEFAULT_PREFS, ...(load(PREFS_KEY) || {}) };

function applyPrefs() {
  document.documentElement.style.setProperty('--ui-scale', prefs.ui / 100);
  Sound.setVolume();
  for (const slot of app.slots) slot.video.volume = prefs.voice / 100;
  document.documentElement.classList.toggle('still', !prefs.motion);
  for (const key of Object.keys(DEFAULT_PREFS)) {
    const input = $(`#pref-${key}`);
    if (input.type === 'checkbox') input.checked = prefs[key];
    else {
      input.value = prefs[key];
      $(`#pref-${key}-out`).textContent = `${prefs[key]}%`;
    }
  }
}

// ------------------------------------------------------------------ sound
// Every effect is synthesized with WebAudio and routed through one master gain (the volume setting).
const Sound = (() => {
  let ctx = null;
  let master = null;
  let noiseBuf = null;

  function init() {
    if (!ctx) {
      try {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      } catch { ctx = null; return null; }
      setVolume();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function setVolume() {
    if (master) master.gain.value = (prefs.sfx / 100) ** 1.5;
  }

  function env(t, peak, attack, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(master);
    return g;
  }

  function noise(t, { freq, q = 1, type = 'bandpass', peak, attack = 0.002, decay }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    src.connect(filter).connect(env(t, peak, attack, decay));
    src.start(t, Math.random() * 0.3, attack + decay + 0.02);
  }

  function tone(t, { freq, slide, type = 'sine', peak, attack = 0.005, decay }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + attack + decay);
    osc.connect(env(t, peak, attack, decay));
    osc.start(t);
    osc.stop(t + attack + decay + 0.02);
  }

  // One clay chip clacking against another: a bright click with a short ring.
  function clack(t, level) {
    noise(t, { freq: 3500 + Math.random() * 1500, q: 2.5, peak: 0.4 * level, decay: 0.03 });
    tone(t, { freq: 2200 + Math.random() * 900, type: 'triangle', peak: 0.07 * level, attack: 0.002, decay: 0.06 });
  }

  const effects = {
    // Knock knock: two knuckle raps on the rail.
    check(t) {
      for (const dt of [0, 0.16]) {
        tone(t + dt, { freq: 190, slide: 85, peak: 0.7, attack: 0.003, decay: 0.13 });
        noise(t + dt, { freq: 1100, q: 0.9, type: 'lowpass', peak: 0.6, decay: 0.05 });
      }
    },
    // A short stack of chips pushed into the pot.
    bet(t) {
      [0, 0.045, 0.085, 0.13].forEach((dt, i) => clack(t + dt + Math.random() * 0.015, 1 - i * 0.15));
    },
    // A pile of chips raked in, with a bright chime on top.
    win(t) {
      for (let i = 0; i < 16; i++) clack(t + i * 0.04 + Math.random() * 0.03, 0.95 - i * 0.04);
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) =>
        tone(t + 0.08 + i * 0.09, { freq, type: 'triangle', peak: 0.13, attack: 0.005, decay: 0.4 }));
    },
    // A card flicked across the felt.
    deal(t) {
      noise(t, { freq: 2400, q: 0.7, peak: 0.3, attack: 0.006, decay: 0.07 });
    },
    // A card snapped face up.
    flip(t) {
      noise(t, { freq: 4200, q: 1.4, peak: 0.22, attack: 0.002, decay: 0.035 });
      tone(t, { freq: 620, slide: 900, type: 'triangle', peak: 0.05, attack: 0.002, decay: 0.05 });
    },
    turn(t) {
      tone(t, { freq: 880, peak: 0.18, attack: 0.02, decay: 0.28 });
    },
    // The clock is running out.
    tick(t) {
      tone(t, { freq: 1320, type: 'square', peak: 0.06, attack: 0.002, decay: 0.05 });
    },
  };

  function play(name, delayMs = 0) {
    if (prefs.sfx <= 0 || !init()) return;
    try { effects[name](ctx.currentTime + delayMs / 1000); } catch {}
  }

  return { init, play, setVolume };
})();

// Browsers only let audio start after the user interacts with the page.
document.addEventListener('pointerdown', () => Sound.init());
document.addEventListener('keydown', () => Sound.init());

// ------------------------------------------------------------------ lobby
function showRejoin() {
  const sess = load(SESSION_KEY);
  const wanted = $('#join-code').value.trim().toUpperCase();
  const show = sess && (!wanted || sess.code === wanted);
  $('#rejoin').hidden = !show;
  if (show) $('#rejoin-code').textContent = sess.code;
}

function initLobby() {
  const params = new URLSearchParams(location.search);
  $('#name').value = load(NAME_KEY) || '';
  $('#join-code').value = (params.get('code') || '').toUpperCase();
  showRejoin();

  $$('.tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
    $('#join-form').hidden = tab.dataset.tab !== 'join';
    $('#host-form').hidden = tab.dataset.tab !== 'host';
    $('#lobby-error').textContent = '';
  }));

  const getName = () => {
    const name = $('#name').value.trim();
    if (!name) { $('#lobby-error').textContent = 'Enter your name first'; $('#name').focus(); return null; }
    store(NAME_KEY, name);
    return name;
  };

  const submit = (form, buildRequest) => form.addEventListener('submit', async e => {
    e.preventDefault();
    $('#lobby-error').textContent = '';
    const name = getName();
    if (!name) return;
    const button = $('button[type=submit]', form);
    button.disabled = true;
    try {
      const { code, token } = await buildRequest(name);
      await enterGame(code, token);
    } catch (err) {
      $('#lobby-error').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  submit($('#join-form'), name => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 5) throw new Error('Lobby codes are 5 characters');
    return api('/api/poker/join', { code, name });
  });

  submit($('#host-form'), name => api('/api/poker/create', {
    name,
    small_blind: Number($('#host-sb').value),
    big_blind: Number($('#host-bb').value),
    starting_stack: Number($('#host-stack').value),
    turn_time: Number($('#host-timer').value),
  }));

  $('#join-code').addEventListener('input', showRejoin);
  $('#rejoin-btn').addEventListener('click', () => {
    const sess = load(SESSION_KEY);
    if (sess) enterGame(sess.code, sess.token);
  });
  $('#forget-btn').addEventListener('click', () => { store(SESSION_KEY, null); showRejoin(); });
}

async function enterGame(code, token) {
  app.code = code;
  app.token = token;
  app.leaving = false;
  store(SESSION_KEY, { code, token });
  history.replaceState(null, '', `/poker?code=${code}`);
  await startMedia();
  $('#lobby').hidden = true;
  $('#game').hidden = false;
  $('#code').textContent = code;
  if (!app.slots.length) buildSeats();
  connect();
}

function exitToLobby(forget = true) {
  app.leaving = true;
  clearTimeout(app.reconnectTimer);
  try { app.ws && app.ws.close(); } catch {}
  app.ws = null;
  for (const id of [...app.peers.keys()]) closePeer(id);
  if (app.localStream) app.localStream.getTracks().forEach(t => t.stop());
  app.localStream = null;
  if (forget) store(SESSION_KEY, null);
  app.state = null;
  openPicker(false);
  app.layoutN = -1;
  app.lastFeedId = 0;
  app.boardKey = '';
  app.potKey = '';
  app.potToken++;
  showPot(0, 0, 1);
  app.checkFold = null;
  app.autoActKey = null;
  app.unread = 0;
  renderUnread();
  $('#feed').innerHTML = '';
  for (const slot of app.slots) {
    slot.video.srcObject = null;
    stopEffect(slot);
    showBet(slot, 0, 1);
    slot.betPid = null;
    slot.betToken++;
    slot.pid = null;
    slot.holeKey = '';
    slot.seat.classList.add('empty');
  }
  $('#conn-banner').hidden = true;
  $('#game').hidden = true;
  $('#lobby').hidden = false;
  document.title = 'Very Good Poker';
  showRejoin();
}

// ------------------------------------------------------------------ media
const hasTrack = kind => !!app.localStream && app.localStream.getTracks().some(t => t.kind === kind);

async function startMedia() {
  if (app.localStream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Webcams need HTTPS (or localhost). Playing without video.');
    return;
  }
  const video = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 20, max: 24 } };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  for (const constraints of [{ video, audio }, { video }, { audio }]) {
    try {
      app.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch {}
  }
  if (!app.localStream) toast("Couldn't access your camera or mic. You can still play.");
  app.camOn = hasTrack('video');
  app.micOn = hasTrack('audio');
  updateMediaButtons();
}

function updateMediaButtons() {
  const mic = $('#mic-btn');
  const cam = $('#cam-btn');
  mic.disabled = !hasTrack('audio');
  cam.disabled = !hasTrack('video');
  mic.textContent = app.micOn ? 'Mic on' : 'Muted';
  cam.textContent = app.camOn ? 'Cam on' : 'Cam off';
  mic.classList.toggle('off', !app.micOn);
  cam.classList.toggle('off', !app.camOn);
}

function sendMedia() {
  send({ type: 'media', cam: app.camOn && hasTrack('video'), mic: app.micOn && hasTrack('audio') });
}

function toggleTrack(kind) {
  if (!hasTrack(kind)) return;
  const key = kind === 'audio' ? 'micOn' : 'camOn';
  app[key] = !app[key];
  app.localStream.getTracks().filter(t => t.kind === kind).forEach(t => { t.enabled = app[key]; });
  updateMediaButtons();
  sendMedia();
  updateVideos();
}

// ------------------------------------------------------------------ WebRTC mesh
function closePeer(id) {
  const pc = app.peers.get(id);
  if (pc) { try { pc.close(); } catch {} }
  app.peers.delete(id);
  app.remote.delete(id);
  app.pendingIce.delete(id);
}

function makePeer(id) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: app.iceServers });
  app.peers.set(id, pc);
  pc.onicecandidate = e => {
    if (e.candidate) send({ type: 'signal', to: id, data: { candidate: e.candidate.toJSON() } });
  };
  pc.ontrack = e => {
    if (app.peers.get(id) !== pc) return;
    const prev = app.remote.get(id);
    const tracks = (prev ? prev.getTracks() : []).filter(t => t.kind !== e.track.kind);
    app.remote.set(id, new MediaStream([...tracks, e.track]));
    updateVideos();
  };
  pc.onconnectionstatechange = () => {
    // If a connection dies, the peer with the lower id re-dials.
    if (pc.connectionState === 'failed' && app.peers.get(id) === pc && app.me < id) {
      setTimeout(() => { if (app.peers.get(id) === pc) callPeer(id); }, 1000);
    }
  };
  return pc;
}

async function callPeer(id) {
  const pc = makePeer(id);
  const stream = app.localStream;
  for (const kind of ['audio', 'video']) {
    const track = stream && stream.getTracks().find(t => t.kind === kind);
    if (track) pc.addTrack(track, stream);
    else pc.addTransceiver(kind, { direction: 'recvonly' });
  }
  try {
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: 'signal', to: id, data: { sdp: pc.localDescription } });
  } catch (err) {
    console.warn('offer failed', err);
  }
}

async function flushIce(id, pc) {
  const queued = app.pendingIce.get(id) || [];
  app.pendingIce.delete(id);
  for (const c of queued) { try { await pc.addIceCandidate(c); } catch {} }
}

async function onSignal(from, data) {
  if (!data) return;
  try {
    if (data.sdp && data.sdp.type === 'offer') {
      const pc = makePeer(from);
      await pc.setRemoteDescription(data.sdp);
      if (app.localStream) app.localStream.getTracks().forEach(t => pc.addTrack(t, app.localStream));
      await pc.setLocalDescription(await pc.createAnswer());
      send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
      await flushIce(from, pc);
    } else if (data.sdp && data.sdp.type === 'answer') {
      const pc = app.peers.get(from);
      if (pc && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(data.sdp);
        await flushIce(from, pc);
      }
    } else if (data.candidate) {
      const pc = app.peers.get(from);
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        if (!app.pendingIce.has(from)) app.pendingIce.set(from, []);
        app.pendingIce.get(from).push(data.candidate);
      }
    }
  } catch (err) {
    console.warn('signal error', err);
  }
}

let audioBlocked = false;
function updateVideos() {
  for (const slot of app.slots) {
    const pid = slot.pid;
    const isMe = !!pid && pid === app.me;
    const stream = !pid ? null : isMe ? app.localStream : (app.remote.get(pid) || null);
    if (slot.video.srcObject !== stream) {
      slot.video.srcObject = stream;
      slot.video.muted = isMe || audioBlocked;
      slot.video.volume = prefs.voice / 100;
      if (stream) {
        slot.video.play().catch(() => {
          // Browser blocked autoplay with sound: play muted until the user clicks.
          if (isMe || audioBlocked) return;
          audioBlocked = true;
          slot.video.muted = true;
          slot.video.play().catch(() => {});
          toast('Click anywhere to hear the table', 'info');
          document.addEventListener('click', () => {
            audioBlocked = false;
            for (const s of app.slots) if (s.pid && s.pid !== app.me) s.video.muted = false;
          }, { once: true });
        });
      }
    }
    const p = app.state && app.state.players.find(x => x.id === pid);
    const camLive = stream && stream.getVideoTracks().length > 0 && (isMe ? app.camOn : !p || p.cam_on);
    slot.avatar.hidden = !!camLive;
  }
}

// ------------------------------------------------------------------ socket
function connect() {
  clearTimeout(app.reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/poker/${app.code}?token=${encodeURIComponent(app.token)}`);
  app.ws = ws;
  ws.onopen = () => { $('#conn-banner').hidden = true; sendMedia(); };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (app.ws !== ws || app.leaving) return;
    $('#conn-banner').hidden = false;
    app.reconnectTimer = setTimeout(connect, 2000);
  };
}

function send(msg) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(msg));
}

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      app.me = msg.id;
      app.iceServers = msg.ice_servers || [];
      msg.peers.forEach(id => callPeer(id));
      buildPicker(msg.stickers || [], msg.effects || []);
      break;
    case 'reaction':
      if (msg.effect) showEffect(msg.id, msg.effect);
      else showSticker(msg.id, msg.sticker);
      break;
    case 'state':
      render(msg.state);
      break;
    case 'peer_joined':
      closePeer(msg.id); // they'll send us an offer
      break;
    case 'peer_left':
      closePeer(msg.id);
      updateVideos();
      break;
    case 'signal':
      onSignal(msg.from, msg.data);
      break;
    case 'error':
      toast(msg.message);
      break;
    case 'invalid_session':
      toast('That table no longer exists');
      exitToLobby();
      break;
    case 'kicked':
      toast('The host removed you from the table');
      exitToLobby();
      break;
    case 'replaced':
      toast('This table was opened in another tab');
      exitToLobby(false);
      break;
  }
}

// ------------------------------------------------------------------ table rendering
// The fire around an all-in player: flames rising from the top edge and both sides of the
// camera (warped by the #fire-warp filter in index.html), plus a few drifting embers.
// Every seat gets its own random arrangement; it only animates while shown.
function fireHtml() {
  const rand = (a, b) => (a + Math.random() * (b - a)).toFixed(2);
  const flame = (x, y, size) => `<i style="--x:${x}%;--y:${y}%;--s:${size}%;--d:${rand(0.8, 1.4)}s;`
    + `--delay:${rand(-1.4, 0)}s;--drift:${rand(-25, 25)}%"></i>`;
  const flames = [];
  for (let i = 0; i < 20; i++) flames.push(flame(rand(-4, 104), rand(-2, 10), rand(24, 38))); // top edge
  for (let i = 0; i < 12; i++) flames.push(flame(rand(-6, 4), rand(12, 100), rand(20, 32))); // left side
  for (let i = 0; i < 12; i++) flames.push(flame(rand(96, 106), rand(12, 100), rand(20, 32))); // right side
  const embers = [];
  for (let i = 0; i < 7; i++) {
    embers.push(`<i style="--x:${rand(-8, 104)}%;--d:${rand(1.6, 2.6)}s;--delay:${rand(-2.6, 0)}s;`
      + `--drift:${rand(-300, 300)}%"></i>`);
  }
  return `<div class="fire" aria-hidden="true"><div class="flames">${flames.join('')}</div>`
    + `<div class="embers">${embers.join('')}</div></div>`;
}

function buildSeats() {
  const table = $('#table');
  for (let i = 0; i < NUM_SLOTS; i++) {
    const seat = document.createElement('div');
    seat.className = 'seat empty';
    seat.innerHTML = `
      <div class="last-action"></div>
      <div class="video-wrap">
        <video autoplay playsinline></video>
        <div class="avatar"></div>
        <div class="badges"></div>
        <div class="countdown"></div>
        <div class="timer"><div></div></div>
      </div>
      <div class="fx" aria-hidden="true"></div>
      ${fireHtml()}
      <div class="blind-chip" hidden></div>
      <div class="plate"><div class="pname"></div><div class="pstack"></div></div>
      <div class="hand-name"></div>
      <div class="hole"></div>`;
    const bet = document.createElement('div');
    bet.className = 'bet';
    const dealer = document.createElement('div');
    dealer.className = 'dealer-btn';
    dealer.textContent = 'D';
    dealer.title = 'Dealer button';
    dealer.hidden = true;
    table.append(seat, bet, dealer);
    const video = $('video', seat);
    video.volume = prefs.voice / 100;
    app.slots.push({
      seat, bet, dealer, video, pid: null, holeKey: '', avatarKey: '',
      avatar: $('.avatar', seat), badges: $('.badges', seat),
      timer: $('.timer div', seat), countdown: $('.countdown', seat),
      name: $('.pname', seat), stack: $('.pstack', seat), handName: $('.hand-name', seat),
      blind: $('.blind-chip', seat), hole: $('.hole', seat), last: $('.last-action', seat),
      fx: $('.fx', seat), effect: null,
      betPid: null, betTarget: 0, betShown: 0, betToken: 0,
    });
  }
}

// Spread `n` players evenly around the table. Slot 0 is you, bottom centre;
// the rest follow clockwise (to your left), matching the order of play.
function layoutSlots(n) {
  app.layoutN = n;
  app.slots.forEach((slot, i) => {
    const a = (90 + i * 360 / Math.max(n, 1)) * Math.PI / 180;
    const b = a + 0.3;
    slot.seat.style.left = `${50 + 43 * Math.cos(a)}%`;
    slot.seat.style.top = `${50 + 41 * Math.sin(a)}%`;
    slot.bet.style.left = `${50 + 27 * Math.cos(a)}%`;
    slot.bet.style.top = `${49 + 21 * Math.sin(a)}%`;
    // Bets near the top seats hang their chips below the label, clear of the seat.
    slot.bet.classList.toggle('far', Math.sin(a) < -0.3);
    slot.dealer.style.left = `${50 + 31 * Math.cos(b)}%`;
    slot.dealer.style.top = `${48 + 29 * Math.sin(b)}%`;
  });
}

const inProgress = s => ['preflop', 'flop', 'turn', 'river'].includes(s.phase);

function render(s) {
  const prev = app.state;
  app.state = s;
  app.me = s.me;
  const me = s.players.find(p => p.id === s.me);
  const isHost = s.host_id === s.me;

  $('#blinds-info').innerHTML = `Blinds ${fmt(s.settings.small_blind)}/${fmt(s.settings.big_blind)}`
    + (s.hand_no ? `<span class="hand-no">Hand #${s.hand_no}</span>` : '');

  const seated = [...s.players].sort((a, b) => a.seat - b.seat);
  const myIdx = Math.max(0, seated.findIndex(p => p.id === s.me));
  const bySlot = seated.slice(myIdx).concat(seated.slice(0, myIdx));
  if (bySlot.length !== app.layoutN) layoutSlots(bySlot.length);
  const winners = new Set(s.results.filter(r => r.hand).flatMap(r => r.winners));
  const uncontested = s.results.length === 1 && !s.results[0].hand;
  if (uncontested) s.results[0].winners.forEach(id => winners.add(id));
  const winCards = new Set(s.results.flatMap(r => r.cards));

  const deck = $('#deck');
  deck.hidden = !(inProgress(s) || s.phase === 'complete');
  if (!deck.children.length) deck.innerHTML = [0, 1, 2].map(i => cardHtml('??', '', i)).join('');

  // A new hand: shuffle, then deal hole cards one at a time, clockwise from the left of the button.
  let deal = null;
  if (prev && prev.hand_no !== s.hand_no && s.phase === 'preflop') {
    const dealt = seated.filter(p => p.in_hand && p.cards.length);
    const order = [...dealt.filter(p => p.seat > s.dealer_seat), ...dealt.filter(p => p.seat <= s.dealer_seat)];
    const step = Math.min(140, DEAL_TIME / Math.max(1, order.length * 2));
    deal = {
      order: new Map(order.map((p, i) => [p.id, i])), n: order.length, step,
      total: SHUFFLE_TIME + step * order.length * 2 + FLY_TIME,
    };
    deck.classList.remove('shuffle');
    void deck.offsetWidth; // restart the shuffle animation
    deck.classList.add('shuffle');
  }
  // Hold back your hand's name until the cards that change it have turned face up.
  const newBoard = prev && prev.hand_no === s.hand_no ? s.board.length - prev.board.length : 0;
  const sweep = sweepTime(prev, s);
  const nameDelay = deal ? deal.total + 380
    : newBoard > 0 ? sweep + (newBoard - 1) * BOARD_STEP + FLY_TIME + 380 : 0;
  app.slots.forEach((slot, i) => renderSeat(slot, bySlot[i] || null, s, winners, winCards, deal, nameDelay));

  renderChips(s, prev, sweep);
  renderBoard(s, winCards, !prev, sweep);
  $('#banner').innerHTML = s.results
    .filter(r => r.label !== 'Returned')
    .map(r => {
      const multi = s.results.filter(x => x.label !== 'Returned').length > 1;
      const who = r.names.map(esc).join(' & ');
      return `<div>${multi ? esc(r.label) + ': ' : ''}${who} ${r.names.length > 1 ? 'split' : 'wins'} ${fmt(r.amount)}${r.hand ? ' — ' + esc(r.hand) : ''}</div>`;
    }).join('');

  const autoActing = autoCheckFold(s);
  const newTurn = !!s.actions && !autoActing && !(prev && prev.actions && prev.hand_no === s.hand_no
    && prev.phase === s.phase && prev.current_bet === s.current_bet);
  if (newTurn) Sound.play('turn', deal ? deal.total : 0);
  document.title = s.actions && !autoActing ? '▶ Your turn — Very Good Poker' : 'Very Good Poker';

  renderActions(s, newTurn, autoActing);
  renderPreAction(s, me);
  renderStatus(s, me, isHost, autoActing);
  renderSidebar(s, me, isHost);
  const sounds = renderFeed(s.feed, !prev);
  if (prev) playFeedSounds(sounds);

  if (s.to_act && s.turn_remaining != null) {
    app.deadline = performance.now() + s.turn_remaining * 1000;
    app.turnTotal = s.turn_total;
  } else {
    app.deadline = null;
  }
  updateVideos();
}

function renderSeat(slot, p, s, winners, winCards, deal, nameDelay) {
  slot.pid = p ? p.id : null;
  slot.seat.classList.toggle('empty', !p);
  if (!p) {
    slot.dealer.hidden = true;
    slot.blind.hidden = true;
    slot.hole.innerHTML = '';
    slot.holeKey = '';
    slot.handName.textContent = '';
    return;
  }
  const cl = slot.seat.classList;
  cl.toggle('me', p.id === s.me);
  cl.toggle('acting', s.to_act === p.id);
  cl.toggle('folded', p.in_hand && p.folded && inProgress(s));
  cl.toggle('away', p.sitting_out || !p.connected);
  cl.toggle('winner', winners.has(p.id));
  cl.toggle('all-in', p.in_hand && p.all_in && !p.folded);

  slot.name.textContent = (p.id === s.host_id ? '★ ' : '') + p.name;
  slot.stack.textContent = p.all_in && inProgress(s) ? 'ALL-IN' : fmt(p.stack);
  slot.last.textContent = p.last_action;
  const avatarKey = p.is_bot ? `bot:${p.bot_style}` : `human:${p.name}`;
  if (slot.avatarKey !== avatarKey) {
    slot.avatarKey = avatarKey;
    slot.avatar.classList.toggle('bot', p.is_bot);
    slot.avatar.innerHTML = p.is_bot
      ? `${cardHtml('??', '', p.seat)}<div class="bot-style">${esc(BOT_LABELS[p.bot_style] || 'Bot')}</div>`
      : esc(p.name.slice(0, 2).toUpperCase());
  }

  const badges = [];
  if (p.is_bot) badges.push('<span class="badge bot">BOT</span>');
  if (!p.connected) badges.push('<span class="badge warn">Offline</span>');
  else if (p.sitting_out) badges.push('<span class="badge">Away</span>');
  if (!p.mic_on && !p.is_bot) badges.push('<span class="badge" title="Muted">🔇</span>');
  const badgeHtml = badges.join('');
  if (slot.badges.innerHTML !== badgeHtml) slot.badges.innerHTML = badgeHtml;

  const cardsKey = `${s.hand_no}|${p.cards.join()}`;
  const holeKey = `${cardsKey}|${p.folded}|${winners.has(p.id) ? [...winCards].join() : ''}`;
  const dealIdx = deal ? deal.order.get(p.id) : undefined;
  if (holeKey !== slot.holeKey || dealIdx !== undefined) {
    // Cards turned face up mid-hand (a showdown) flip over where they sit.
    const revealed = slot.holeKey.split('|')[0] === String(s.hand_no) && !slot.holeKey.startsWith(cardsKey);
    slot.holeKey = holeKey;
    slot.hole.classList.toggle('up', p.id !== s.me && p.cards.length > 0 && p.cards[0] !== '??');
    slot.hole.innerHTML = p.cards.map((c, i) => {
      const cls = [p.folded ? 'dim' : '', winners.has(p.id) && winCards.has(c) ? 'win' : ''];
      return cardHtml(c, cls.join(' '), p.seat * 2 + i, revealed || dealIdx !== undefined);
    }).join('');
    if (dealIdx !== undefined) dealHole(slot, dealIdx, deal);
    else if (revealed) Sound.play('flip');
  }

  if (slot.handName.textContent !== (p.hand || '') || (deal && p.id === s.me)) {
    slot.handName.textContent = p.hand || '';
    slot.handName.classList.remove('late');
    if (nameDelay && p.id === s.me) {
      void slot.handName.offsetWidth; // restart the fade-in
      slot.handName.style.setProperty('--name-delay', `${nameDelay}ms`);
      slot.handName.classList.add('late');
    }
  }
  slot.handName.title = p.hand ? `${p.id === s.me ? 'Your' : `${p.name}'s`} best hand` : '';
  slot.dealer.hidden = !s.hand_no || s.dealer_seat !== p.seat;
  const blind = !s.hand_no ? '' : p.seat === s.sb_seat ? 'sb' : p.seat === s.bb_seat ? 'bb' : '';
  slot.blind.hidden = !blind;
  slot.blind.className = `blind-chip ${blind}`;
  slot.blind.textContent = blind.toUpperCase();
  slot.blind.title = blind === 'sb' ? 'Small blind' : blind === 'bb' ? 'Big blind' : '';
}

// Send a card flying from the deck to where it sits, starting after `delay` ms. A two-sided
// card (.flip) then turns face up as it lands.
function flyFromDeck(el, delay) {
  const deck = $('#deck').getBoundingClientRect();
  const from = deck.width ? deck : $('#table').getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height * (deck.width ? 0.5 : 0.48);
  el.style.setProperty('--flip-delay', `${delay + FLY_TIME}ms`);
  // Measure before adding .deal, because the animation's first frame moves the card.
  const r = el.getBoundingClientRect();
  el.style.setProperty('--fx', `${fx - (r.left + r.width / 2)}px`);
  el.style.setProperty('--fy', `${fy - (r.top + r.height / 2)}px`);
  el.style.setProperty('--deal-delay', `${delay}ms`);
  el.classList.add('deal');
  Sound.play('deal', delay);
  if (el.classList.contains('flip')) Sound.play('flip', delay + FLY_TIME);
}

// Card j for the k-th player dealt leaves the deck at shuffle + (j * players + k) * step.
// Only your own cards are two-sided, so only they flip face up.
function dealHole(slot, k, deal) {
  $$('.card', slot.hole).forEach((el, j) => flyFromDeck(el, SHUFFLE_TIME + (j * deal.n + k) * deal.step));
}

function renderBoard(s, winCards, quiet, delay = 0) {
  const key = `${s.hand_no}|${s.board.join()}|${[...winCards].join()}`;
  if (key === app.boardKey) return;
  const sameHand = app.boardHand === s.hand_no;
  const oldLen = sameHand ? app.boardLen : 0;
  app.boardKey = key;
  app.boardHand = s.hand_no;
  app.boardLen = s.board.length;
  const fresh = i => !quiet && i >= oldLen;
  $('#board').innerHTML = s.board.map((c, i) => {
    const cls = [winCards.size && !winCards.has(c) ? 'dim' : '', winCards.has(c) ? 'win' : ''];
    return cardHtml(c, cls.join(' '), i, fresh(i));
  }).join('');
  // New board cards slide out of the deck face down, one at a time, and flip over where they land.
  $$('#board .card').forEach((el, i) => {
    if (fresh(i)) flyFromDeck(el, delay + (i - oldLen) * BOARD_STEP);
  });
}

function playFeedSounds(sounds) {
  let delay = 0;
  let won = false;
  for (const name of sounds) {
    if (name === 'win') {
      if (won) continue; // one rake for all the pots
      won = true;
      delay += 250;
    }
    Sound.play(name, delay);
    delay += 220;
  }
}

// ------------------------------------------------------------------ chips
// Bets and the pot are piles of chips that grow with what they're worth in big blinds: a few
// chips for a blind, a few dozen for a big pot. Columns get taller, then there are more of them,
// and the bigger the pile the pricier the colours at its front.
const CHIP_COLORS = ['red', 'green', 'black', 'purple', 'gold'];
const CHIPS_PER_COLUMN = 7;
const MAX_CHIPS = 42;

function chipPileHtml(amount, bb) {
  if (!(amount > 0)) return '';
  const v = amount / Math.max(1, bb);
  const n = Math.min(MAX_CHIPS, Math.max(1, Math.ceil(3 * Math.log2(1 + 2 * v))));
  const tier = v < 3 ? 0 : v < 15 ? 1 : v < 60 ? 2 : v < 250 ? 3 : 4;
  const cols = [];
  for (let left = n, i = 0; left > 0; left -= CHIPS_PER_COLUMN, i++) {
    const color = CHIP_COLORS[Math.max(0, tier - i)];
    cols.push(`<span class="chip-col ${color}">${'<i></i>'.repeat(Math.min(left, CHIPS_PER_COLUMN))}</span>`);
  }
  return `<span class="chips" aria-hidden="true">${cols.join('')}</span>`;
}

function showBet(slot, amount, bb) {
  slot.betShown = amount;
  slot.bet.innerHTML = amount > 0 ? `${chipPileHtml(amount, bb)}<span class="amt">${fmt(amount)}</span>` : '';
}

// The pile is the chips already in the middle; the label counts the bets still out in front too.
function showPot(pile, label, bb) {
  app.potShown = pile;
  $('#pot').innerHTML = label > 0 ? `${chipPileHtml(pile, bb)}<span class="amt">Pot ${fmt(label)}</span>` : '';
}

// Where chips leave from or land (a flying pile is placed by its base): the middle of a seat,
// the base of the pile already on a bet or the pot, or where that pile's base will be.
function chipPoint(el, table) {
  const pile = $('.chips', el);
  const r = (pile || el).getBoundingClientRect();
  let y = r.top + r.height / 2;
  if (pile) y = r.bottom;
  else if (el.classList.contains('far')) y = r.bottom + table.width * 0.03 * prefs.ui / 100;
  else if (!el.classList.contains('seat')) y = r.top;
  return { x: r.left + r.width / 2 - table.left, y: y - table.top };
}

// Slide a pile worth `amount` across the table from one element to another.
function flyChips(amount, bb, from, to, delay = 0) {
  const table = $('#table');
  const t = table.getBoundingClientRect();
  const a = chipPoint(from, t);
  const b = chipPoint(to, t);
  const el = document.createElement('div');
  el.className = 'chip-flight';
  el.innerHTML = chipPileHtml(amount, bb);
  el.style.left = `${a.x}px`;
  el.style.top = `${a.y}px`;
  table.append(el);
  const done = () => el.remove();
  el.animate([
    { translate: '0 0', opacity: 0 },
    { opacity: 1, offset: 0.15 },
    { translate: `${b.x - a.x}px ${b.y - a.y}px`, opacity: 1 },
  ], { duration: CHIP_TIME, delay, easing: 'cubic-bezier(.3, .6, .35, 1)', fill: 'backwards' }).finished.then(done, done);
}

// How long new board cards wait while this update's bets are swept into the pot.
function sweepTime(prev, s) {
  if (!prev || !prefs.motion || prev.hand_no !== s.hand_no) return 0;
  const bets = new Map(s.players.map(p => [p.id, p.bet]));
  return prev.players.some(p => p.bet > (bets.get(p.id) || 0)) ? CHIP_TIME : 0;
}

// Chips follow the betting: each bet slides from the player to the felt in front of them, the
// bets are swept into the pot when the street ends (`sweep` ms, before the next card comes out),
// and once the hand is over the pot slides across to whoever won it.
function renderChips(s, prev, sweep) {
  const bb = s.settings.big_blind;
  const animate = !!prev && prefs.motion;
  const byId = new Map(s.players.map(p => [p.id, p]));
  for (const slot of app.slots) {
    const amount = slot.pid ? byId.get(slot.pid).bet : 0;
    if (!animate || slot.betPid !== slot.pid) {
      slot.betPid = slot.pid;
      slot.betTarget = amount;
      slot.betToken++;
      showBet(slot, amount, bb);
      continue;
    }
    if (amount === slot.betTarget) continue;
    const token = ++slot.betToken;
    if (amount > slot.betTarget) {
      flyChips(amount - slot.betTarget, bb, slot.seat, slot.bet);
      setTimeout(() => { if (slot.betToken === token) showBet(slot, amount, bb); }, CHIP_TIME);
    } else {
      flyChips(slot.betTarget, bb, slot.bet, $('#pot'));
      showBet(slot, amount, bb);
    }
    slot.betTarget = amount;
  }

  const won = s.phase === 'complete' ? s.results : [];
  const pile = won.length ? won.reduce((t, r) => t + r.amount, 0) : s.pot;
  const label = won.length ? pile : s.total_pot;
  const key = `${s.hand_no}|${pile}|${label}|${won.length}`;
  if (key === app.potKey) return;
  app.potKey = key;
  const token = ++app.potToken;
  if (!animate) {
    showPot(won.length ? 0 : pile, won.length ? 0 : label, bb);
    return;
  }
  const later = (ms, fn) => setTimeout(() => { if (app.potToken === token) fn(); }, ms);
  showPot(app.potShown, label, bb);
  later(sweep, () => showPot(pile, label, bb));
  if (!won.length) return;
  later(sweep + (won.some(r => r.hand) ? SWEEP_PAUSE.showdown : SWEEP_PAUSE.fold), () => {
    for (const r of won) {
      for (const id of r.winners) {
        const slot = app.slots.find(x => x.pid === id);
        if (slot) flyChips(Math.floor(r.amount / r.winners.length), bb, $('#pot'), slot.seat);
      }
    }
    showPot(0, 0, bb);
  });
}

// ------------------------------------------------------------------ actions
function setRaise(value) {
  const a = app.state && app.state.actions;
  if (!a || !a.can_raise) return;
  let v = Math.round(Number(value) || 0);
  v = Math.max(a.min_raise_to, Math.min(a.max_raise_to, v));
  $('#raise-slider').value = v;
  $('#raise-input').value = v;
  updateRaiseLabel(v);
}

function updateRaiseLabel(v) {
  const a = app.state.actions;
  const verb = v >= a.max_raise_to ? 'All-in' : a.is_bet ? 'Bet' : 'Raise to';
  $('#raise-btn').textContent = `${verb} ${fmt(v)}`;
}

function renderActions(s, newTurn, autoActing) {
  const a = s.actions;
  $('#actions').hidden = !a || autoActing;
  if (!a || autoActing) return;
  $$('#actions button').forEach(b => { b.disabled = false; });
  $('#call-btn').textContent = a.can_check ? 'Check' : (a.to_call >= (s.players.find(p => p.id === s.me) || {}).stack
    ? `Call all-in ${fmt(a.to_call)}` : `Call ${fmt(a.to_call)}`);
  $('#raise-controls').hidden = !a.can_raise;
  $('#raise-btn').hidden = !a.can_raise;
  $('.action-buttons').style.gridTemplateColumns = a.can_raise ? '1fr 1fr 1.3fr' : '1fr 1fr';
  if (a.can_raise) {
    const slider = $('#raise-slider');
    slider.min = a.min_raise_to;
    slider.max = a.max_raise_to;
    slider.step = Math.max(1, Math.round(s.settings.small_blind));
    const cur = Number($('#raise-input').value);
    if (newTurn || !(cur >= a.min_raise_to && cur <= a.max_raise_to)) setRaise(a.min_raise_to);
    else updateRaiseLabel(cur);
  }
}

function act(action, amount) {
  $$('#actions button').forEach(b => { b.disabled = true; });
  send({ type: 'action', action, amount });
}

// Check / Fold pre-action: once armed it lasts the rest of the hand, checking whenever that's
// free and folding the first time you face a bet. Returns true while it's playing your turn.
function autoCheckFold(s) {
  if (app.checkFold !== s.hand_no || !s.actions) return false;
  // One action per decision point, however many state pushes arrive before the server moves on.
  const key = `${s.hand_no}|${s.phase}|${s.current_bet}`;
  if (app.autoActKey !== key) {
    app.autoActKey = key;
    send({ type: 'action', action: s.actions.can_check ? 'check' : 'fold' });
  }
  return true;
}

function renderPreAction(s, me) {
  const btn = $('#checkfold-btn');
  const canArm = !!me && me.in_hand && !me.folded && !me.all_in && inProgress(s) && !s.runout;
  btn.hidden = !canArm || (!!s.actions && app.checkFold !== s.hand_no);
  if (btn.hidden) return;
  const armed = app.checkFold === s.hand_no;
  btn.setAttribute('aria-pressed', String(armed));
  $('#checkfold-next').textContent = armed ? `· will ${me.bet >= s.current_bet ? 'check' : 'fold'}` : '';
}

function initActions() {
  $('#fold-btn').addEventListener('click', () => act('fold'));
  $('#checkfold-btn').addEventListener('click', () => {
    const s = app.state;
    if (!s) return;
    app.checkFold = app.checkFold === s.hand_no ? null : s.hand_no;
    app.autoActKey = null;
    const me = s.players.find(p => p.id === s.me);
    const autoActing = autoCheckFold(s);
    renderActions(s, false, autoActing);
    renderPreAction(s, me);
    renderStatus(s, me, s.host_id === s.me, autoActing);
  });
  $('#deal-btn').addEventListener('click', e => {
    e.currentTarget.disabled = true;
    send({ type: 'deal' });
  });
  $('#call-btn').addEventListener('click', () => act(app.state.actions.can_check ? 'check' : 'call'));
  $('#raise-btn').addEventListener('click', () => {
    setRaise($('#raise-input').value);
    act('raise', Number($('#raise-input').value));
  });
  $('#raise-slider').addEventListener('input', e => setRaise(e.target.value));
  $('#raise-input').addEventListener('input', e => {
    const a = app.state.actions;
    const v = Math.max(a.min_raise_to, Math.min(a.max_raise_to, Number(e.target.value) || 0));
    $('#raise-slider').value = v;
    updateRaiseLabel(v);
  });
  $('#raise-input').addEventListener('change', e => setRaise(e.target.value));
  $('#raise-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#raise-btn').click(); });
  $$('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
    const s = app.state;
    const a = s.actions;
    const preset = btn.dataset.preset;
    if (preset === 'min') return setRaise(a.min_raise_to);
    if (preset === 'all') return setRaise(a.max_raise_to);
    // Pot-sized raise: call first, then raise by the size of the pot after calling.
    setRaise(s.current_bet + Number(preset) * (s.total_pot + a.to_call));
  }));
}

// ------------------------------------------------------------------ status, sidebar, feed
function renderStatus(s, me, isHost, autoActing) {
  const actor = s.players.find(p => p.id === s.to_act);
  const host = s.players.find(p => p.id === s.host_id);
  const ready = s.players.filter(p => p.stack > 0 && !p.sitting_out && p.connected).length;
  let html;
  if (autoActing) html = s.actions.can_check ? 'Checking…' : 'Folding…';
  else if (s.actions) html = '<strong>Your turn</strong>' + (s.turn_remaining != null ? ' <span class="clock"></span>' : '');
  else if (actor && actor.is_bot) html = `<strong>${esc(actor.name)}</strong> is thinking…`;
  else if (actor) html = `Waiting for <strong>${esc(actor.name)}</strong>…`;
  else if (s.runout) html = 'All in! Running out the board…';
  else if (!s.started) {
    html = isHost
      ? `Share code <strong>${esc(s.code)}</strong> with friends, then press <strong>Start game</strong>.`
      : 'Waiting for the host to start the game…';
  } else if (ready < 2) html = 'Waiting for at least 2 players with chips…';
  else if (isHost) html = 'Deal the next hand when everyone\'s ready.';
  else if (s.can_deal) html = 'The host is offline — anyone can deal the next hand.';
  else html = `Waiting for <strong>${esc(host ? host.name : 'the host')}</strong> to deal the next hand…`;
  const deal = $('#deal-btn');
  deal.hidden = !s.can_deal;
  deal.disabled = false;
  deal.textContent = s.hand_no ? 'Deal next hand' : 'Start game';
  if (me && me.stack === 0 && !inProgress(s)) {
    html += s.settings.allow_rebuy ? ' · You\'re out of chips — hit <strong>Rebuy</strong>.' : ' · You\'re out of chips.';
  } else if (me && me.sitting_out) {
    html += ' · You are sitting out.';
  }
  $('#status').innerHTML = html;
}

function renderSidebar(s, me, isHost) {
  $('#host-panel').hidden = !isHost;
  if (isHost) {
    const form = $('#settings-form');
    if (!app.settingsDirty) {
      for (const [key, val] of Object.entries(s.settings)) {
        const input = form.elements[key];
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = !!val;
        else input.value = val;
      }
    }
  }

  if (me) {
    $('#sitout-box').checked = me.sitting_out;
    $('#rebuy-btn').hidden = !(me.stack === 0 && s.settings.allow_rebuy && !(me.in_hand && inProgress(s)));
    $('#rebuy-btn').textContent = `Rebuy (${fmt(s.settings.starting_stack)})`;
  }

  $('#ledger').innerHTML = s.players.map(p => {
    const tags = [];
    if (p.id === s.host_id) tags.push('host');
    if (p.is_bot) tags.push(`${BOT_LABELS[p.bot_style] || ''} bot`.trim());
    if (!p.connected) tags.push('offline');
    else if (p.sitting_out) tags.push('away');
    const net = p.net > 0 ? `<span class="pos">+${fmt(p.net)}</span>` : p.net < 0 ? `<span class="neg">${fmt(p.net)}</span>` : '0';
    const kick = isHost && p.id !== s.me
      ? `<button class="kick" data-kick="${esc(p.id)}" title="Remove ${esc(p.name)}">✕</button>` : '';
    return `<tr><td>${esc(p.name)}${tags.map(t => `<span class="tag">${t}</span>`).join('')}</td>`
      + `<td class="num">${fmt(p.stack)}</td><td class="num">${net}</td><td>${kick}</td></tr>`;
  }).join('');
}

// Appends new feed entries and returns the sound effects they call for, in order.
// Chat that arrives while the sidebar is collapsed counts as unread (except on first load).
function renderFeed(entries, initial) {
  const feed = $('#feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const sounds = [];
  for (const e of entries) {
    if (e.id <= app.lastFeedId) continue;
    app.lastFeedId = e.id;
    if (e.sound) sounds.push(e.sound);
    if (e.kind === 'chat' && !initial && sidebarCollapsed()) app.unread++;
    const div = document.createElement('div');
    div.className = e.kind;
    div.innerHTML = e.kind === 'chat' ? `<b>${esc(e.name)}:</b> ${esc(e.text)}` : esc(e.text);
    feed.append(div);
  }
  while (feed.children.length > 300) feed.firstChild.remove();
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
  renderUnread();
  return sounds;
}

const sidebarCollapsed = () => $('.layout').classList.contains('collapsed');

function renderUnread() {
  const el = $('#unread');
  el.hidden = !app.unread;
  el.textContent = app.unread > 9 ? '9+' : app.unread;
  el.title = `${app.unread} new message${app.unread === 1 ? '' : 's'}`;
}

function setSidebar(collapsed) {
  $('.layout').classList.toggle('collapsed', collapsed);
  const btn = $('#sidebar-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? 'Show players, chat and controls' : 'Hide the side panels';
  $('.arrow', btn).textContent = collapsed ? '«' : '»';
  $('.label', btn).textContent = collapsed ? 'Show panels' : 'Hide panels';
  store(SIDEBAR_KEY, collapsed || null);
  if (!collapsed) {
    app.unread = 0;
    renderUnread();
    $('#feed').scrollTop = $('#feed').scrollHeight; // it can't scroll while hidden
  }
}

function initSidebar() {
  setSidebar(!!load(SIDEBAR_KEY));
  $('#sidebar-toggle').addEventListener('click', () => setSidebar(!sidebarCollapsed()));
  const form = $('#settings-form');
  form.addEventListener('input', () => { app.settingsDirty = true; });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const el = form.elements;
    send({
      type: 'settings',
      settings: {
        small_blind: Number(el.small_blind.value),
        big_blind: Number(el.big_blind.value),
        starting_stack: Number(el.starting_stack.value),
        turn_time: Number(el.turn_time.value),
        allow_rebuy: el.allow_rebuy.checked,
      },
    });
    app.settingsDirty = false;
    toast('Settings saved', 'info');
  });
  $('#add-bot-btn').addEventListener('click', () => send({ type: 'add_bot', style: $('#bot-style').value }));
  $('#sitout-box').addEventListener('change', e => send({ type: 'sitout', value: e.target.checked }));
  $('#rebuy-btn').addEventListener('click', () => send({ type: 'rebuy' }));
  $('#ledger').addEventListener('click', e => {
    const id = e.target.dataset && e.target.dataset.kick;
    const p = id && app.state.players.find(x => x.id === id);
    if (p && confirm(`Remove ${p.name} from the table?`)) send({ type: 'kick', id });
  });
  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#chat-input');
    if (input.value.trim()) send({ type: 'chat', text: input.value });
    input.value = '';
  });
}

function initSettings() {
  const panel = $('#settings-panel');
  const btn = $('#settings-btn');
  const open = show => {
    if (show) {
      const r = btn.getBoundingClientRect();
      panel.style.top = `${r.bottom + 8}px`;
      panel.style.left = `${Math.max(12, r.left)}px`;
    }
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
  };
  btn.addEventListener('click', () => open(panel.hidden));
  document.addEventListener('pointerdown', e => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) open(false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) open(false); });
  for (const key of Object.keys(DEFAULT_PREFS)) {
    $(`#pref-${key}`).addEventListener('input', e => {
      prefs[key] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
      applyPrefs();
      store(PREFS_KEY, prefs);
    });
  }
  $('#pref-test').addEventListener('click', () => {
    Sound.play('check');
    Sound.play('bet', 600);
    Sound.play('win', 1200);
  });
  $('#pref-reset').addEventListener('click', () => {
    Object.assign(prefs, DEFAULT_PREFS);
    store(PREFS_KEY, null);
    applyPrefs();
  });
}

// ------------------------------------------------------------------ reactions
// Stickers are the image files in poker/stickers and pop up beside the sender's camera.
// Effects are the Lottie animations in poker/effects and play over the sender's camera.
// "6740-skull.gif" is labelled "skull", "Poker Chip Shuffle.json" "Poker Chip Shuffle".
const stickerUrl = name => `/poker/stickers/${encodeURIComponent(name)}`;
const reactionLabel = name => name.replace(/\.[^.]+$/, '').replace(/^\d+-/, '').replace(/[-_]+/g, ' ');
const hasLottie = () => typeof lottie !== 'undefined'; // it comes from a CDN, so it may be missing
// Some animations leave a lot of empty canvas around the action; zoom those in to fill the camera.
const EFFECT_ZOOM = { 'Confetti.json': 1.7 };

// Each effect is fetched once. Lottie writes into the data it plays, so every animation
// gets its own parsed copy.
const effectJson = new Map();
function effectData(name) {
  if (!effectJson.has(name)) {
    const req = fetch(`/poker/effects/${encodeURIComponent(name)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
    req.catch(() => effectJson.delete(name)); // try again next time
    effectJson.set(name, req);
  }
  return effectJson.get(name).then(JSON.parse);
}

function buildPicker(stickers, effects) {
  if (!hasLottie()) effects = [];
  if (stickers.join() === app.stickers.join() && effects.join() === app.effects.join()) return;
  app.stickers = stickers;
  app.effects = effects;
  app.effectThumbs.forEach(a => a.destroy());
  app.effectThumbs = [];
  $('#react-btn').hidden = !stickers.length && !effects.length;
  $('#react-tabs').hidden = !stickers.length || !effects.length; // no tabs for a single kind
  const tile = (attr, name, inner) => {
    const label = esc(reactionLabel(name));
    return `<button class="react-item" ${attr}="${esc(name)}" title="${label}" aria-label="${label}">${inner}</button>`;
  };
  $('#sticker-grid').innerHTML = stickers
    .map(name => tile('data-sticker', name, `<img src="${esc(stickerUrl(name))}" alt="" loading="lazy">`)).join('');
  $('#effect-grid').innerHTML = effects.map(name => tile('data-effect', name, '<div class="fx-thumb"></div>')).join('');
  showTab(app.reactTab);
}

function showTab(tab) {
  if (!app.effects.length) tab = 'stickers';
  else if (!app.stickers.length) tab = 'effects';
  app.reactTab = tab;
  for (const t of $$('#react-tabs [role=tab]')) {
    const on = t.dataset.tab === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  $('#sticker-grid').hidden = tab !== 'stickers';
  $('#effect-grid').hidden = tab !== 'effects';
  if (tab === 'effects' && !$('#react-picker').hidden) loadEffectThumbs();
}

// Effect tiles show a still from the middle of the animation and play it on hover.
// They're only built once someone opens the Effects tab.
function loadEffectThumbs() {
  for (const b of $$('#effect-grid [data-effect]')) {
    if (b.dataset.thumb) continue;
    b.dataset.thumb = 'loading';
    effectData(b.dataset.effect).then(data => {
      if (!b.isConnected) return;
      const anim = lottie.loadAnimation({
        container: $('.fx-thumb', b), renderer: 'svg', loop: true, autoplay: false, animationData: data,
      });
      app.effectThumbs.push(anim);
      const still = () => anim.goToAndStop(Math.floor(anim.totalFrames / 2), true);
      if (anim.isLoaded) still(); else anim.addEventListener('DOMLoaded', still);
      b.addEventListener('pointerenter', () => anim.play());
      b.addEventListener('pointerleave', still);
      b.dataset.thumb = 'ready';
    }).catch(() => { delete b.dataset.thumb; });
  }
}

function openPicker(show) {
  $('#react-picker').hidden = !show;
  $('#react-btn').setAttribute('aria-expanded', String(show));
  if (show) showTab(app.reactTab);
}

// Pop the sticker up over the sender's seat for a few seconds.
function showSticker(pid, name) {
  const slot = app.slots.find(s => s.pid === pid);
  if (!slot || !app.stickers.includes(name)) return;
  const old = $('.reaction', slot.seat);
  if (old) old.remove();
  const img = document.createElement('img');
  img.className = 'reaction';
  img.src = stickerUrl(name);
  img.alt = reactionLabel(name);
  img.addEventListener('animationend', () => img.remove());
  slot.seat.append(img);
}

// Play the effect once over the sender's camera, replacing any effect already playing there.
function showEffect(pid, name) {
  if (!app.effects.includes(name)) return;
  effectData(name).then(data => {
    const slot = app.slots.find(s => s.pid === pid);
    if (!slot) return;
    stopEffect(slot);
    slot.fx.style.setProperty('--fx-zoom', EFFECT_ZOOM[name] || 1);
    const anim = lottie.loadAnimation({
      container: slot.fx, renderer: 'svg', loop: false, autoplay: true, animationData: data,
    });
    slot.effect = anim;
    anim.addEventListener('complete', () => { if (slot.effect === anim) stopEffect(slot); });
  }).catch(() => {});
}

function stopEffect(slot) {
  if (!slot.effect) return;
  slot.effect.destroy();
  slot.effect = null;
  slot.fx.textContent = '';
}

function initReactions() {
  const picker = $('#react-picker');
  const btn = $('#react-btn');
  btn.addEventListener('click', () => openPicker(picker.hidden));
  const tabs = $('#react-tabs');
  tabs.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]');
    if (t) showTab(t.dataset.tab);
  });
  tabs.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    showTab(app.reactTab === 'stickers' ? 'effects' : 'stickers');
    $('[aria-selected="true"]', tabs).focus();
  });
  picker.addEventListener('click', e => {
    const b = e.target.closest('[data-sticker], [data-effect]');
    if (!b || picker.classList.contains('cooling')) return;
    send(b.dataset.effect
      ? { type: 'react', effect: b.dataset.effect }
      : { type: 'react', sticker: b.dataset.sticker });
    // Stay open for more reactions, but rest for the server's one-a-second limit.
    picker.classList.add('cooling');
    setTimeout(() => picker.classList.remove('cooling'), 1000);
  });
  document.addEventListener('pointerdown', e => {
    if (!picker.hidden && !picker.contains(e.target) && !btn.contains(e.target)) openPicker(false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !picker.hidden) openPicker(false); });
}

function initTopbar() {
  $('#copy-link').addEventListener('click', () => {
    const link = `${location.origin}/poker?code=${app.code}`;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(() => toast('Invite link copied', 'info'), () => prompt('Copy this invite link:', link));
    } else {
      prompt('Copy this invite link:', link);
    }
  });
  $('#mic-btn').addEventListener('click', () => toggleTrack('audio'));
  $('#cam-btn').addEventListener('click', () => toggleTrack('video'));
  $('#leave-btn').addEventListener('click', () => {
    const me = app.state && app.state.players.find(p => p.id === app.me);
    const warn = me && me.in_hand && !me.folded && inProgress(app.state) ? ' Your hand will be folded.' : '';
    if (!confirm(`Leave the table? Your chips will be lost.${warn}`)) return;
    send({ type: 'leave' });
    setTimeout(() => exitToLobby(), 100);
  });
}

// Turn timer: a draining bar and seconds left on the acting seat, plus a ticking clock on your own turn.
setInterval(() => {
  const s = app.state;
  for (const slot of app.slots) {
    let frac = 0;
    let secs = '';
    if (s && app.deadline && slot.pid && slot.pid === s.to_act) {
      const left = Math.max(0, (app.deadline - performance.now()) / 1000);
      frac = left / app.turnTotal;
      secs = Math.min(app.turnTotal, Math.ceil(left));
    }
    const low = secs !== '' && (secs <= 5 || frac < 0.25);
    slot.timer.style.width = `${Math.min(1, frac) * 100}%`;
    slot.timer.classList.toggle('low', low);
    if (slot.countdown.textContent !== String(secs)) slot.countdown.textContent = secs;
    slot.countdown.classList.toggle('low', low);
    if (slot.pid === app.me) {
      const clock = $('#status .clock');
      if (clock) {
        clock.textContent = secs !== '' ? `· ${secs}s left` : '';
        clock.classList.toggle('low', low);
      }
      if (secs !== '' && secs <= 5 && secs > 0 && secs !== app.lastTick) Sound.play('tick');
      app.lastTick = secs;
    }
  }
}, 100);

applyPrefs();
initLobby();
initActions();
initSidebar();
initTopbar();
initSettings();
initReactions();
