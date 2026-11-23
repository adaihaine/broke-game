// Explicit live integration test. Creates disposable anonymous players and private test rooms.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { firebaseConfig } from '../firebase-config.js';
import { createGame, normalizeGame, reduceGame, actor } from '../online-engine.js';
const root = 'projects/' + firebaseConfig.projectId + '/databases/(default)/documents';
const api = 'https://firestore.googleapis.com/v1/';
const accounts = [];
function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])) } };
}
function decode(value) {
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return Date.parse(value.timestampValue);
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decode(v)]));
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok) { const error = Error(result.error?.message || response.statusText); error.status = response.status; throw error; }
  return result;
}
for (let i = 0; i < 4; i++) {
  const user = await request('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + firebaseConfig.apiKey, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true })
  });
  accounts.push({ uid: user.localId, token: user.idToken, name: 'Test ' + (i + 1) });
}
async function read(name, account) {
  const result = await request(api + name, { headers: { Authorization: 'Bearer ' + account.token } });
  return { data: Object.fromEntries(Object.entries(result.fields).map(([k, v]) => [k, decode(v)])), updateTime: result.updateTime };
}
async function write(name, fields, account, mask, updateTime, timestamps = []) {
  const patch = { update: { name, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encode(v)])) } };
  if (mask) patch.updateMask = { fieldPaths: mask };
  if (updateTime) patch.currentDocument = { updateTime };
  if (timestamps.length) patch.updateTransforms = timestamps.map(fieldPath => ({ fieldPath, setToServerValue: 'REQUEST_TIME' }));
  return request(api + root + ':commit', {
    method: 'POST', headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [patch] })
  });
}
async function setup(count) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const name = root + '/rooms/' + code, host = accounts[0], joined = accounts.slice(0, count);
  await write(name, { host: host.uid, status: 'waiting', goal: 3000, duration: 0, players: { [host.uid]: { name: host.name, ready: false } } }, host, null, null, ['createdAt']);
  for (const account of joined.slice(1)) {
    const snap = await read(name, host);
    await write(name, { players: { ...snap.data.players, [account.uid]: { name: account.name, ready: false } } }, account, ['players'], snap.updateTime);
  }
  for (const account of joined) {
    const snap = await read(name, account);
    snap.data.players[account.uid].ready = true;
    await write(name, { players: snap.data.players }, account, ['players'], snap.updateTime);
  }
  let snap = await read(name, host);
  await write(name, { status: 'playing', goal: 3000, duration: 0 }, host, ['status', 'goal', 'duration'], snap.updateTime, ['startedAt']);
  snap = await read(name, host);
  await write(name, { gameState: createGame(snap.data), gameRevision: 1 }, host, ['gameState', 'gameRevision'], snap.updateTime);
  console.log('Salon de test ' + code + ' initialisé avec ' + count + ' identités.');
  return { name, joined };
}
async function action(game, type, payload = {}, random = 0, accountOverride) {
  const snap = await read(game.name, game.joined[0]), state = normalizeGame(snap.data.gameState, snap.data);
  const account = accountOverride || game.joined.find(a => a.uid === state.playerIds[actor(state)]);
  const next = reduceGame(state, account.uid, { type, ...payload, id: randomUUID() }, () => random);
  await write(game.name, { gameState: next, gameRevision: snap.data.gameRevision + 1 }, account, ['gameState', 'gameRevision'], snap.updateTime);
  const received = await Promise.all(game.joined.map(a => read(game.name, a)));
  received.forEach(r => assert.deepEqual(r.data.gameState, next));
  return next;
}
const game = await setup(2);
await action(game, 'roll'); await action(game, 'buy'); await action(game, 'next');
await action(game, 'roll'); await action(game, 'next');
await action(game, 'roll', {}, .3); await action(game, 'buy'); await action(game, 'next');
await action(game, 'roll', {}, .6); await action(game, 'buy'); await action(game, 'next');
const deal = await action(game, 'roll'); assert.equal(deal.phase, 'deal');
const offer = await action(game, 'offer', { cell: 5, price: 300 });
assert.equal(actor(offer), 1);
const snap = await read(game.name, game.joined[0]);
const buyer = game.joined.find(a => a.uid === offer.playerIds[0]);
const illegal = reduceGame(offer, offer.playerIds[1], { type: 'accept', id: randomUUID() });
await assert.rejects(write(game.name, { gameState: illegal, gameRevision: snap.data.gameRevision + 1 }, buyer, ['gameState', 'gameRevision'], snap.updateTime), e => e.status === 403);
console.log('Réponse envoyée par le mauvais téléphone refusée par Firebase.');
await action(game, 'counter', { price: 400 });
const accepted = await action(game, 'accept');
assert.equal(accepted.properties[5].owner, 0);
console.log('Offre, contre-offre et acceptation synchronisées sur les deux identités.');
// Opponent abandonment must work even outside their turn.
const opponent = game.joined.find(a => a.uid === accepted.playerIds[1]);
const ended = await action(game, 'quit', {}, 0, opponent);
assert.equal(ended.winner, 0);
console.log('Abandon hors tour accepté, victoire synchronisée.');

const four = await setup(4);
let state = (await read(four.name, four.joined[0])).data.gameState;
for (const index of [1, 2]) {
  const account = four.joined.find(a => a.uid === state.playerIds[index]);
  state = await action(four, 'quit', {}, 0, account);
}
await action(four, 'roll'); await action(four, 'pass');
state = await action(four, 'next');
assert.equal(state.current, 3);
console.log('À quatre joueurs, les joueurs ayant abandonné sont sautés correctement.');
const snap4 = await read(four.name, four.joined[0]);
const active = four.joined.find(a => a.uid === state.playerIds[state.current]);
const next = reduceGame(state, active.uid, { type: 'roll', id: randomUUID() }, () => 0);
const writes = await Promise.allSettled([
  write(four.name, { gameState: next, gameRevision: snap4.data.gameRevision + 1 }, active, ['gameState', 'gameRevision'], snap4.updateTime),
  write(four.name, { gameState: next, gameRevision: snap4.data.gameRevision + 1 }, active, ['gameState', 'gameRevision'], snap4.updateTime)
]);
assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
console.log('Deux écritures simultanées : un seul lancer validé.');
await action(four, 'quit', {}, 0, active);
console.log('Tous les contrôles Firebase réels ont réussi.');
