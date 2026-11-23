import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, doc, onSnapshot, runTransaction } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { board } from './online-board.js';
import { createGame, normalizeGame, reduceGame, actor, complete, rent, upgradeCost, saleValue, wealth, round10 } from './online-engine.js';

const roomId = new URLSearchParams(location.search).get('room');
const $ = id => document.getElementById(id);
const money = n => Math.round(n).toLocaleString('fr-FR') + ' €';
const escape = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
let state, room, uid, db, ref, revision = -1, busy = false, connected = false, lastError = null;
let initialization = false, inspection = null, modalHidden = false, lastAnimation = null, animationTimer = null;
const banner = document.createElement('div');
banner.id = 'online-banner';
banner.style.cssText = 'position:sticky;top:0;z-index:100;background:#183f35;color:white;padding:10px 14px;font-size:13px;text-align:center';
const history = document.createElement('div');
history.className = 'log'; history.id = 'online-history';
if (roomId) {
  $('setup').classList.add('hidden');
  document.body.prepend(banner); $('game').appendChild(history);
  banner.textContent = 'Connexion au salon ' + roomId + '…';
  $('restart').onclick = () => { location.href = './salon.html'; };
  // Keep local board-peeking controls while shared decisions stay serialized.
  $('peekreturn').onclick = () => { modalHidden = false; render(); };
  $('dealpeek').onclick = () => { modalHidden = true; render(); };
  window.onlineInspect = i => { inspection = i; modalHidden = false; render(); };
  window.addEventListener('offline', () => { connected = false; render(); });
  window.addEventListener('online', () => { banner.textContent = 'Reconnexion au salon…'; });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state) { updateClock(); render(); }
  });
  connect();
}
function errorMessage(error) {
  if (error.code === 'permission-denied') return 'Les règles Firebase refusent cette action. La version des règles du jeu doit être publiée.';
  if (error.code === 'unavailable') return 'Connexion interrompue. Réessaie après la reconnexion.';
  return error.message || String(error);
}
function showError(error) {
  const message = errorMessage(error);
  lastError = message;
  banner.textContent = '⚠️ ' + message;
  const line = document.createElement('p'); line.setAttribute('role', 'alert'); line.textContent = message;
  $('actions').appendChild(line);
}
async function connect() {
  try {
    const auth = getAuth(initializeApp(firebaseConfig));
    db = getFirestore(auth.app);
    await signInAnonymously(auth); uid = auth.currentUser.uid; ref = doc(db, 'rooms', roomId);
    onSnapshot(ref, { includeMetadataChanges: true }, snapshot => {
      if (!snapshot.exists()) { banner.textContent = 'Salon introuvable.'; return; }
      room = snapshot.data();
      if (!room.players?.[uid]) { banner.textContent = 'Tu ne fais pas partie de ce salon. Rejoins-le depuis la salle d’attente.'; return; }
      connected = !snapshot.metadata.fromCache && navigator.onLine;

      if (!room.gameState) {
        banner.textContent = room.status === 'playing' ? 'Préparation du plateau…' : 'En attente du lancement dans le salon…';
        if (connected && room.status === 'playing') initialize();
        return;
      }
      if (snapshot.metadata.hasPendingWrites) return;
      const nextRevision = room.gameRevision || 0;
      if (nextRevision >= revision) {
        if (nextRevision > revision) { inspection = null; modalHidden = false; }
        revision = nextRevision; state = normalizeGame(room.gameState, room);
        render();
      }
    }, showError);
  } catch (error) { showError(error); }
}
async function initialize() {
  if (initialization || room.host !== uid) return;
  initialization = true;
  try {
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref), data = snap.data();
      if (data.gameState) return;
      if (data.host !== uid || data.status !== 'playing') throw Error('La partie doit être lancée par l’hôte.');
      const start = data.startedAt?.toMillis?.() || Date.now();
      tx.update(ref, { gameState: createGame(data, start), gameRevision: (data.gameRevision || 0) + 1 });
    });
  } catch (error) { showError(error); }
  finally { initialization = false; }
}
async function send(type, payload = {}) {
  if (busy || !state) return;
  if (!connected || !navigator.onLine) { showError(Error('Attends la reconnexion avant de jouer.')); return; }
  const action = { ...payload, type, id: crypto.randomUUID?.() || uid + '-' + Date.now() + '-' + Math.random() };
  const expectedRevision = revision;
  // Reuse the same random tape across Firestore retries.
  const tape = Array.from(crypto.getRandomValues(new Uint32Array(16)), n => n / 4294967296);
  const now = Date.now();
  busy = true; lastError = null; inspection = null; modalHidden = false; render();
  try {
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw Error('Salon introuvable.');
      const data = snap.data(), shared = normalizeGame(data.gameState, data);
      if (shared.lastActionId === action.id) return;
      if ((data.gameRevision || 0) !== expectedRevision) throw Error('La partie a avancé. Consulte le plateau actualisé avant de rejouer.');
      if (data.status !== 'playing') throw Error('La partie est fermée.');
      let cursor = 0;
      const next = reduceGame(shared, uid, action, () => tape[cursor++ % tape.length], now);
      tx.update(ref, { gameState: next, gameRevision: expectedRevision + 1 });
    });
  } catch (error) { showError(error); }
  finally { busy = false; render(); }
}
const myIndex = () => state.playerIds.indexOf(uid);
const canAct = () => !busy && connected && !state.gameOver && actor(state) === myIndex();
function button(label, action, parent = $('actions'), enabled = canAct()) {
  const b = document.createElement('button'); b.textContent = label; b.disabled = !enabled;
  b.onclick = action; parent.appendChild(b); return b;
}
function act(label, type, payload, parent) { return button(label, () => send(type, typeof payload === 'function' ? payload() : payload), parent); }
function modal(title, body) {
  const el = $('modal'); el.className = 'modal';
  el.innerHTML = '<h2>' + escape(title) + '</h2><div>' + body + '</div><div class="actions" id="modalactions"></div>';
  $('modalwrap').classList.toggle('hidden', modalHidden);
  $('peekreturn').classList.toggle('hidden', !modalHidden);
  $('dealpeek').classList.add('hidden');
  const peek = document.createElement('button'); peek.textContent = '👀 Voir le plateau'; peek.className = 'view-board-btn';
  peek.onclick = () => { modalHidden = true; render(); }; el.appendChild(peek);
  return $('modalactions');
}
function chooseProperty(title, ids, type, extra = {}) {
  const actions = modal(title, '<p>Sélectionne une propriété.</p>');
  for (const i of ids) act(board[i].name + ' · ' + money(board[i].price), type, { ...extra, cell: i }, actions);
  return actions;
}
const myProperties = index => state.properties.map((p, i) => p.owner === index ? i : -1).filter(i => i >= 0);
function inspectProperty(i) {
  const prop = state.properties[i], cell = board[i];
  const actions = modal(cell.name, '<p>Propriétaire · ' + escape(state.players[prop.owner]?.name || 'Banque') +
    '</p><p>Prix · ' + money(cell.price) + '</p><p>Loyer · ' + money(rent(state, i)) +
    '</p><p>Améliorations · ' + prop.level + ' / 3</p>');
  if (canAct() && prop.owner === myIndex() && ['roll', 'end', 'debt'].includes(state.phase)) {
    act('Vendre · ' + money(saleValue(state, i)), 'sell', { cell: i }, actions);
    if (state.phase !== 'debt' && complete(state, i) && prop.level < 3 && state.players[myIndex()].cash >= upgradeCost(i))
      act('Améliorer · ' + money(upgradeCost(i)), 'upgrade', { cell: i }, actions);
  }
  button('Fermer', () => { inspection = null; modalHidden = false; render(); }, actions, true);
}
function renderDecision() {
  const pending = state.pending, actions = $('actions'), p = state.players[state.current];
  if (!pending) {
    if (state.phase === 'roll') act('🎲 Lancer le dé', 'roll', {}, actions);
    if (state.phase === 'end') act('Fin du tour →', 'next', {}, actions);
    return;
  }
  if (!canAct()) {
    const text = document.createElement('p');
    text.textContent = 'En attente de ' + state.players[actor(state)].name + ' · ' + ({
      purchase: 'achat', 'jail-choice': 'GAV', wheel: 'roue', casino: 'casino', rob: 'braquage',
      deal: 'négociation', 'offer-response': 'réponse à l’offre', 'exchange-response': 'proposition d’échange',
      'exchange-pick': 'choix de l’échange', debt: 'vente pour rembourser', 'rob-penalty': 'propriété à céder'
    }[pending.type] || 'décision');
    actions.appendChild(text); return;
  }
  let target;
  switch (pending.type) {
    case 'purchase':
      target = modal(board[pending.cell].name, '<p>Acheter pour ' + money(board[pending.cell].price) + ' · Loyer ' + money(rent(state, pending.cell)) + '</p>');
      act('Acheter', 'buy', {}, target); act('Passer', 'pass', {}, target); break;
    case 'jail-choice':
      target = modal('🚔 Garde à vue', '<p>Caution · ' + money(pending.bail) + '</p>');
      if (p.cash >= pending.bail) act('Payer la caution', 'bail', {}, target);
      act('Rester en GAV', 'stay', {}, target); break;
    case 'wheel':
      target = modal('🎡 Roue de la chance', '<p>50 €, 100 €, Chance, téléportation, GAV ou taxe.</p>');
      act('🎡 Lancer la roue', 'wheel', {}, target); break;
    case 'casino':
      target = modal('🎰 Casino', '<label>Mise (€)<input id="online-stake" type="number" min="1" max="' + Math.floor(p.cash) + '" value="' + Math.min(100, Math.floor(p.cash)) + '"></label><p>Rouge / noir · gain net ×1. Vert · gain net ×35.</p>');
      for (const [color, label] of [['red', '🔴 Rouge'], ['black', '⚫ Noir'], ['green', '🟢 Vert']])
        act(label, 'bet', () => ({ color, stake: Number($('online-stake').value) }), target);
      act('Passer', 'pass', {}, target); break;
    case 'debt': chooseProperty('Solde négatif · Vendre pour se renflouer', myProperties(state.current), 'sell'); break;
    case 'rob-penalty': chooseProperty('Céder ' + pending.remaining + ' propriété(s) à ' + state.players[pending.victim].name, myProperties(state.current), 'cede'); break;
    case 'rob':
      target = modal('🥷 Braquage', '<p>Argent · réussite 35 %. Propriété · réussite 33,3 %. Un échec entraîne deux tours de GAV.</p>');
      state.players.forEach((victim, i) => { if (i !== state.current && !victim.bankrupt) act('💶 Braquer ' + victim.name, 'rob-cash', { target: i }, target); });
      if (myProperties(state.current).length >= 2)
        state.properties.forEach((prop, i) => {
          if (prop.owner >= 0 && prop.owner !== state.current && !complete(state, i))
            act('🏛 Voler ' + board[i].name, 'rob-property', { cell: i }, target);
        });
      act('Passer', 'pass', {}, target); break;
    case 'deal': renderDeal(); break;
    case 'offer-response':
      target = modal(pending.counter ? 'Contre-offre' : 'Offre de rachat', '<p>' + escape(state.players[pending.buyer].name) + ' achète ' +
        escape(board[pending.cell].name) + ' à ' + escape(state.players[pending.seller].name) + ' pour ' + money(pending.price) + '.</p>' +
        (!pending.counter ? '<label>Contre-offre (€)<input id="online-price" type="number" value="' + (pending.price + 50) + '"></label>' : ''));
      act('Accepter', 'accept', {}, target); act('Refuser', 'reject', {}, target);
      if (!pending.counter) act('Envoyer la contre-offre', 'counter', () => ({ price: Number($('online-price').value) }), target);
      break;
    case 'exchange-response':
      target = chooseProperty('Proposer une propriété contre ' + board[pending.cell].name, myProperties(myIndex()), 'exchange-answer');
      act('Passer', 'exchange-answer', { cell: null }, target); break;
    case 'exchange-pick':
      target = modal('Choisir une offre d’échange', '<p>Propriété proposée · ' + escape(board[pending.cell].name) + '</p>');
      pending.offers.forEach(offer => act(board[offer.cell].name + ' · ' + state.players[offer.player].name, 'exchange-pick', { cell: offer.cell }, target));
      act('Tout refuser', 'exchange-pick', { cell: null }, target); break;
  }
}
function renderDeal() {
  const opponents = state.properties.map((p, i) => p.owner >= 0 && p.owner !== state.current ? i : -1).filter(i => i >= 0);
  const options = opponents.map(i => '<option value="' + i + '">' + escape(board[i].name) + ' · min ' + money(round10(board[i].price * 1.1)) + '</option>').join('');
  const target = modal('🤝 Négocier', '<label>Propriété à racheter<select id="online-deal-cell">' + options + '</select></label><label>Offre (€)<input id="online-price" type="number" value="' + round10(board[opponents[0]].price * 1.1) + '"></label>');
  act('Envoyer l’offre au propriétaire', 'offer', () => ({ cell: Number($('online-deal-cell').value), price: Number($('online-price').value) }), target);
  myProperties(state.current).forEach(i => act('Échanger ' + board[i].name, 'exchange', { cell: i }, target));
  act('Passer', 'pass', {}, target);
}
function render() {
  if (!state) return;
  window.onlineView(state);
  const me = myIndex(), name = state.players[me]?.name || '';
  banner.textContent = (!connected ? '⏳ Reconnexion… · ' : '🌐 ') + roomId + ' · Tu es ' + name + ' · ' +
    (state.gameOver ? 'Partie terminée' : state.players[actor(state)].name + (actor(state) === me ? ' · À toi de jouer' : ' joue'));
  $('actions').replaceChildren(); $('propertytools').replaceChildren();
  $('modalwrap').classList.add('hidden'); $('peekreturn').classList.add('hidden'); $('dealpeek').classList.add('hidden');
  if (state.gameOver) {
    const winner = state.winner ?? state.players.map((p, i) => ({ i, w: wealth(state, i) })).filter(x => !state.players[x.i].bankrupt).sort((a, b) => b.w - a.w)[0]?.i;
    $('message').textContent = state.message || '🏆 ' + state.players[winner]?.name + ' gagne !';
    button('Retour au salon', () => { localStorage.removeItem('brokeSalon'); location.href = './salon.html'; }, $('actions'), true);
  } else {
    renderDecision();
    if (inspection !== null) inspectProperty(inspection);
  }
  const dock = $('propertytools');
  if (!state.players[me]?.bankrupt) {
    button('🏛 Mes propriétés', () => {
      const ids = myProperties(me);
      const target = modal('Mes propriétés', ids.length ? '' : '<p>Tu ne possèdes aucune propriété.</p>');
      ids.forEach(i => button(board[i].name, () => { inspection = i; render(); }, target, true));
      button('Fermer', () => { inspection = null; render(); }, target, true);
    }, dock, true);
    if (!state.gameOver) button('🚪 Abandonner', () => {
      if (confirm('Abandonner cette partie ? Tes propriétés seront libérées.')) send('quit');
    }, dock, connected && !busy);
  } else button('Quitter le plateau', () => { localStorage.removeItem('brokeSalon'); location.href = './salon.html'; }, dock, true);
  history.replaceChildren();
  state.logs.forEach(text => { const line = document.createElement('div'); line.textContent = text; history.appendChild(line); });
  if (busy) {
    $('actions').querySelectorAll('button').forEach(b => { b.disabled = true; });
    banner.textContent = '⏳ Enregistrement de ton action…';
  }
  if (lastError) {
    const line = document.createElement("p"); line.setAttribute("role", "alert"); line.textContent = lastError; $("actions").appendChild(line);
  }
  updateClock();
  showDice();
}
function showDice() {
  const animation = state.animation;
  if (!animation || animation.id === lastAnimation || Date.now() - animation.at > 8000) return;
  lastAnimation = animation.id;
  clearTimeout(animationTimer);
  const stage = $('dice-stage'), cube = $('dice-cube');
  stage.classList.remove('hidden'); cube.classList.add('rolling');
  $('dice-result').textContent = state.players[animation.player].name + ' lance le dé…';
  animationTimer = setTimeout(() => {
    cube.classList.remove('rolling'); stage.classList.add('settled');
    cube.querySelector('.dice-face').textContent = animation.roll;
    $('dice-result').textContent = '🎲 Résultat · ' + animation.roll;
    animationTimer = setTimeout(() => stage.classList.add('hidden'), 1300);
  }, 650);
}
let timeoutPending = false;
function updateClock() {
  if (!state?.deadline || state.gameOver) { $('timerlabel').textContent = ''; return; }
  const seconds = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
  $('timerlabel').textContent = '⏱ ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  if (!seconds && connected && !busy && !timeoutPending) {
    timeoutPending = true;
    send('timeout').finally(() => { timeoutPending = false; });
  }
}
setInterval(updateClock, 1000);
