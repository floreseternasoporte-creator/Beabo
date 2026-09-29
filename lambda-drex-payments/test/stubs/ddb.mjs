// Stubs de @aws-sdk/* para tests: almacén en memoria con evaluación de
// las ConditionExpression que usa index.mjs (nada más).
const store = new Map();
const k = (pk, sk) => pk + '|' + sk;

export class DynamoDBClient {
  constructor() {}
}
export class GetCommand {
  constructor(input) { this.input = input; }
}
export class UpdateCommand {
  constructor(input) { this.input = input; }
}
export class TransactWriteCommand {
  constructor(input) { this.input = input; }
}
export class QueryCommand {
  constructor(input) { this.input = input; }
}

function evalCondition(item, expr, values) {
  expr = String(expr || '').trim();
  if (expr === 'attribute_not_exists(v)') return !item || typeof item.v === 'undefined';
  if (expr === 'attribute_not_exists(sk)') return !item;
  let m = expr.match(/^v = :(\w+)$/);
  if (m) return !!item && String(item.v) === String(values[':' + m[1]]);
  m = expr.match(/^attribute_not_exists\(#c\) OR #c < :(\w+)$/);
  if (m) return !item || (item.n | 0) < values[':' + m[1]];
  throw new Error('stub: condición no soportada: ' + expr);
}

function cancelErr(reasons) {
  const e = new Error('Transaction cancelled');
  e.name = 'TransactionCanceledException';
  e.CancellationReasons = reasons;
  return e;
}

export const DynamoDBDocumentClient = {
  from() {
    return {
      async send(cmd) {
        if (cmd instanceof GetCommand) {
          const { pk, sk } = cmd.input.Key;
          const item = store.get(k(pk, sk));
          return { Item: item ? { ...item } : undefined };
        }
        if (cmd instanceof UpdateCommand) {
          // Solo el patrón del rate limiting.
          const { pk, sk } = cmd.input.Key;
          const key = k(pk, sk);
          const item = store.get(key);
          const vals = cmd.input.ExpressionAttributeValues;
          if (!evalCondition(item, cmd.input.ConditionExpression, vals)) {
            const e = new Error('The conditional request failed');
            e.name = 'ConditionalCheckFailedException';
            throw e;
          }
          const next = { ...(item || { pk, sk }), n: ((item && item.n) | 0) + 1, exp: vals[':exp'] };
          store.set(key, next);
          return {};
        }
        if (cmd instanceof TransactWriteCommand) {
          const items = cmd.input.TransactItems;
          const reasons = [];
          let failed = false;
          for (const it of items) {
            if (it.ConditionCheck) {
              const { pk, sk } = it.ConditionCheck.Key;
              const ok = evalCondition(store.get(k(pk, sk)), it.ConditionCheck.ConditionExpression, it.ConditionCheck.ExpressionAttributeValues || {});
              reasons.push(ok ? { Code: 'None' } : { Code: 'ConditionalCheckFailed' });
              if (!ok) failed = true;
            } else if (it.Put) {
              const { pk, sk } = it.Put.Item;
              const ok = !it.Put.ConditionExpression ||
                evalCondition(store.get(k(pk, sk)), it.Put.ConditionExpression, it.Put.ExpressionAttributeValues || {});
              reasons.push(ok ? { Code: 'None' } : { Code: 'ConditionalCheckFailed' });
              if (!ok) failed = true;
            } else {
              reasons.push({ Code: 'None' });
            }
          }
          if (failed) throw cancelErr(reasons);
          for (const it of items) {
            if (it.Put) {
              const { pk, sk } = it.Put.Item;
              store.set(k(pk, sk), { ...it.Put.Item });
            }
          }
          return {};
        }
        if (cmd instanceof QueryCommand) {
          const { ':pk': pk, ':pre': pre } = cmd.input.ExpressionAttributeValues;
          const items = [];
          for (const [key, item] of store) {
            if (item.pk === pk && String(item.sk).startsWith(pre)) items.push({ ...item });
          }
          items.sort((a, b) => String(a.sk) < String(b.sk) ? -1 : 1);
          return { Items: items };
        }
        throw new Error('stub: comando no soportado');
      },
    };
  },
};

// Helpers del test.
export const __stubStore = store;
export function __stubReset() { store.clear(); }
export function __stubGet(pk, sk) {
  const it = store.get(k(pk, sk));
  return it ? { ...it } : undefined;
}
