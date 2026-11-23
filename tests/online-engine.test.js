import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, reduceGame, normalizeGame, actor, wealth } from '../online-engine.js';
const room = { host: 'zHost', players: { zHost: { name: 'Hôte' }, aGuest: { name: 'Invité' } }, goal: 3000, duration: 0 };
const fresh = () => createGame(room, 1000);
let sequence = 0;
const act = (s, type, payload = {}, r = 0, uid = s.playerIds[actor(s)], now = 2000) =>
  reduceGame(s, uid, { type, ...payload, id: 'test-' + sequence++ }, () => r, now);
const at = (pos, phase = 'roll') => {
  const s = fresh(); s.players[0].pos = pos; s.phase = phase; return s;
};
test('Guest first, host last: stable identities and playable first turn', () => {
  const s = fresh();
  assert.deepEqual(s.playerIds, ['aGuest', 'zHost']);
  assert.equal(s.players[0].name, 'Invité');
  assert.equal(act(s, 'roll').phase, 'purchase');
  assert.throws(() => act(s, 'roll', {}, 0, 'zHost'), /attente/);
  assert.equal(s.players[0].pos, 0);
});
test('Dice, purchase, handoff and replay on another phone', () => {
  let s = act(fresh(), 'roll'); assert.equal(s.roll, 1);
  s = act(s, 'buy'); assert.equal(s.properties[1].owner, 0); assert.equal(s.players[0].cash, 1360);
  s = act(s, 'next'); assert.equal(s.current, 1);
  const resumed = normalizeGame(JSON.parse(JSON.stringify(s)), room);
  s = act(resumed, 'roll'); assert.equal(s.players[1].cash, 1480);
  assert.equal(s.players[0].cash, 1380); assert.equal(s.phase, 'end');
});
test('Duplicate action id cannot apply purchase twice', () => {
  const s = act(fresh(), 'roll'), action = { id: 'buy-once', type: 'buy' };
  const next = reduceGame(s, 'aGuest', action);
  assert.deepEqual(reduceGame(next, 'aGuest', action), next);
});
test('A six grants exactly one extra roll', () => {
  let s = act(fresh(), 'roll', {}, .99); assert.equal(s.roll, 6);
  s = act(s, 'pass'); s = act(s, 'next'); assert.equal(s.current, 0); assert.equal(s.extraTurn, false);
});
test('Start bonus on crossing or exact landing', () => {
  assert.equal(act(at(31), 'roll', {}, .2).players[0].cash, 1700);
  assert.equal(act(at(31), 'roll').players[0].cash, 1900);
});
test('Tax and loot are shared', () => {
  const s = act(at(22), 'roll'); assert.equal(s.loot, 100); assert.equal(s.players[0].cash, 1400);
  s.players[0].pos = 7; s.phase = 'roll';
  const next = act(s, 'roll'); assert.equal(next.loot, 0); assert.equal(next.players[0].cash, 1500);
});
test('Every Chance outcome applies once', () => {
  for (const r of [0, .25, .45, .65, .85]) {
    const s = at(12), values = [r], next = reduceGame(s, 'aGuest', { type: 'roll', id: 'chance' }, () => values.length ? (values.shift(), 0) : r);
    assert.equal(next.phase, 'end');
  }
});
test('Jail entry, bail, and countdown never strand the turn', () => {
  let s = act(at(15), 'roll'); assert.equal(s.phase, 'jail-choice');
  s = act(s, 'stay'); assert.equal(s.phase, 'end'); s = act(s, 'next');
  s.phase = 'end'; s = act(s, 'next'); assert.equal(s.phase, 'jail-choice');
  s = act(s, 'stay'); assert.equal(s.current, 1); assert.equal(s.players[0].jail, 2);
});
test('Bail at the start of a turn lets the captive roll', () => {
  const s = fresh(); s.phase = 'jail-choice'; s.players[0].jail = 2;
  s.pending = { type: 'jail-choice', actor: 0, bail: 200, resume: 'roll' };
  const next = act(s, 'bail'); assert.equal(next.phase, 'roll'); assert.equal(next.players[0].cash, 1300);
});
test('Property management, complete-family rent and upgrades', () => {
  let s = fresh(); s.properties[1].owner = 0; s.properties[3].owner = 0;
  s = act(s, 'upgrade', { cell: 1 }); assert.equal(s.properties[1].level, 1); assert.equal(s.players[0].cash, 1430);
  s = act(s, 'sell', { cell: 1 }); assert.equal(s.properties[1].owner, -1); assert.equal(s.properties[1].level, 0);
  assert.throws(() => act(s, 'upgrade', { cell: 1 }));
});
test('Mandatory debt liquidation resumes the turn', () => {
  const s = fresh(); s.phase = 'debt'; s.pending = { type: 'debt', actor: 0 }; s.players[0].cash = -30; s.properties[1].owner = 0;
  const next = act(s, 'sell', { cell: 1 }); assert.equal(next.players[0].cash, 70); assert.equal(next.phase, 'end');
});
test('Casino validates stake, persists random result, checks victory', () => {
  const s = fresh(); s.phase = 'casino'; s.pending = { type: 'casino', actor: 0 };
  assert.throws(() => act(s, 'bet', { color: 'green', stake: -1 }));
  assert.throws(() => act(s, 'bet', { color: 'red', stake: 1501 }));
  const next = act(s, 'bet', { color: 'green', stake: 100 });
  assert.equal(next.players[0].cash, 5000); assert.equal(next.winner, 0); assert.equal(next.gameOver, true);
});
test('All wheel outcomes complete or produce a recoverable choice', () => {
  for (const r of [0, .2, .4, .55, .7, .9]) {
    const s = at(2, 'wheel'); s.pending = { type: 'wheel', actor: 0 };
    const next = act(s, 'wheel', {}, r);
    assert.ok(['end', 'purchase', 'jail-choice', 'deal', 'casino', 'rob'].includes(next.phase));
    assert.ok(!['rolling', 'moving'].includes(next.phase));
  }
});
test('Cash robbery success and failure', () => {
  const s = at(24, 'rob'); s.pending = { type: 'rob', actor: 0 };
  const success = act(s, 'rob-cash', { target: 1 }); assert.equal(success.players[0].cash, 1900); assert.equal(success.players[1].cash, 1100);
  const fail = act(s, 'rob-cash', { target: 1 }, .99); assert.equal(fail.players[0].jail, 2); assert.equal(fail.players[1].cash, 1650);
});
test('Failed property robbery restores both penalty choices after reload', () => {
  let s = at(24, 'rob'); s.pending = { type: 'rob', actor: 0 };
  s.properties[1].owner = 0; s.properties[3].owner = 0; s.properties[5].owner = 1;
  s = act(s, 'rob-property', { cell: 5 }, .99);
  assert.equal(s.pending.remaining, 2); s = normalizeGame(s, room);
  s = act(s, 'cede', { cell: 1 }); assert.equal(s.pending.remaining, 1);
  s = normalizeGame(s, room); s = act(s, 'cede', { cell: 3 }); assert.equal(s.phase, 'end');
  assert.equal(s.properties[1].owner, 1); assert.equal(s.properties[3].owner, 1);
});
const deal = () => { const s = fresh(); s.phase = 'deal'; s.pending = { type: 'deal', actor: 0 }; s.properties[5].owner = 1; s.properties[1].owner = 0; return s; };
test('Only seller can accept, only buyer can answer a counteroffer', () => {
  let s = act(deal(), 'offer', { cell: 5, price: 300 }); assert.equal(actor(s), 1);
  assert.throws(() => act(s, 'accept', {}, 0, 'aGuest'));
  s = act(s, 'counter', { price: 400 }); assert.equal(actor(s), 0);
  s = normalizeGame(s, room); s = act(s, 'accept');
  assert.equal(s.properties[5].owner, 0); assert.equal(s.players[0].cash, 1100); assert.equal(s.players[1].cash, 1900);
});
test('Exchange response belongs to the owner on their own phone', () => {
  let s = act(deal(), 'exchange', { cell: 1 }); assert.equal(actor(s), 1);
  s = act(s, 'exchange-answer', { cell: 5 }); assert.equal(actor(s), 0);
  s = act(s, 'exchange-pick', { cell: 5 }); assert.equal(s.properties[1].owner, 1); assert.equal(s.properties[5].owner, 0);
  assert.equal(s.players[0].cash, 1600); assert.equal(s.players[1].cash, 1600);
});
test('Four-player exchange collects all responses', () => {
  const r = { ...room, players: { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' }, d: { name: 'D' } } };
  let s = createGame(r); s.phase = 'deal'; s.pending = { type: 'deal', actor: 0 };
  [1, 3, 5, 6].forEach((cell, i) => { s.properties[cell].owner = i; });
  s = act(s, 'exchange', { cell: 1 });
  s = act(s, 'exchange-answer', { cell: 3 }); assert.equal(actor(s), 2);
  s = act(s, 'exchange-answer', { cell: null }); assert.equal(actor(s), 3);
  s = act(s, 'exchange-answer', { cell: 6 }); assert.equal(s.pending.offers.length, 2); assert.equal(actor(s), 0);
});
test('Non-active player can abandon, active players and balances remain stable', () => {
  const s = fresh(); s.properties[5].owner = 1;
  const next = act(s, 'quit', {}, 0, 'zHost');
  assert.equal(next.players[1].bankrupt, true); assert.equal(next.properties[5].owner, -1);
  assert.equal(next.winner, 0); assert.equal(next.loot, 1500);
});
test('Timed victory uses wealth, not the first non-bankrupt player', () => {
  const s = fresh(); s.deadline = 1500; s.players[1].cash = 2200;
  const next = act(s, 'timeout'); assert.equal(next.winner, 1);
  assert.throws(() => act({ ...s, deadline: 5000 }, 'timeout'));
});
test('Legacy snapshot normalizes serialized decisions and identifies players', () => {
  const s = fresh(); delete s.version; delete s.playerIds; s.phase = 'purchase'; s.pending = { cell: 1 };
  assert.equal(normalizeGame(s, room).pending.actor, 0);
  s.phase = 'casino'; assert.equal(normalizeGame(s, room).phase, 'end');
});
test('Random tape gives deterministic transaction retries', () => {
  const s = at(12);
  const a = { type: 'roll', id: 'retry' };
  const random = () => { let i = 0; return () => [0, .8][i++]; };
  assert.deepEqual(reduceGame(s, 'aGuest', a, random()), reduceGame(s, 'aGuest', a, random()));
});
test('Complete automated games with 2–4 phones never strand a decision', () => {
  let seed = 3721;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const seen = new Set();
  for (let count = 2; count <= 4; count++) {
    for (let game = 0; game < 20; game++) {
      const r = { ...room, goal: 7000, players: Object.fromEntries(Array.from({ length: count }, (_, i) => ['p' + i, { name: 'Player ' + i }])) };
      let s = createGame(r);
      for (let step = 0; step < 2500 && !s.gameOver; step++) {
        seen.add(s.phase);
        const own = s.properties.map((p, i) => p.owner === actor(s) ? i : -1).filter(i => i >= 0);
        let type, payload = {};
        switch (s.phase) {
          case 'roll': type = 'roll'; break;
          case 'end': type = 'next'; break;
          case 'purchase': type = 'buy'; break;
          case 'jail-choice': type = s.players[s.current].cash >= s.pending.bail && random() < .5 ? 'bail' : 'stay'; break;
          case 'wheel': type = 'wheel'; break;
          case 'casino': type = 'bet'; payload = { color: 'red', stake: Math.min(100, Math.floor(s.players[s.current].cash)) }; break;
          case 'rob': type = 'rob-cash'; payload = { target: s.players.findIndex((p, i) => i !== s.current && !p.bankrupt) }; break;
          case 'rob-penalty': type = 'cede'; payload = { cell: own[0] }; break;
          case 'debt': type = 'sell'; payload = { cell: own[0] }; break;
          case 'deal': {
            type = own.length ? 'exchange' : 'pass'; payload = { cell: own[0] };
            break;
          }
          case 'exchange-response': type = 'exchange-answer'; payload = { cell: own[0] ?? null }; break;
          case 'exchange-pick': type = 'exchange-pick'; payload = { cell: s.pending.offers[0].cell }; break;
          default: throw Error('Unhandled shared decision: ' + s.phase);
        }
        s = reduceGame(s, s.playerIds[actor(s)], { type, ...payload, id: 'bot-' + count + '-' + game + '-' + step }, random);
        s = normalizeGame(JSON.parse(JSON.stringify(s)), r);
        assert.ok(s.players.every(p => Number.isFinite(p.cash) && p.pos >= 0 && p.pos < 32));
        assert.ok(s.properties.every(p => p.owner >= -1 && p.owner < count && p.level >= 0 && p.level <= 3));
      }
      assert.ok(s.gameOver, 'Game must finish without a blocked decision');
    }
  }
  for (const phase of ['roll', 'purchase', 'end', 'wheel', 'jail-choice', 'casino', 'rob', 'deal', 'exchange-response', 'exchange-pick', 'debt']) assert.ok(seen.has(phase), phase);
});
