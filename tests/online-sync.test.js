import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClient, encodeValue, decodeValue, decodeDocument } from '../online-sync.js';

const snapshot = (revision = 1, id = 'start') => ({
  updateTime: '2026-11-23T10:00:0' + revision + '.000000000Z',
  data: { status: 'playing', gameRevision: revision, gameState: { lastActionId: id } }
});
const transition = id => room => ({ ...room.gameState, lastActionId: id });
const conflict = () => Object.assign(Error('Precondition'), { status: 412, code: 'FAILED_PRECONDITION' });

test('One conditional write applies its acknowledgement without waiting for the listener', async () => {
  let reads = 0, writes = 0, seen = [];
  const client = createRoomClient({
    readRoom: async () => { reads++; return snapshot(); },
    writeRoom: async (base, next, revision) => {
      writes++; assert.equal(base.updateTime, snapshot().updateTime);
      return snapshot(revision, next.lastActionId);
    },
    onRoom: room => seen.push(room.gameRevision)
  });
  await client.refresh();
  await client.publish({ id: 'roll' }, 1, transition('roll'));
  assert.equal(reads, 1); assert.equal(writes, 1);
  assert.deepEqual(seen, [1, 2]);
});

test('Concurrent refreshes share a single request', async () => {
  let reads = 0;
  const client = createRoomClient({ readRoom: async () => { reads++; return snapshot(); }, writeRoom() {}, onRoom() {} });
  await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
  assert.equal(reads, 1);
});

test('A delayed older read cannot roll back a confirmed write', async () => {
  let resolveRead, reads = 0, revisions = [];
  const client = createRoomClient({
    readRoom: () => ++reads === 1 ? Promise.resolve(snapshot()) : new Promise(resolve => { resolveRead = resolve; }),
    writeRoom: async () => snapshot(2, 'roll'),
    onRoom: room => revisions.push(room.gameRevision)
  });
  await client.refresh();
  const slow = client.refresh();
  await client.publish({ id: 'roll' }, 1, transition('roll'));
  resolveRead(snapshot());
  const actual = await slow;
  assert.equal(actual.data.gameRevision, 2);
  assert.deepEqual(revisions, [1, 2]);
});

test('A lost write acknowledgement is confirmed by ID, without a second roll', async () => {
  let remote = snapshot(), writes = 0;
  const client = createRoomClient({
    readRoom: async () => remote,
    writeRoom: async () => { writes++; remote = snapshot(2, 'roll'); throw Error('Timeout'); },
    onRoom() {}
  });
  await client.refresh();
  const result = await client.publish({ id: 'roll' }, 1, transition('roll'));
  assert.equal(writes, 1); assert.equal(result.data.gameRevision, 2);
});

test('A conflicting newer action is refreshed and never overwritten', async () => {
  let remote = snapshot(), writes = 0, displayed;
  const client = createRoomClient({
    readRoom: async () => remote,
    writeRoom: async () => { writes++; remote = snapshot(2, 'another-phone'); throw conflict(); },
    onRoom: room => { displayed = room; }
  });
  await client.refresh();
  await assert.rejects(client.publish({ id: 'roll' }, 1, transition('roll')), /avancé/);
  assert.equal(writes, 1); assert.equal(displayed.gameState.lastActionId, 'another-phone');
});

test('A changed timestamp at the same revision can retry with a fresh precondition', async () => {
  let remote = snapshot(), writes = 0;
  const client = createRoomClient({
    readRoom: async () => remote,
    writeRoom: async (base, next) => {
      writes++;
      if (writes === 1) { remote = { ...snapshot(), updateTime: '2026-11-23T10:00:01.100000000Z' }; throw conflict(); }
      assert.equal(base.updateTime, remote.updateTime);
      return snapshot(2, next.lastActionId);
    },
    onRoom() {}
  });
  await client.refresh();
  await client.publish({ id: 'roll' }, 1, transition('roll'));
  assert.equal(writes, 2);
});

test('Permission errors are surfaced without a retry', async () => {
  let writes = 0, reads = 0;
  const client = createRoomClient({
    readRoom: async () => { reads++; return snapshot(); },
    writeRoom: async () => { writes++; throw Object.assign(Error('Denied'), { status: 403 }); },
    onRoom() {}
  });
  await client.refresh();
  await assert.rejects(client.publish({ id: 'roll' }, 1, transition('roll')), /Denied/);
  assert.equal(writes, 1); assert.equal(reads, 1);
});

test('Fallback reads recover an update even if no stream event arrives', async () => {
  let remote = snapshot(), displayed;
  const client = createRoomClient({ readRoom: async () => remote, writeRoom() {}, onRoom: room => { displayed = room; } });
  await client.refresh();
  remote = snapshot(2, 'remote-roll');
  await client.refresh();
  assert.equal(displayed.gameState.lastActionId, 'remote-roll');
});

test('Firestore wire format preserves the complete shared game state', () => {
  const value = { players: [{ name: 'Joueur', cash: -150, bankrupt: false }], pending: null, current: 0, multiplier: .35 };
  assert.deepEqual(decodeValue(encodeValue(value)), value);
  assert.equal(decodeValue({ timestampValue: '2026-11-23T10:00:00Z' }), Date.parse('2026-11-23T10:00:00Z'));
  assert.deepEqual(decodeDocument({ updateTime: 'stamp', fields: { gameState: encodeValue(value) } }).data.gameState, value);
});

test('A stale in-flight poll cannot reject a freshly received stream revision', async () => {
  let reads = 0;
  const client = createRoomClient({
    readRoom: async () => ++reads < 3 ? snapshot(1) : snapshot(2, 'peer-action'),
    writeRoom: async (base, next, revision) => {
      assert.equal(base.data.gameRevision, 2);
      return snapshot(revision, next.lastActionId);
    },
    onRoom() {}
  });
  await client.refresh();
  const result = await client.publish({ id: 'roll' }, 2, transition('roll'));
  assert.equal(result.data.gameRevision, 3);
  assert.equal(reads, 3);
});
