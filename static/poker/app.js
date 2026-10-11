'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const SESSION_KEY = 'vgp.session';
const NAME_KEY = 'vgp.name';
const NUM_SLOTS = 9;

const app = {
  code: null, token: null, me: null, ws: null, state: null,
  leaving: false, reconnectTimer: null,
  localStream: null, micOn: true, camOn: true,
  iceServers: [], peers: new Map(), remote: new Map(), pendingIce: new Map(),
  slots: [], layoutN: -1, lastFeedId: 0, boardKey: '', boardHand: 0, boardLen: 0,
  deadline: null, turnTotal: null, settingsDirty: false, audioCtx: null,
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

const cardHtml = (c, cls = '', i = 0) => Cards.html(c, cls, i);
const BOT_LABELS = { fish: 'Fish', shark: 'Shark', maniac: 'Maniac' };

function beep() {
  try {
    const ctx = app.audioCtx || (app.audioCtx = new AudioContext());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch {}
}

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
  app.layoutN = -1;
  app.lastFeedId = 0;
  app.boardKey = '';
  $('#feed').innerHTML = '';
  for (const slot of app.slots) { slot.video.srcObject = null; slot.pid = null; slot.seat.classList.add('empty'); }
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
        <div class="timer"><div></div></div>
      </div>
      <div class="plate"><div class="pname"></div><div class="pstack"></div></div>
      <div class="hole"></div>`;
    const bet = document.createElement('div');
    bet.className = 'bet';
    const dealer = document.createElement('div');
    dealer.className = 'dealer-btn';
    dealer.textContent = 'D';
    dealer.hidden = true;
    table.append(seat, bet, dealer);
    app.slots.push({
      seat, bet, dealer, pid: null, holeKey: '', avatarKey: '',
      video: $('video', seat), avatar: $('.avatar', seat), badges: $('.badges', seat),
      timer: $('.timer div', seat), name: $('.pname', seat), stack: $('.pstack', seat),
      hole: $('.hole', seat), last: $('.last-action', seat),
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

  $('#blinds-info').textContent =
    `Blinds ${fmt(s.settings.small_blind)}/${fmt(s.settings.big_blind)}` + (s.hand_no ? ` · Hand #${s.hand_no}` : '');

  const seated = [...s.players].sort((a, b) => a.seat - b.seat);
  const myIdx = Math.max(0, seated.findIndex(p => p.id === s.me));
  const bySlot = seated.slice(myIdx).concat(seated.slice(0, myIdx));
  if (bySlot.length !== app.layoutN) layoutSlots(bySlot.length);
  const winners = new Set(s.results.filter(r => r.hand).flatMap(r => r.winners));
  const uncontested = s.results.length === 1 && !s.results[0].hand;
  if (uncontested) s.results[0].winners.forEach(id => winners.add(id));
  const winCards = new Set(s.results.flatMap(r => r.cards));
  app.slots.forEach((slot, i) => renderSeat(slot, bySlot[i] || null, s, winners, winCards));

  renderBoard(s, winCards);
  $('#pot').textContent = s.total_pot ? `Pot ${fmt(s.total_pot)}` : '';
  $('#banner').innerHTML = s.results
    .filter(r => r.label !== 'Returned')
    .map(r => {
      const multi = s.results.filter(x => x.label !== 'Returned').length > 1;
      const who = r.names.map(esc).join(' & ');
      return `<div>${multi ? esc(r.label) + ': ' : ''}${who} ${r.names.length > 1 ? 'split' : 'wins'} ${fmt(r.amount)}${r.hand ? ' — ' + esc(r.hand) : ''}</div>`;
    }).join('');

  const newTurn = !!s.actions && !(prev && prev.actions && prev.hand_no === s.hand_no && prev.phase === s.phase
    && prev.current_bet === s.current_bet);
  if (newTurn) beep();
  document.title = s.actions ? '▶ Your turn — Very Good Poker' : 'Very Good Poker';

  renderActions(s, newTurn);
  renderStatus(s, me, isHost);
  renderSidebar(s, me, isHost);
  renderFeed(s.feed);

  if (s.to_act && s.turn_remaining != null) {
    app.deadline = performance.now() + s.turn_remaining * 1000;
    app.turnTotal = s.turn_total;
  } else {
    app.deadline = null;
  }
  updateVideos();
}

function renderSeat(slot, p, s, winners, winCards) {
  slot.pid = p ? p.id : null;
  slot.seat.classList.toggle('empty', !p);
  if (!p) {
    slot.bet.innerHTML = '';
    slot.dealer.hidden = true;
    slot.hole.innerHTML = '';
    slot.holeKey = '';
    return;
  }
  const cl = slot.seat.classList;
  cl.toggle('me', p.id === s.me);
  cl.toggle('acting', s.to_act === p.id);
  cl.toggle('folded', p.in_hand && p.folded && inProgress(s));
  cl.toggle('away', p.sitting_out || !p.connected);
  cl.toggle('winner', winners.has(p.id));

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

  const holeKey = `${p.cards.join()}|${p.folded}|${winners.has(p.id) ? [...winCards].join() : ''}`;
  if (holeKey !== slot.holeKey) {
    const fresh = !slot.holeKey.startsWith(p.cards.join());
    slot.holeKey = holeKey;
    slot.hole.classList.toggle('up', p.id !== s.me && p.cards.length > 0 && p.cards[0] !== '??');
    slot.hole.innerHTML = p.cards.map((c, i) => {
      const cls = [p.folded ? 'dim' : '', winners.has(p.id) && winCards.has(c) ? 'win' : '', fresh ? 'deal' : ''];
      return cardHtml(c, cls.join(' '), p.seat * 2 + i);
    }).join('');
  }

  slot.bet.innerHTML = p.bet > 0 ? `<span class="chip"></span>${fmt(p.bet)}` : '';
  slot.dealer.hidden = !s.hand_no || s.dealer_seat !== p.seat;
}

function renderBoard(s, winCards) {
  const key = `${s.hand_no}|${s.board.join()}|${[...winCards].join()}`;
  if (key === app.boardKey) return;
  const sameHand = app.boardHand === s.hand_no;
  const oldLen = sameHand ? app.boardLen : 0;
  app.boardKey = key;
  app.boardHand = s.hand_no;
  app.boardLen = s.board.length;
  $('#board').innerHTML = s.board.map((c, i) => {
    const cls = [i >= oldLen ? 'deal' : '', winCards.size && !winCards.has(c) ? 'dim' : '', winCards.has(c) ? 'win' : ''];
    return cardHtml(c, cls.join(' '), i);
  }).join('');
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

function renderActions(s, newTurn) {
  const a = s.actions;
  $('#actions').hidden = !a;
  if (!a) return;
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

function initActions() {
  $('#fold-btn').addEventListener('click', () => act('fold'));
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
function renderStatus(s, me, isHost) {
  const actor = s.players.find(p => p.id === s.to_act);
  const ready = s.players.filter(p => p.stack > 0 && !p.sitting_out && p.connected).length;
  let html;
  if (s.actions) html = '<strong>Your turn</strong>';
  else if (actor && actor.is_bot) html = `<strong>${esc(actor.name)}</strong> is thinking…`;
  else if (actor) html = `Waiting for <strong>${esc(actor.name)}</strong>…`;
  else if (s.runout) html = 'All in! Running out the board…';
  else if (!s.started) {
    html = isHost
      ? `Share code <strong>${esc(s.code)}</strong> with friends, then press <strong>Start game</strong>.`
      : 'Waiting for the host to start the game…';
  } else if (ready < 2) html = 'Waiting for at least 2 players with chips…';
  else html = 'Next hand starting…';
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
    const btn = $('#start-btn');
    btn.textContent = s.started ? 'Pause after this hand' : 'Start game';
    btn.classList.toggle('primary', !s.started);
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

function renderFeed(entries) {
  const feed = $('#feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  for (const e of entries) {
    if (e.id <= app.lastFeedId) continue;
    app.lastFeedId = e.id;
    const div = document.createElement('div');
    div.className = e.kind;
    div.innerHTML = e.kind === 'chat' ? `<b>${esc(e.name)}:</b> ${esc(e.text)}` : esc(e.text);
    feed.append(div);
  }
  while (feed.children.length > 300) feed.firstChild.remove();
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function initSidebar() {
  $('#start-btn').addEventListener('click', () => send({ type: 'start', value: !app.state.started }));
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

// Turn timer bars.
setInterval(() => {
  const s = app.state;
  for (const slot of app.slots) {
    let frac = 0;
    if (s && app.deadline && slot.pid && slot.pid === s.to_act) {
      frac = Math.max(0, (app.deadline - performance.now()) / (app.turnTotal * 1000));
    }
    slot.timer.style.width = `${Math.min(1, frac) * 100}%`;
    slot.timer.classList.toggle('low', frac > 0 && frac < 0.25);
  }
}, 100);

initLobby();
initActions();
initSidebar();
initTopbar();
