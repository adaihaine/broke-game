import { board } from './online-board.js';

export const round10 = n => Math.round(n / 10) * 10;
const clone = value => JSON.parse(JSON.stringify(value));
const require = (condition, message) => { if (!condition) throw Error(message); };
const owned = (s, player) => s.properties.map((p, i) => p.owner === player ? i : -1).filter(i => i >= 0);
export const upgradeCost = i => round10(board[i].price * .5);
export const saleValue = (s, i) => round10(board[i].price * .7) + s.properties[i].level * round10(upgradeCost(i) * .7);
export const complete = (s, i) => s.properties[i].owner >= 0 && board.every((c, j) => c.type !== board[i].type || s.properties[j].owner === s.properties[i].owner);
export const rent = (s, i) => round10(board[i].price * (complete(s, i) ? .3 : .12) * (1 + s.properties[i].level));
export const wealth = (s, player) => s.players[player].cash + owned(s, player).reduce((total, i) => total + board[i].price + s.properties[i].level * upgradeCost(i), 0);
export const actor = s => s.pending?.actor ?? s.current;
const record = (s, text) => { s.message = text; s.logs = [text, ...(s.logs || [])].slice(0, 30); };
const decision = (s, type, details = {}) => {
  s.phase = type;
  s.pending = { type, actor: s.current, ...details };
};
const end = (s, winner, reason) => {
  s.gameOver = true; s.winner = winner; s.phase = 'gameover'; s.pending = null;
  record(s, '🏆 ' + s.players[winner].name + ' gagne ! ' + reason);
};
function victory(s) {
  const alive = s.players.map((p, i) => p.bankrupt ? -1 : i).filter(i => i >= 0);
  if (alive.length === 1) { end(s, alive[0], 'Dernier joueur en jeu.'); return true; }
  const winners = alive.filter(i => wealth(s, i) >= s.goal).sort((a, b) => wealth(s, b) - wealth(s, a));
  if (winners.length) { end(s, winners[0], 'Objectif de fortune atteint.'); return true; }
  return false;
}
function eliminate(s, i) {
  const p = s.players[i];
  s.loot += Math.max(0, p.cash);
  p.cash = 0; p.bankrupt = true; p.jail = 0;
  owned(s, i).forEach(j => { s.properties[j] = { owner: -1, level: 0 }; });
  record(s, p.name + ' quitte la partie. Ses propriétés sont libérées.');
}
function finish(s) {
  s.pending = null; s.phase = 'end';
  if (s.players[s.current].cash <= -500) eliminate(s, s.current);
  if (victory(s)) return;
  if (s.players[s.current].bankrupt) { advance(s); return; }
  if (s.players[s.current].cash < 0 && owned(s, s.current).length) decision(s, 'debt');
}
function advance(s) {
  s.pending = null;
  if (victory(s)) return;
  if (s.extraTurn && !s.players[s.current].bankrupt && !s.players[s.current].jail) {
    s.extraTurn = false; s.phase = 'roll'; record(s, '🎲 Six ! Tu rejoues.'); return;
  }
  s.extraTurn = false;
  do { s.current = (s.current + 1) % s.players.length; } while (s.players[s.current].bankrupt);
  const p = s.players[s.current];
  if (p.jail > 0) decision(s, 'jail-choice', { bail: Math.max(100, p.jail * 100), resume: 'roll' });
  else s.phase = 'roll';
  record(s, 'Tour de ' + p.name + '.');
}
function charge(s, amount, to = -1) {
  s.players[s.current].cash -= amount;
  if (to >= 0) s.players[to].cash += amount;
  else s.loot += amount;
}
function jail(s, turns) {
  s.players[s.current].pos = 16; s.players[s.current].jail = turns; s.extraTurn = false;
}
const others = s => s.properties.map((p, i) => p.owner >= 0 && p.owner !== s.current ? i : -1).filter(i => i >= 0 && !s.players[s.properties[i].owner].bankrupt);
const eligibleRobbery = s => others(s).filter(i => !complete(s, i));
function land(s, random) {
  const p = s.players[s.current], i = p.pos, cell = board[i], property = s.properties[i];
  record(s, p.name + ' arrive sur ' + cell.name + '.');
  if (cell.price) {
    if (property.owner === -1 && p.cash >= cell.price) { decision(s, 'purchase', { cell: i }); return; }
    if (property.owner >= 0 && property.owner !== s.current) {
      const cost = rent(s, i); charge(s, cost, property.owner);
      record(s, p.name + ' paie ' + cost + ' € de loyer à ' + s.players[property.owner].name + '.');
    }
    finish(s); return;
  }
  switch (cell.type) {
    case 'loot': p.cash += s.loot; record(s, '💰 Butin récupéré : ' + s.loot + ' €.'); s.loot = 0; break;
    case 'bonus': p.cash += 150; break;
    case 'tax': charge(s, 100); record(s, 'Taxe : 100 € versés au Butin.'); break;
    case 'chance': {
      const amount = [-150, -100, 100, 150, 200][draw(random, 5)];
      if (amount < 0) charge(s, -amount); else p.cash += amount;
      record(s, '🍀 Chance : ' + amount + ' €.'); break;
    }
    case 'jail':
      p.jail = 3; s.extraTurn = false;
      decision(s, 'jail-choice', { bail: 300, resume: 'end' }); return;
    case 'wheel': decision(s, 'wheel'); return;
    case 'casino': if (p.cash > 0) { decision(s, 'casino'); return; } break;
    case 'rob': decision(s, 'rob'); return;
    case 'deal': if (others(s).length) { decision(s, 'deal'); return; } break;
  }
  finish(s);
}
function draw(random, count) {
  const n = random();
  require(Number.isFinite(n) && n >= 0 && n < 1, 'Tirage invalide.');
  return Math.floor(n * count);
}
export function createGame(room, now = Date.now()) {
  const playerIds = Object.keys(room.players).sort();
  require(playerIds.length >= 2 && playerIds.length <= 4, 'Il faut 2 à 4 joueurs.');
  return {
    version: 2, playerIds, players: playerIds.map(id => ({ name: room.players[id].name, cash: 1500, pos: 0, jail: 0, bankrupt: false })),
    properties: board.map(() => ({ owner: -1, level: 0 })), current: 0, phase: 'roll',
    roll: 0, loot: 0, extraTurn: false, goal: room.goal || 3000,
    deadline: room.duration ? now + room.duration * 60000 : 0, gameOver: false,
    pending: null, logs: [], message: 'Bienvenue dans BROKE! Lance le dé.', winner: null,
    lastActionId: 'initialize', lastAction: { type: 'initialize', uid: room.host, player: playerIds.indexOf(room.host) }, animation: null
  };
}
// Upgrade snapshots produced by the first prototype without resetting balances.
export function normalizeGame(state, room) {
  const s = clone(state);
  s.playerIds ||= Object.keys(room.players).sort();
  s.version = 2; s.logs ||= []; s.animation ||= null;
  s.lastActionId ||= null; s.winner ??= null;
  s.message ||= 'Partie synchronisée.';
  if (state.version !== 2) {
    if (s.phase === 'purchase') s.pending = { type: 'purchase', actor: s.current, cell: state.pending?.cell ?? s.players[s.current].pos };
    else if (s.phase === 'jail-choice') s.pending = { type: 'jail-choice', actor: s.current, bail: Math.max(100, s.players[s.current].jail * 100), resume: 'roll' };
    else if (!['roll', 'end', 'gameover'].includes(s.phase)) {
      s.pending = null; s.phase = 'end'; s.message = 'Tour repris après reconnexion.';
    } else s.pending = null;
  }
  return s;
}
export function reduceGame(state, uid, action, random = Math.random, now = Date.now()) {
  const s = clone(state), player = s.playerIds.indexOf(uid), p = s.players[s.current];
  require(player >= 0, 'Tu ne fais pas partie de cette partie.');
  if (action.id && action.id === s.lastActionId) return s;
  require(!s.gameOver, 'La partie est terminée.');
  s.lastAction = { type: action.type, uid, player };
  if (action.type === 'quit') {
    require(!s.players[player].bankrupt, 'Tu as déjà quitté cette partie.');
    eliminate(s, player);
    if (!victory(s)) {
      if (player === s.current) { s.extraTurn = false; advance(s); }
      else if (s.pending && (actor(s) === player || s.pending.seller === player || s.pending.buyer === player || s.pending.opponents?.includes(player))) {
        record(s, 'Négociation annulée après un abandon.'); finish(s);
      }
    }
    s.lastActionId = action.id; return s;
  }
  if (action.type === 'timeout') {
    require(s.deadline > 0 && now >= s.deadline, 'Le temps de jeu continue.');
    const alive = s.players.map((p, i) => p.bankrupt ? -1 : i).filter(i => i >= 0).sort((a, b) => wealth(s, b) - wealth(s, a));
    end(s, alive[0], 'Temps écoulé.'); s.lastActionId = action.id; return s;
  }
  require(!s.players[player].bankrupt, 'Tu as quitté cette partie.');
  require(player === actor(s), 'En attente de la décision de ' + s.players[actor(s)].name + '.');
  const pending = s.pending;
  const propertyIndex = Number(action.cell);
  const property = s.properties[propertyIndex], cell = board[propertyIndex];
  const at = (...phases) => require(phases.includes(s.phase), 'Cette action ne correspond plus au tour. Recharge la partie.');
  if (action.type === 'roll') {
    at('roll');
    s.roll = draw(random, 6) + 1; s.extraTurn = s.roll === 6;
    const origin = p.pos;
    for (let step = 1; step <= s.roll; step++) {
      p.pos = (p.pos + 1) % board.length;
      if (p.pos === 0) p.cash += step === s.roll ? 400 : 200;
    }
    s.animation = { id: action.id, player: s.current, origin, destination: p.pos, roll: s.roll, at: now };
    land(s, random);
  } else if (action.type === 'buy') {
    at('purchase'); const i = pending.cell;
    require(s.properties[i].owner === -1 && p.cash >= board[i].price, 'Achat impossible.');
    p.cash -= board[i].price; s.properties[i].owner = s.current;
    record(s, p.name + ' achète ' + board[i].name + '.'); finish(s);
  } else if (action.type === 'pass') {
    at('purchase', 'casino', 'deal', 'rob', 'wheel'); finish(s);
  } else if (action.type === 'next') {
    at('end'); advance(s);
  } else if (action.type === 'bail' || action.type === 'stay') {
    at('jail-choice');
    if (action.type === 'bail') {
      require(p.cash >= pending.bail, 'Liquidités insuffisantes.');
      p.cash -= pending.bail; p.jail = 0;
    } else if (pending.resume === 'roll') p.jail--;
    if (pending.resume === 'end') finish(s);
    else if (action.type === 'stay') { s.extraTurn = false; advance(s); }
    else { s.pending = null; s.phase = 'roll'; }
  } else if (action.type === 'sell' || action.type === 'upgrade') {
    at('roll', 'end', 'debt');
    require(cell?.price && property?.owner === player, 'Cette propriété ne t’appartient pas.');
    if (action.type === 'sell') {
      p.cash += saleValue(s, propertyIndex); property.owner = -1; property.level = 0;
      record(s, p.name + ' vend ' + cell.name + '.');
      if (s.phase === 'debt') finish(s);
    } else {
      require(s.phase !== 'debt' && complete(s, propertyIndex) && property.level < 3 && p.cash >= upgradeCost(propertyIndex), 'Amélioration impossible.');
      p.cash -= upgradeCost(propertyIndex); property.level++;
      record(s, cell.name + ' amélioré au niveau ' + property.level + '.'); victory(s);
    }
  } else if (action.type === 'wheel') {
    at('wheel');
    const prize = draw(random, 6);
    if (prize === 1) {
      const destinations = board.filter(c => c.i !== p.pos && c.type !== 'wheel');
      p.pos = destinations[draw(random, destinations.length)].i; land(s, random);
    } else if (prize === 2) {
      const amount = [-150, -100, 100, 150, 200][draw(random, 5)];
      if (amount < 0) charge(s, -amount); else p.cash += amount;
      record(s, '🎡 Chance : ' + amount + ' €.'); finish(s);
    } else if (prize === 3) {
      jail(s, 2); record(s, '🎡 Deux tours en GAV.'); finish(s);
    } else {
      const amount = [50, 0, 0, 0, 100, -50][prize];
      if (amount < 0) charge(s, -amount); else p.cash += amount;
      record(s, '🎡 Roue : ' + amount + ' €.'); finish(s);
    }
  } else if (action.type === 'bet') {
    at('casino');
    require(['red', 'black', 'green'].includes(action.color), 'Couleur invalide.');
    require(Number.isInteger(action.stake) && action.stake > 0 && action.stake <= p.cash, 'Mise invalide.');
    const n = draw(random, 37), red = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    const color = n === 0 ? 'green' : red.includes(n) ? 'red' : 'black';
    const delta = color === action.color ? action.stake * (color === 'green' ? 35 : 1) : -action.stake;
    p.cash += delta; record(s, '🎰 Tirage ' + n + ' (' + color + ') : ' + delta + ' €.'); finish(s);
  } else if (action.type === 'rob-cash' || action.type === 'rob-property') {
    at('rob'); const victim = action.type === 'rob-cash' ? Number(action.target) : property?.owner;
    require(Number.isInteger(victim) && victim >= 0 && victim < s.players.length && victim !== player && !s.players[victim].bankrupt, 'Victime invalide.');
    if (action.type === 'rob-property') require(owned(s, player).length >= 2 && eligibleRobbery(s).includes(propertyIndex), 'Braquage indisponible.');
    if (random() < (action.type === 'rob-cash' ? .35 : 1 / 3)) {
      if (action.type === 'rob-cash') {
        const amount = Math.min(400, Math.max(0, s.players[victim].cash));
        p.cash += amount; s.players[victim].cash -= amount;
        record(s, '🥷 Braquage réussi : ' + amount + ' €.');
      } else { property.owner = player; record(s, '🥷 ' + cell.name + ' volé !'); }
      finish(s);
    } else {
      jail(s, 2); record(s, '🥷 Braquage raté. Deux tours en GAV.');
      if (action.type === 'rob-property') decision(s, 'rob-penalty', { victim, remaining: 2 });
      else {
        const due = Math.max(100, round10(Math.max(0, p.cash) * .1));
        if (p.cash < due && owned(s, player).length) decision(s, 'rob-penalty', { victim, remaining: 1 });
        else { charge(s, due, victim); finish(s); }
      }
    }
  } else if (action.type === 'cede') {
    at('rob-penalty');
    require(property?.owner === player && cell?.price, 'Propriété invalide.');
    property.owner = pending.victim;
    record(s, p.name + ' cède ' + cell.name + '.');
    pending.remaining--;
    if (!pending.remaining || !owned(s, player).length) finish(s);
  } else if (action.type === 'offer') {
    at('deal');
    require(property?.owner >= 0 && property.owner !== player && cell.price && !s.players[property.owner].bankrupt, 'Propriété indisponible.');
    require(Number.isInteger(action.price) && action.price >= round10(cell.price * 1.1) && action.price <= p.cash, 'Offre invalide ou liquidités insuffisantes.');
    decision(s, 'offer-response', { actor: property.owner, cell: propertyIndex, buyer: player, seller: property.owner, price: action.price, counter: false });
    record(s, p.name + ' propose ' + action.price + ' € pour ' + cell.name + '.');
  } else if (action.type === 'counter') {
    at('offer-response');
    require(!pending.counter && player === pending.seller, 'Contre-offre indisponible.');
    require(Number.isInteger(action.price) && action.price >= round10(board[pending.cell].price * 1.1), 'Prix invalide.');
    pending.price = action.price; pending.actor = pending.buyer; pending.counter = true;
    record(s, s.players[player].name + ' demande ' + action.price + ' €.');
  } else if (action.type === 'accept' || action.type === 'reject') {
    at('offer-response');
    if (action.type === 'accept') {
      const offer = pending, prop = s.properties[offer.cell];
      require(prop.owner === offer.seller && s.players[offer.buyer].cash >= offer.price, 'Transaction impossible.');
      s.players[offer.buyer].cash -= offer.price; s.players[offer.seller].cash += offer.price;
      prop.owner = offer.buyer; prop.level = 0; record(s, '🤝 Rachat conclu.');
    } else record(s, 'Offre refusée.');
    finish(s);
  } else if (action.type === 'exchange') {
    at('deal'); require(property?.owner === player && cell.price, 'Propriété à échanger invalide.');
    const opponents = s.players.map((p, i) => !p.bankrupt && i !== player ? i : -1).filter(i => i >= 0 && owned(s, i).length);
    require(opponents.length, 'Aucune propriété adverse disponible.');
    decision(s, 'exchange-response', { cell: propertyIndex, opponents, index: 0, offers: [], actor: opponents[0] });
  } else if (action.type === 'exchange-answer') {
    at('exchange-response');
    if (action.cell !== null) {
      require(property?.owner === player && cell.price, 'Propriété invalide.');
      pending.offers.push({ player, cell: propertyIndex });
    }
    pending.index++;
    if (pending.index < pending.opponents.length) pending.actor = pending.opponents[pending.index];
    else if (pending.offers.length) {
      pending.type = 'exchange-pick'; pending.actor = s.current; s.phase = 'exchange-pick';
    } else { record(s, 'Aucune proposition d’échange.'); finish(s); }
  } else if (action.type === 'exchange-pick') {
    at('exchange-pick');
    if (action.cell !== null) {
      const offer = pending.offers.find(o => o.cell === propertyIndex);
      require(offer && property.owner === offer.player && s.properties[pending.cell].owner === s.current, 'Échange indisponible.');
      s.properties[pending.cell].owner = offer.player; property.owner = s.current;
      p.cash += 100; s.players[offer.player].cash += 100; record(s, '🤝 Échange conclu. Bonus de 100 € chacun.');
    } else record(s, 'Échange refusé.');
    finish(s);
  } else throw Error('Action inconnue.');
  s.lastActionId = action.id || null;
  return s;
}
