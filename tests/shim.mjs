// Minimal DOM shim shared by the frontend render tests.
//
// It is deliberately dumb: `querySelector('#id')` resolves only ids that appear
// in the innerHTML last written to that element, and there is no layout — so
// mount()'s bar-width measuring falls back to a fixed column count. Anything
// that depends on real geometry has to be checked in a browser instead.

export function makeEl() {
  return {
    style: {}, children: [], _html: '', _listeners: {}, _idCache: {}, value: '',
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelector(sel) {
      const id = sel.replace('#', '');
      if (!(this._html && this._html.includes(`id="${id}"`))) return null;
      if (!this._idCache[id]) this._idCache[id] = makeEl();
      return this._idCache[id];
    },
    querySelectorAll() { return []; },
    addEventListener(evt, cb) { (this._listeners[evt] ||= []).push(cb); },
    setAttribute() {},
  };
}

/**
 * Install the fake globals mount() touches.
 * @param {{localStorage?: boolean}} [opts] pass localStorage:true to back the
 *   refresh-interval field with a real store (returned as `.store`).
 */
export function installDom(opts = {}) {
  globalThis.document = { createElement: makeEl, getElementById: () => null, head: { appendChild() {} } };
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  const store = {};
  if (opts.localStorage) {
    globalThis.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    };
  }
  return { store };
}

/** Fire the most recently registered listener for `evt` on `#id` inside `el`. */
export function fire(el, id, evt = 'click') {
  const target = el.querySelector(`#${id}`);
  if (!target) throw new Error(`shim: #${id} not found in rendered HTML`);
  const cbs = target._listeners[evt];
  if (!cbs || !cbs.length) throw new Error(`shim: #${id} has no ${evt} listener`);
  cbs[cbs.length - 1]();
  return target;
}
