/** Reference algorithms only. No SoulForge production module is imported. */
export function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
export function integer(n, min = 0, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(n) && n >= min && n <= max, 'INVALID_INTEGER');
  return n;
}
export function nonempty(s) {
  check(typeof s === 'string' && s.length > 0, 'EMPTY_IDENTITY');
  return s;
}
export function cmpText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
export function stableJson(value) {
  const ancestors = new Set();
  function visit(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') { check(Number.isFinite(v), 'NONFINITE_JSON'); return JSON.stringify(v); }
    check(typeof v === 'object' && v !== null, 'UNSUPPORTED_JSON');
    check(!ancestors.has(v), 'CYCLIC_JSON');
    ancestors.add(v);
    let out;
    if (Array.isArray(v)) out = '[' + v.map(visit).join(',') + ']';
    else {
      check(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'NONPLAIN_JSON');
      out = '{' + Object.keys(v).sort(cmpText).map(k => JSON.stringify(k) + ':' + visit(v[k])).join(',') + '}';
    }
    ancestors.delete(v);
    return out;
  }
  return visit(value);
}
