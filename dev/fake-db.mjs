// In-memory PostgREST-shaped adapter used by local checks and the preview
// server only. The deployed Function uses the platform's injected database.
const value = (row, column) => column.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), row);

const OPERATORS = {
  eq: (a, b) => String(a) === String(b),
  neq: (a, b) => String(a) !== String(b),
  gt: (a, b) => new Date(a) > new Date(b),
  gte: (a, b) => new Date(a) >= new Date(b),
  lt: (a, b) => new Date(a) < new Date(b),
  lte: (a, b) => new Date(a) <= new Date(b),
};

export class BackendError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export function createFakeDb(seed = {}) {
  const tables = {
    posts: [], comments: [], likes: [], teams: [], join_requests: [],
    ...structuredClone(seed),
  };

  class Chain {
    constructor(name) {
      this.name = name;
      this.columns = null;
      this.options = {};
      this.filters = [];
      this.sets = null;
      this.deleteFlag = false;
      this.ordering = null;
      this.limitValue = null;
      this.rangeValue = null;
      this.insertRows = null;
    }
    eq(column, check) { return this.filter('eq', column, check); }
    neq(column, check) { return this.filter('neq', column, check); }
    gt(column, check) { return this.filter('gt', column, check); }
    gte(column, check) { return this.filter('gte', column, check); }
    lt(column, check) { return this.filter('lt', column, check); }
    lte(column, check) { return this.filter('lte', column, check); }
    in(column, list) { this.filters.push(['in', column, list]); return this; }
    filter(op, column, check) { this.filters.push([op, column, check]); return this; }
    order(column, options) { this.ordering = { column, ascending: options?.ascending !== false }; return this; }
    limit(count) { this.limitValue = count; return this; }
    range(from, to) { this.rangeValue = [from, to]; return this; }
    select(columns, options) { this.columns = columns; this.options = options || {}; return this; }
    insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
    update(payload) { this.sets = payload; return this; }
    delete() { this.deleteFlag = true; return this; }
    then(onSuccess, onError) { return Promise.resolve().then(() => this.execute()).then(onSuccess, onError); }

    matching() {
      return tables[this.name].filter(row => this.filters.every(([op, column, check]) => {
        const actual = value(row, column);
        if (op === 'in') return Array.isArray(check) && check.some(item => String(item) === String(actual));
        return OPERATORS[op](actual, check);
      }));
    }

    project(row) {
      if (!this.columns || this.columns.trim() === '*') return { ...row };
      const projected = {};
      this.columns.split(',').map(part => part.trim()).forEach(column => {
        if (row[column] !== undefined) projected[column] = row[column];
      });
      return projected;
    }

    execute() {
      const store = tables[this.name];
      if (this.insertRows) {
        const created = this.insertRows.map(row => ({ ...row }));
        tables[this.name] = [...store, ...created];
        const data = this.columns ? created.map(row => this.project(row)) : [];
        return { data, count: data.length, error: null };
      }
      if (this.sets || this.deleteFlag) {
        if (!this.filters.length) return { data: null, error: { code: 'no_filter', status: 400 } };
        const targets = this.matching();
        if (this.deleteFlag) tables[this.name] = store.filter(row => !targets.includes(row));
        else targets.forEach(row => Object.assign(row, this.sets));
        const data = this.columns ? targets.map(row => this.project(row)) : [];
        return { data, count: data.length, error: null };
      }
      let found = this.matching();
      if (this.ordering) {
        const { column, ascending } = this.ordering;
        found = [...found].sort((a, b) => {
          const left = value(a, column);
          const right = value(b, column);
          if (left === right) return 0;
          return (left > right ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      const count = this.options.count ? found.length : null;
      if (this.rangeValue) found = found.slice(this.rangeValue[0], this.rangeValue[1] + 1);
      else if (this.limitValue !== null) found = found.slice(0, this.limitValue);
      return { data: found.map(row => this.project(row)), count, error: null };
    }
  }

  const db = { from: name => new Chain(name) };
  db.tables = tables;
  return db;
}
