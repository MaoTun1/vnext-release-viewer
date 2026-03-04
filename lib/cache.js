const MAX_CACHE_ENTRIES = 64;

/**
 * In-memory TTL cache for API responses. Evicts oldest when over max entries.
 * @param {number} ttlMs - TTL in milliseconds
 * @returns {{ getCached: Function, setCache: Function }}
 */
function createCache(ttlMs) {
  const store = new Map();
  const order = [];

  function evictOne() {
    const k = order.shift();
    if (k !== undefined) store.delete(k);
  }

  function getCached(key) {
    const entry = store.get(key);
    if (!entry || Date.now() > entry.expires) return null;
    return entry.data;
  }

  function setCache(key, data, overrideTtlMs) {
    if (store.size >= MAX_CACHE_ENTRIES && !store.has(key)) evictOne();
    store.set(key, { data, expires: Date.now() + (overrideTtlMs ?? ttlMs) });
    if (!order.includes(key)) order.push(key);
  }

  return { getCached, setCache };
}

module.exports = { createCache };
