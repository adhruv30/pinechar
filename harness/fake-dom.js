// Just enough DOM for overlay.js, plus a clock the branches can drive.
//
// Deliberately small and strict: querySelector supports only the shapes the
// overlay actually uses and throws on anything else, so a selector that quietly
// stops matching shows up as a failure here rather than as a missing pill in a
// browser. The one concession to testability is __shadow: the overlay attaches
// a *closed* root, which real code cannot read back, so the harness keeps a
// side reference to inspect what was rendered.

class ClassList {
  constructor() {
    this.tokens = new Set();
  }
  add(...tokens) {
    for (const t of tokens) this.tokens.add(t);
  }
  remove(...tokens) {
    for (const t of tokens) this.tokens.delete(t);
  }
  contains(token) {
    return this.tokens.has(token);
  }
  toggle(token, force) {
    const on = force === undefined ? !this.tokens.has(token) : Boolean(force);
    if (on) this.tokens.add(token);
    else this.tokens.delete(token);
    return on;
  }
  get value() {
    return [...this.tokens].join(" ");
  }
}

class Style {
  constructor() {
    this.props = new Map();
  }
  setProperty(name, value, priority = "") {
    this.props.set(name, { value, priority });
  }
  removeProperty(name) {
    const previous = this.props.get(name);
    this.props.delete(name);
    return previous ? previous.value : "";
  }
  getPropertyValue(name) {
    return this.props.get(name)?.value ?? "";
  }
  getPropertyPriority(name) {
    return this.props.get(name)?.priority ?? "";
  }
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.style = new Style();
    this.classList = new ClassList();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.__shadow = null;
    this._text = "";
  }

  get className() {
    return this.classList.value;
  }
  set className(value) {
    this.classList = new ClassList();
    for (const token of String(value).split(/\s+/).filter(Boolean)) {
      this.classList.add(token);
    }
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }

  attachShadow({ mode }) {
    const root = new Element("#shadow-root", this.ownerDocument);
    root.mode = mode;
    root.host = this;
    this.__shadow = root;
    return root;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) node.parentNode._detach(node);
      node.parentNode = this;
      this.children.push(node);
    }
    this.ownerDocument?._mutated(this);
  }
  appendChild(node) {
    this.append(node);
    return node;
  }

  _detach(node) {
    const index = this.children.indexOf(node);
    if (index === -1) return;
    this.children.splice(index, 1);
    node.parentNode = null;
    this.ownerDocument?._mutated(this);
  }

  remove() {
    this.parentNode?._detach(this);
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument?.documentElement;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  // Harness-side: fire a listener the way a user click would.
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  matches(selector) {
    const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) {
      const [, name, value] = attr;
      if (!this.attributes.has(name)) return false;
      return value === undefined || this.attributes.get(name) === value;
    }
    if (/^[a-z]+$/i.test(selector)) return this.tagName === selector.toUpperCase();
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    throw new Error(`fake-dom: unsupported selector ${JSON.stringify(selector)}`);
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  // Harness-side convenience: every descendant, including shadow content.
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
      if (child.__shadow) yield* child.__shadow.walk();
    }
  }
}

class MutationObserverImpl {
  constructor(document, callback) {
    this.document = document;
    this.callback = callback;
    this.targets = new Set();
    this.queued = false;
  }
  observe(target, options = {}) {
    if (!options.childList) {
      throw new Error("fake-dom: only childList observation is implemented");
    }
    this.targets.add(target);
    this.document._observers.add(this);
  }
  disconnect() {
    this.targets.clear();
    this.document._observers.delete(this);
  }
  notify(target) {
    if (!this.targets.has(target)) return;
    // Real observers batch into a microtask rather than firing inline. Matching
    // that matters: an inline callback would re-enter the append that triggered
    // it.
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.callback([{ type: "childList", target }], this);
    });
  }
}

class Document {
  constructor() {
    this._observers = new Set();
    this.documentElement = new Element("html", this);
    this.body = new Element("body", this);
    this.documentElement.append(this.body);
  }
  createElement(tag) {
    return new Element(tag, this);
  }
  querySelector(selector) {
    if (this.documentElement.matches(selector)) return this.documentElement;
    return this.documentElement.querySelector(selector);
  }
  _mutated(target) {
    for (const observer of this._observers) observer.notify(target);
  }
}

// A clock the branches step by hand, so a 20-minute countdown costs no wall
// time and never flakes.
function createClock(startMs) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => now,
    setInterval(fn, everyMs) {
      const id = nextId++;
      timers.set(id, { fn, everyMs, next: now + everyMs });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    setTimeout(fn, afterMs) {
      const id = nextId++;
      timers.set(id, { fn, everyMs: null, next: now + afterMs });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    // Advance in due-order so a callback that clears its own timer is honoured.
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.next <= target && (due === null || timer.next < due[1].next)) {
            due = [id, timer];
          }
        }
        if (!due) break;
        const [id, timer] = due;
        now = timer.next;
        if (timer.everyMs === null) timers.delete(id);
        else timer.next = now + timer.everyMs;
        timer.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function createDomEnvironment({ hostname, startMs }) {
  const document = new Document();
  const clock = createClock(startMs);

  class FakeDate extends Date {
    static now() {
      return clock.now();
    }
  }

  return {
    document,
    clock,
    globals: {
      document,
      location: { hostname, href: `https://${hostname}/` },
      Date: FakeDate,
      MutationObserver: class extends MutationObserverImpl {
        constructor(callback) {
          super(document, callback);
        }
      },
      setInterval: (fn, ms) => clock.setInterval(fn, ms),
      clearInterval: (id) => clock.clearInterval(id),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (id) => clock.clearTimeout(id),
    },
  };
}

module.exports = { createDomEnvironment, Element, Document };
