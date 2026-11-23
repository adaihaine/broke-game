// Confirmed room snapshots and conditional writes. No optimistic game-state mutation.
export function createRoomClient({ readRoom, writeRoom, onRoom, onConnection = () => {} }) {
  let confirmed = null;
  let reading = null;

  function accept(document) {
    const version = document.data.gameRevision || 0;
    const previous = confirmed?.data.gameRevision || 0;
    if (!confirmed || version > previous ||
        (version === previous && document.updateTime >= confirmed.updateTime)) {
      confirmed = document;
      onConnection(true);
      onRoom(document.data);
    }
    return confirmed;
  }

  function refresh() {
    if (reading) return reading;
    reading = readRoom().then(accept).catch(error => {
      onConnection(false);
      throw error;
    }).finally(() => { reading = null; });
    return reading;
  }

  async function publish(action, expectedRevision, transition) {
    let base = confirmed;
    if (!base || (base.data.gameRevision || 0) !== expectedRevision) base = await refresh();
    // A read started before a stream update can finish with the preceding revision.
    if ((base.data.gameRevision || 0) < expectedRevision) base = await refresh();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (base.data.gameState?.lastActionId === action.id) return base;
      if ((base.data.gameRevision || 0) !== expectedRevision)
        throw Error('La partie a avancé. Le plateau vient d’être actualisé.');
      if (base.data.status !== 'playing') throw Error('La partie est fermée.');
      const next = transition(base.data);
      try {
        return accept(await writeRoom(base, next, expectedRevision + 1));
      } catch (error) {
        if (error.status === 403 || error.status === 401 ||
            (error.status === 400 && error.code !== 'FAILED_PRECONDITION')) throw error;
        // A timed-out write may already have committed. Read before retrying the same ID.
        base = await refresh();
        if (base.data.gameState?.lastActionId === action.id) return base;
        if (attempt === 1) throw error;
      }
    }
  }
  return { refresh, publish };
}

export function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value)
    ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)])) } };
}

export function decodeValue(value) {
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return Date.parse(value.timestampValue);
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decodeValue(v)]));
}

export function decodeDocument(document) {
  return {
    updateTime: document.updateTime,
    data: Object.fromEntries(Object.entries(document.fields).map(([k, v]) => [k, decodeValue(v)]))
  };
}
