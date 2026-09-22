'use strict';
// Fake DynamoDB DocumentClient para pruebas: implementa query/get/batchWrite
// con semántica de KeyConditionExpression usada por drex-cloud.js.
// Soporta retrasos configurables por clave para simular condiciones de carrera.
function makeFakeDb() {
  const store = new Map(); // "pk\0sk" -> item {pk, sk, v}
  const delayRules = [];   // {match(params)->bool, ms}
  const log = [];

  function addDelayRule(match, ms) { delayRules.push({ match, ms }); }
  function delayFor(kind, params) {
    let ms = 0;
    for (const r of delayRules) { try { if (r.match(kind, params)) ms = Math.max(ms, r.ms); } catch (_) {} }
    return ms;
  }
  function put(pk, sk, v) {
    store.set(pk + '\x00' + sk, { pk, sk, v: JSON.stringify(v === undefined ? null : v) });
  }
  function sortedItems(pk, pfx) {
    const out = [];
    for (const it of store.values()) {
      if (it.pk !== pk) continue;
      if (pfx !== undefined && !String(it.sk).startsWith(pfx)) continue;
      out.push(it);
    }
    out.sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : (String(a.sk) > String(b.sk) ? 1 : 0)));
    return out;
  }
  function toItem(it) { return { pk: it.pk, sk: it.sk, v: it.v }; }
  const dc = {
    query(params) {
      return {
        promise() {
          return new Promise((resolve) => {
            const ms = delayFor('query', params);
            setTimeout(() => {
              log.push(['query', params.KeyConditionExpression, JSON.stringify(params.ExpressionAttributeValues)]);
              const vals = params.ExpressionAttributeValues || {};
              const pk = vals[':pk'];
              const pfx = vals[':pfx'];
              let items = sortedItems(pk, pfx);
              if (params.ExclusiveStartKey) {
                const eks = params.ExclusiveStartKey.sk;
                items = items.filter(it => String(it.sk) > String(eks));
              }
              let lek = null;
              if (params.Limit && items.length > params.Limit) {
                const cut = items[params.Limit - 1];
                lek = { pk: cut.pk, sk: cut.sk };
                items = items.slice(0, params.Limit);
              }
              resolve({ Items: items.map(toItem), LastEvaluatedKey: lek });
            }, ms);
          });
        }
      };
    },
    get(params) {
      return {
        promise() {
          return new Promise((resolve) => {
            const ms = delayFor('get', params);
            setTimeout(() => {
              log.push(['get', params.Key.pk, params.Key.sk]);
              const it = store.get(params.Key.pk + '\x00' + params.Key.sk);
              resolve({ Item: it ? toItem(it) : undefined });
            }, ms);
          });
        }
      };
    },
    batchWrite(params) {
      return {
        promise() {
          return new Promise((resolve) => {
            setTimeout(() => {
              const tableReqs = params.RequestItems[Object.keys(params.RequestItems)[0]] || [];
              tableReqs.forEach(r => {
                if (r.PutRequest) {
                  const it = r.PutRequest.Item;
                  store.set(it.pk + '\x00' + it.sk, { pk: it.pk, sk: it.sk, v: it.v });
                } else if (r.DeleteRequest) {
                  store.delete(r.DeleteRequest.Key.pk + '\x00' + r.DeleteRequest.Key.sk);
                }
              });
              resolve({ UnprocessedItems: {} });
            }, 0);
          });
        }
      };
    },
    transactWrite() { return { promise: () => Promise.reject(new Error('no-transact-in-fake')) }; },
    _put: put,
    _store: store,
    _log: log,
    _addDelayRule: addDelayRule
  };
  return dc;
}
module.exports = { makeFakeDb };
