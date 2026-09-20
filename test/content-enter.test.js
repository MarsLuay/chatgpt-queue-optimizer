const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Helper to build a lightweight DOM tree for deterministic testing
function createMockDOM() {
  const listeners = {
    window: { capture: {}, bubble: {} },
    document: { capture: {}, bubble: {} }
  };

  class MockClassList {
    constructor() {
      this.classes = new Set();
    }
    add(...names) { names.forEach(n => this.classes.add(n)); }
    remove(...names) { names.forEach(n => this.classes.delete(n)); }
    contains(name) { return this.classes.has(name); }
  }

  class MockElement {
    constructor(tagName, id = '', className = '') {
      this.nodeType = 1; // Node.ELEMENT_NODE
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = className;
      this.classList = new MockClassList();
      if (className) {
        className.split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
      }
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.innerText = '';
      this.textContent = '';
      this.value = '';
      this.disabled = false;
      this.hidden = false;
      this.listeners = { capture: {}, bubble: {} };
    }

    getAttribute(name) {
      if (name === 'id') return this.id || null;
      if (name === 'class') return Array.from(this.classList.classes).join(' ') || null;
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'id') this.id = String(value);
      if (name === 'class') {
        this.classList = new MockClassList();
        String(value).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
      }
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentElement = null;
      }
      return child;
    }

    contains(node) {
      let curr = node;
      while (curr) {
        if (curr === this) return true;
        curr = curr.parentElement;
      }
      return false;
    }

    matches(selector) {
      return matchesSelector(this, selector);
    }

    closest(selector) {
      let curr = this;
      while (curr) {
        if (matchesSelector(curr, selector)) return curr;
        curr = curr.parentElement;
      }
      return null;
    }

    querySelector(selector) {
      return querySelectorAll(this, selector)[0] || null;
    }

    querySelectorAll(selector) {
      return querySelectorAll(this, selector);
    }

    addEventListener(type, fn, capture = false) {
      const phase = capture ? 'capture' : 'bubble';
      if (!this.listeners[phase][type]) this.listeners[phase][type] = [];
      this.listeners[phase][type].push(fn);
    }

    removeEventListener(type, fn, capture = false) {
      const phase = capture ? 'capture' : 'bubble';
      if (this.listeners[phase][type]) {
        this.listeners[phase][type] = this.listeners[phase][type].filter(f => f !== fn);
      }
    }

    dispatchEvent(event) {
      event.target = this;
      dispatchDOMEvent(this, event);
      return !event.defaultPrevented;
    }

    focus() {}
  }

  function matchesSingleSelector(element, sel) {
    sel = sel.trim();
    if (!sel || !element || element.nodeType !== 1) return false;

    // Id: #foo
    if (sel.startsWith('#')) {
      return element.id === sel.slice(1);
    }

    // Class: .foo
    if (sel.startsWith('.')) {
      return element.classList.contains(sel.slice(1));
    }

    // Attribute match: [attr=val], [attr^=val], [attr*=val], [attr]
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const inner = sel.slice(1, -1);
      if (inner.includes('*=')) {
        const [k, v] = inner.split('*=').map(s => s.replace(/['"]/g, '').trim());
        const attrVal = element.getAttribute(k) || '';
        return attrVal.includes(v);
      }
      if (inner.includes('^=')) {
        const [k, v] = inner.split('^=').map(s => s.replace(/['"]/g, '').trim());
        const attrVal = element.getAttribute(k) || '';
        return attrVal.startsWith(v);
      }
      if (inner.includes('=')) {
        const [k, v] = inner.split('=').map(s => s.replace(/['"]/g, '').trim());
        return element.getAttribute(k) === v;
      }
      return element.getAttribute(inner) !== null;
    }

    // Tag + attribute: e.g. button[data-testid="stop-button"]
    const tagAttrMatch = sel.match(/^([a-z0-9]+)(\[.+\])$/i);
    if (tagAttrMatch) {
      const tag = tagAttrMatch[1];
      const attr = tagAttrMatch[2];
      return element.tagName.toLowerCase() === tag.toLowerCase() && matchesSingleSelector(element, attr);
    }

    // Tag + class: e.g. svg.animate-spin
    const tagClassMatch = sel.match(/^([a-z0-9]+)\.([a-z0-9_-]+)$/i);
    if (tagClassMatch) {
      return element.tagName.toLowerCase() === tagClassMatch[1].toLowerCase() &&
        element.classList.contains(tagClassMatch[2]);
    }

    // Tag: e.g. button, textarea, article, main
    return element.tagName.toLowerCase() === sel.toLowerCase();
  }

  function matchesSelector(element, selector) {
    if (!selector) return false;
    const parts = selector.split(',').map(s => s.trim());
    return parts.some(part => {
      // Descendant selector
      if (part.includes(' ')) {
        const subParts = part.split(/\s+/);
        let curr = element;
        for (let i = subParts.length - 1; i >= 0; i--) {
          if (!curr) return false;
          if (!matchesSingleSelector(curr, subParts[i])) return false;
          if (i > 0) {
            curr = curr.parentElement;
          }
        }
        return true;
      }
      return matchesSingleSelector(element, part);
    });
  }

  function querySelectorAll(root, selector) {
    const results = [];
    function traverse(node) {
      if (!node) return;
      if (node !== root && matchesSelector(node, selector)) {
        results.push(node);
      }
      for (const child of node.children) {
        traverse(child);
      }
    }
    traverse(root);
    return results;
  }

  function dispatchDOMEvent(target, event) {
    // 1. Build propagation path from window down to target
    const path = [];
    let curr = target;
    while (curr) {
      path.unshift(curr);
      curr = curr.parentElement;
    }

    // 2. Capture phase: window -> document -> path[0] ... path[n-1]
    event.eventPhase = 1; // CAPTURING_PHASE
    for (const fn of (listeners.window.capture[event.type] || [])) {
      if (event.immediatePropagationStopped) break;
      fn(event);
    }
    if (!event.propagationStopped && !event.immediatePropagationStopped) {
      for (const fn of (listeners.document.capture[event.type] || [])) {
        if (event.immediatePropagationStopped) break;
        fn(event);
      }
    }
    for (const node of path) {
      if (event.propagationStopped || event.immediatePropagationStopped) break;
      for (const fn of (node.listeners.capture[event.type] || [])) {
        if (event.immediatePropagationStopped) break;
        fn(event);
      }
    }

    // 3. At target
    event.eventPhase = 2; // AT_TARGET
    if (!event.propagationStopped && !event.immediatePropagationStopped) {
      for (const fn of (target.listeners.bubble[event.type] || [])) {
        if (event.immediatePropagationStopped) break;
        fn(event);
      }
    }

    // 4. Bubbling phase: path[n-1] ... path[0] -> document -> window
    if (event.bubbles) {
      event.eventPhase = 3; // BUBBLING_PHASE
      for (let i = path.length - 2; i >= 0; i--) {
        if (event.propagationStopped || event.immediatePropagationStopped) break;
        for (const fn of (path[i].listeners.bubble[event.type] || [])) {
          if (event.immediatePropagationStopped) break;
          fn(event);
        }
      }
      if (!event.propagationStopped && !event.immediatePropagationStopped) {
        for (const fn of (listeners.document.bubble[event.type] || [])) {
          if (event.immediatePropagationStopped) break;
          fn(event);
        }
      }
      if (!event.propagationStopped && !event.immediatePropagationStopped) {
        for (const fn of (listeners.window.bubble[event.type] || [])) {
          if (event.immediatePropagationStopped) break;
          fn(event);
        }
      }
    }
  }

  const documentElement = new MockElement('html');
  const body = new MockElement('body');
  documentElement.appendChild(body);

  const document = {
    nodeType: 9,
    documentElement,
    body,
    title: 'ChatGPT',
    readyState: 'complete',
    createElement(tag) { return new MockElement(tag); },
    querySelector(sel) { return documentElement.querySelector(sel); },
    querySelectorAll(sel) { return documentElement.querySelectorAll(sel); },
    addEventListener(type, fn, capture = false) {
      const phase = capture ? 'capture' : 'bubble';
      if (!listeners.document[phase][type]) listeners.document[phase][type] = [];
      listeners.document[phase][type].push(fn);
    },
    removeEventListener(type, fn, capture = false) {
      const phase = capture ? 'capture' : 'bubble';
      if (listeners.document[phase][type]) {
        listeners.document[phase][type] = listeners.document[phase][type].filter(f => f !== fn);
      }
    }
  };

  const window = {
    document,
    location: { href: 'https://chatgpt.com/c/test-chat' },
    addEventListener(type, fn, capture = false) {
      const phase = capture ? 'capture' : 'bubble';
      if (!listeners.window[phase][type]) listeners.window[phase][type] = [];
      listeners.window[phase][type].push(fn);
    },
    removeEventListener(type, fn, capture = false) {
      const phase = capture ? 'capture' : 'bubble';
      if (listeners.window[phase][type]) {
        listeners.window[phase][type] = listeners.window[phase][type].filter(f => f !== fn);
      }
    },
    dispatchEvent(event) {
      event.target = window;
      for (const fn of (listeners.window.bubble[event.type] || [])) {
        fn(event);
      }
    }
  };

  class MockKeyboardEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.key = init.key || '';
      this.shiftKey = init.shiftKey || false;
      this.altKey = init.altKey || false;
      this.ctrlKey = init.ctrlKey || false;
      this.metaKey = init.metaKey || false;
      this.isComposing = init.isComposing || false;
      this.keyCode = init.keyCode || 0;
      this.defaultPrevented = init.defaultPrevented || false;
      this.propagationStopped = false;
      this.immediatePropagationStopped = false;
      this.bubbles = true;
      this.eventPhase = 0;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.propagationStopped = true; }
    stopImmediatePropagation() {
      this.propagationStopped = true;
      this.immediatePropagationStopped = true;
    }
  }

  return { window, document, MockKeyboardEvent, MockElement };
}

// Setup global environment and load utils & content
function setupTestEnv() {
  process.env.NODE_ENV = 'test';
  const dom = createMockDOM();
  global.window = dom.window;
  global.document = dom.document;
  global.location = dom.window.location;
  global.Node = { ELEMENT_NODE: 1 };
  global.InputEvent = class { constructor(type) { this.type = type; } };
  global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  };
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  const sentMessages = [];
  let enqueueResponseHandler = (msg) => ({ ok: true });

  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message.action === 'enqueueMessage') {
          const res = enqueueResponseHandler(message);
          if (cb) setTimeout(() => cb(res), 0);
        } else if (cb) {
          setTimeout(() => cb({ ok: true }), 0);
        }
      },
      onMessage: { addListener: () => {} }
    },
    storage: {
      sync: {
        get: (defs, cb) => cb ? cb(defs) : Promise.resolve(defs),
        set: (items, cb) => cb ? cb() : Promise.resolve()
      }
    }
  };

  require('../utils.js');
  require('../provider-adapter.js');
  delete require.cache[require.resolve('../content.js')];
  const { ChatGPTOptimizer } = require('../content.js');
  const optimizer = dom.window.ChatGPTOptimizerInstance || new ChatGPTOptimizer();

  return {
    dom,
    optimizer,
    sentMessages,
    setEnqueueResponse: (fn) => { enqueueResponseHandler = fn; }
  };
}

function setupGeminiTestEnv() {
  process.env.NODE_ENV = 'test';
  const dom = createMockDOM();
  dom.window.location.href = 'https://gemini.google.com/app/test-conv';
  dom.document.title = 'Gemini';
  global.window = dom.window;
  global.document = dom.document;
  global.location = dom.window.location;
  global.Node = { ELEMENT_NODE: 1 };
  global.InputEvent = class { constructor(type) { this.type = type; } };
  global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  };
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  const sentMessages = [];
  let enqueueResponseHandler = (msg) => ({ ok: true });

  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message.action === 'enqueueMessage') {
          const res = enqueueResponseHandler(message);
          if (cb) setTimeout(() => cb(res), 0);
        } else if (cb) {
          setTimeout(() => cb({ ok: true }), 0);
        }
      },
      onMessage: { addListener: () => {} }
    },
    storage: {
      sync: {
        get: (defs, cb) => cb ? cb(defs) : Promise.resolve(defs),
        set: (items, cb) => cb ? cb() : Promise.resolve()
      }
    }
  };

  delete require.cache[require.resolve('../utils.js')];
  delete require.cache[require.resolve('../provider-adapter.js')];
  delete require.cache[require.resolve('../content.js')];
  require('../utils.js');
  require('../provider-adapter.js');
  const { ChatGPTOptimizer } = require('../content.js');
  // Force a fresh instance against the Gemini location
  delete dom.window.ChatGPTOptimizerInstance;
  const optimizer = new ChatGPTOptimizer();

  return {
    dom,
    optimizer,
    sentMessages,
    setEnqueueResponse: (fn) => { enqueueResponseHandler = fn; }
  };
}

test('Enter during active streaming queues message and blocks native steer', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  // Create composer
  const composer = dom.document.createElement('div');
  composer.id = 'prompt-textarea';
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'What is gravity?';
  dom.document.body.appendChild(composer);

  // Active stop button
  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('data-testid', 'stop-button');
  stopButton.setAttribute('aria-label', 'Stop generating');
  dom.document.body.appendChild(stopButton);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  // Interception must be synchronous
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(event.propagationStopped, true);
  assert.strictEqual(event.immediatePropagationStopped, true);

  // Wait for enqueue async callback
  await new Promise(r => { setTimeout(r, 10); });

  const enqueueMsg = sentMessages.find(m => m.action === 'enqueueMessage');
  assert.ok(enqueueMsg);
  assert.strictEqual(enqueueMsg.message, 'What is gravity?');
  assert.strictEqual(enqueueMsg.source, 'composer-enter');
  assert.strictEqual(enqueueMsg.waitForIdleBeforeStart, true);

  // Composer should be cleared on success
  assert.strictEqual(composer.textContent, '');

  // Diagnostics check: bounded diagnostics present without prompt text
  const diags = optimizer.state.enterDiagnostics;
  assert.ok(diags.length > 0);
  const last = diags[diags.length - 1];
  assert.strictEqual(last.composerMatch.matched, true);
  assert.strictEqual(last.interception, true);
  assert.strictEqual(last.matchedGenerationSignals.generating, true);
  assert.strictEqual(last.matchedGenerationSignals.hasActiveStopButton, true);
  assert.strictEqual(last.enqueueResult, 'success');
  assert.strictEqual(last.nativeSubmissionObserved, false);
  // Verify NO prompt text leaked into diagnostics
  assert.strictEqual(last.text, undefined);
  assert.strictEqual(last.prompt, undefined);
  assert.strictEqual(last.textLength, 'What is gravity?'.length);
});

test('Enter during active non-streaming work (reasoning/thinking) queues message', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('div');
  composer.id = 'prompt-textarea';
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'Calculate pi';
  dom.document.body.appendChild(composer);

  // Active thinking status without legacy stop button or streaming marker
  const thinkingNode = dom.document.createElement('div');
  thinkingNode.setAttribute('data-testid', 'thinking-state');
  thinkingNode.setAttribute('role', 'status');
  thinkingNode.innerText = 'Thinking...';
  dom.document.body.appendChild(thinkingNode);

  const state = optimizer.getGenerationState();
  assert.strictEqual(state.generating, true);
  assert.strictEqual(state.hasActiveToolOrResearch, true);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(event.propagationStopped, true);

  await new Promise(r => { setTimeout(r, 10); });

  const enqueueMsg = sentMessages.find(m => m.action === 'enqueueMessage');
  assert.ok(enqueueMsg);
  assert.strictEqual(enqueueMsg.message, 'Calculate pi');

  const lastDiag = optimizer.state.enterDiagnostics[optimizer.state.enterDiagnostics.length - 1];
  assert.strictEqual(lastDiag.matchedGenerationSignals.hasActiveToolOrResearch, true);
  assert.strictEqual(lastDiag.interception, true);
});

test('Enter during active non-streaming work (tool/research progress) queues message', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('div');
  composer.id = 'prompt-textarea';
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'Deep dive report';
  dom.document.body.appendChild(composer);

  // Live region with research marker
  const liveStatus = dom.document.createElement('div');
  liveStatus.setAttribute('aria-live', 'polite');
  liveStatus.innerText = 'Deep research in progress: Searching sources';
  dom.document.body.appendChild(liveStatus);

  const state = optimizer.getGenerationState();
  assert.strictEqual(state.generating, true);
  assert.strictEqual(state.deepResearchActive, true);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(event.propagationStopped, true);

  await new Promise(r => { setTimeout(r, 10); });

  const enqueueMsg = sentMessages.find(m => m.action === 'enqueueMessage');
  assert.ok(enqueueMsg);
  assert.strictEqual(enqueueMsg.message, 'Deep dive report');
});

test('Idle Enter remains native and is not queued', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('textarea');
  composer.id = 'prompt-textarea';
  composer.value = 'Hello while idle';
  dom.document.body.appendChild(composer);

  // No generating elements exist
  const state = optimizer.getGenerationState();
  assert.strictEqual(state.generating, false);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  // Must NOT be intercepted
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(event.propagationStopped, false);

  await new Promise(r => { setTimeout(r, 10); });

  const enqueueMsg = sentMessages.find(m => m.action === 'enqueueMessage');
  assert.strictEqual(enqueueMsg, undefined);

  // Diagnostic recorded with interception = false
  const lastDiag = optimizer.state.enterDiagnostics[optimizer.state.enterDiagnostics.length - 1];
  assert.strictEqual(lastDiag.interception, false);
  assert.strictEqual(lastDiag.matchedGenerationSignals.generating, false);

  // Trigger form submit to simulate native submission
  const form = dom.document.createElement('form');
  dom.document.body.appendChild(form);
  const submitEvent = new dom.MockKeyboardEvent('submit');
  form.dispatchEvent(submitEvent);

  assert.strictEqual(lastDiag.nativeSubmissionObserved, true);
});

test('Shift+Enter, modified Enter, and IME composition remain native', () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('textarea');
  composer.id = 'prompt-textarea';
  composer.value = 'Test text';
  dom.document.body.appendChild(composer);

  // Generating is true
  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('data-testid', 'stop-button');
  dom.document.body.appendChild(stopButton);

  // 1. Shift+Enter
  const shiftEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
  composer.dispatchEvent(shiftEvent);
  assert.strictEqual(shiftEvent.defaultPrevented, false);
  assert.strictEqual(shiftEvent.propagationStopped, false);

  // 2. Ctrl+Enter
  const ctrlEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', ctrlKey: true });
  composer.dispatchEvent(ctrlEvent);
  assert.strictEqual(ctrlEvent.defaultPrevented, false);

  // 3. Alt+Enter
  const altEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', altKey: true });
  composer.dispatchEvent(altEvent);
  assert.strictEqual(altEvent.defaultPrevented, false);

  // 4. Meta+Enter
  const metaEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', metaKey: true });
  composer.dispatchEvent(metaEvent);
  assert.strictEqual(metaEvent.defaultPrevented, false);

  // 5. IME composition
  const imeEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', isComposing: true });
  composer.dispatchEvent(imeEvent);
  assert.strictEqual(imeEvent.defaultPrevented, false);

  // 6. IME keyCode 229
  const ime229 = new dom.MockKeyboardEvent('keydown', { key: 'Enter', keyCode: 229 });
  composer.dispatchEvent(ime229);
  assert.strictEqual(ime229.defaultPrevented, false);

  assert.strictEqual(sentMessages.filter(m => m.action === 'enqueueMessage').length, 0);
});

test('Non-composer Enter and #cpo-root Enter remain unaffected', () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('data-testid', 'stop-button');
  dom.document.body.appendChild(stopButton);

  // Normal input outside composer
  const otherInput = dom.document.createElement('input');
  otherInput.value = 'Search term';
  dom.document.body.appendChild(otherInput);

  const event1 = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  otherInput.dispatchEvent(event1);
  assert.strictEqual(event1.defaultPrevented, false);

  // Input inside extension UI #cpo-root
  const cpoRoot = dom.document.createElement('div');
  cpoRoot.id = 'cpo-root';
  const cpoInput = dom.document.createElement('textarea');
  cpoRoot.appendChild(cpoInput);
  dom.document.body.appendChild(cpoRoot);

  const event2 = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  cpoInput.dispatchEvent(event2);
  assert.strictEqual(event2.defaultPrevented, false);

  assert.strictEqual(sentMessages.filter(m => m.action === 'enqueueMessage').length, 0);
});

test('Enqueue failure keeps typed composer text recoverable and stops keypress leak', async () => {
  const { dom, optimizer, setEnqueueResponse } = setupTestEnv();

  const composer = dom.document.createElement('div');
  composer.id = 'prompt-textarea';
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'Unsaved draft prompt';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('data-testid', 'stop-button');
  dom.document.body.appendChild(stopButton);

  // Simulate background failure
  setEnqueueResponse(() => ({ ok: false, error: 'Background tab disconnected' }));

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  // Intercepted synchronously so keypress never reaches native steer
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(event.propagationStopped, true);

  await new Promise(r => { setTimeout(r, 10); });

  // Composer text must NOT be cleared on failure
  assert.strictEqual(composer.innerText, 'Unsaved draft prompt');

  const lastDiag = optimizer.state.enterDiagnostics[optimizer.state.enterDiagnostics.length - 1];
  assert.strictEqual(lastDiag.interception, true);
  assert.ok(lastDiag.enqueueResult.startsWith('error:'));
});

test('Successful enqueue keeps a composer draft that changed before the queue ACK', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('div');
  composer.id = 'prompt-textarea';
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'Original queued prompt';
  composer.textContent = 'Original queued prompt';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('data-testid', 'stop-button');
  dom.document.body.appendChild(stopButton);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  composer.innerText = 'Newer user draft';
  composer.textContent = 'Newer user draft';

  await new Promise(r => setTimeout(r, 10));

  const enqueueMsg = sentMessages.find(m => m.action === 'enqueueMessage');
  assert.ok(enqueueMsg);
  assert.strictEqual(enqueueMsg.message, 'Original queued prompt');
  assert.strictEqual(composer.innerText, 'Newer user draft');
  assert.strictEqual(composer.textContent, 'Newer user draft');

  const lastDiag = optimizer.state.enterDiagnostics[optimizer.state.enterDiagnostics.length - 1];
  assert.strictEqual(lastDiag.enqueueResult, 'success');
  assert.strictEqual(lastDiag.composerDraftPreserved, true);
});

test('Rapid duplicate Enter is protected by in-flight and debounce rules', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('textarea');
  composer.id = 'prompt-textarea';
  composer.value = 'Rapid Enter test';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('data-testid', 'stop-button');
  dom.document.body.appendChild(stopButton);

  // 1st Enter
  const event1 = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event1);
  assert.strictEqual(event1.defaultPrevented, true);
  assert.strictEqual(sentMessages.filter(m => m.action === 'enqueueMessage').length, 1);

  // 2nd Enter while 1st is still in-flight
  const event2 = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event2);
  // 2nd Enter must ALSO be blocked from native steer
  assert.strictEqual(event2.defaultPrevented, true);
  assert.strictEqual(event2.propagationStopped, true);
  // But NOT sent to background again
  assert.strictEqual(sentMessages.filter(m => m.action === 'enqueueMessage').length, 1);

  const diags = optimizer.state.enterDiagnostics;
  assert.strictEqual(diags[diags.length - 1].enqueueResult, 'suppressed-inflight');

  // Let 1st finish
  await new Promise(r => { setTimeout(r, 10); });

  // Put text back to simulate immediate second press within debounce window
  composer.value = 'Rapid Enter test';
  const event3 = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event3);
  assert.strictEqual(event3.defaultPrevented, true);
  assert.strictEqual(sentMessages.filter(m => m.action === 'enqueueMessage').length, 1);
  assert.strictEqual(diags[diags.length - 1].enqueueResult, 'suppressed-duplicate');
});

test('Default-prevented ownership behavior owns Enter in real composer during active work', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('div');
  composer.id = 'prompt-textarea';
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'Command with default prevented';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('data-testid', 'stop-button');
  dom.document.body.appendChild(stopButton);

  // Event already has defaultPrevented: true (e.g. from editor suppressing newline)
  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter', defaultPrevented: true });
  composer.dispatchEvent(event);

  // Extension still takes ownership and stops propagation
  assert.strictEqual(event.propagationStopped, true);
  assert.strictEqual(event.immediatePropagationStopped, true);

  await new Promise(r => { setTimeout(r, 10); });

  const enqueueMsgs = sentMessages.filter(m => m.action === 'enqueueMessage');
  assert.strictEqual(enqueueMsgs.length, 1);
  assert.strictEqual(enqueueMsgs[0].message, 'Command with default prevented');

  const lastDiag = optimizer.state.enterDiagnostics[optimizer.state.enterDiagnostics.length - 1];
  assert.strictEqual(lastDiag.defaultPrevented, true);
  assert.strictEqual(lastDiag.interception, true);
  assert.strictEqual(lastDiag.enqueueResult, 'success');
});

test('DEBUG_MESSAGES reports canonical signal diagnostics without message text', async () => {
  const { dom, optimizer } = setupTestEnv();
  await new Promise(resolve => { setTimeout(resolve, 20); });
  optimizer.config.enabled = false;
  const composer = dom.document.createElement('div');
  composer.setAttribute('data-testid', 'prompt-textarea');
  composer.setAttribute('contenteditable', 'true');
  const turn = dom.document.createElement('article');
  turn.setAttribute('data-testid', 'conversation-turn-1');
  turn.textContent = 'private prompt text must stay out of diagnostics';
  turn.innerText = turn.textContent;
  dom.document.body.appendChild(composer);
  dom.document.body.appendChild(turn);

  let response = null;
  optimizer.handleMessage({ type: 'DEBUG_MESSAGES' }, null, (value) => {
    response = value;
  });

  assert.equal(response.count, 1);
  assert.equal(response.diagnostics.messages.selector, '[data-testid^="conversation-turn"]');
  assert.equal(response.diagnostics.composer.selector, '[data-testid="prompt-textarea"]');
  assert.equal(JSON.stringify(response).includes('private prompt text'), false);
});

test('Historical page text does not create false active states', () => {
  const { dom, optimizer } = setupTestEnv();

  // Completed turn in history mentioning research keywords
  const oldTurn = dom.document.createElement('div');
  oldTurn.setAttribute('data-testid', 'conversation-turn-3');
  oldTurn.innerText = 'In our earlier turn, deep research and searching the web was performed.';
  dom.document.body.appendChild(oldTurn);

  // No active stop button, no streaming, no active status
  const state = optimizer.getGenerationState();
  assert.strictEqual(state.generating, false);
  assert.strictEqual(state.hasActiveToolOrResearch, false);
});

test('Disabled or stale stop buttons do not create false active states', () => {
  const { dom, optimizer } = setupTestEnv();

  const staleButton = dom.document.createElement('button');
  staleButton.setAttribute('data-testid', 'stop-button');
  staleButton.disabled = true;
  dom.document.body.appendChild(staleButton);

  const state = optimizer.getGenerationState();
  assert.strictEqual(state.generating, false);
  assert.strictEqual(state.hasActiveStopButton, false);
});

test('Active error state suppresses generating state', () => {
  const { dom, optimizer } = setupTestEnv();

  // Error alert
  const alert = dom.document.createElement('div');
  alert.setAttribute('role', 'alert');
  alert.innerText = 'Something went wrong generating the response.';
  dom.document.body.appendChild(alert);

  const state = optimizer.getGenerationState();
  assert.strictEqual(state.hasError, true);
  assert.strictEqual(state.generating, false);
});

test('Generation-end race: Enter right after generation ended remains native', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('textarea');
  composer.id = 'prompt-textarea';
  composer.value = 'Followup prompt';
  dom.document.body.appendChild(composer);

  // Generation has finished (idle)
  const state = optimizer.getGenerationState();
  assert.strictEqual(state.generating, false);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(sentMessages.filter(m => m.action === 'enqueueMessage').length, 0);

  const lastDiag = optimizer.state.enterDiagnostics[optimizer.state.enterDiagnostics.length - 1];
  assert.strictEqual(lastDiag.interception, false);
  assert.strictEqual(lastDiag.matchedGenerationSignals.generating, false);
});

test('Generation-end race: Enter right before generation ended is queued with waitForIdleBeforeStart', async () => {
  const { dom, optimizer, sentMessages } = setupTestEnv();

  const composer = dom.document.createElement('textarea');
  composer.id = 'prompt-textarea';
  composer.value = 'Queued before completion';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('data-testid', 'stop-button');
  dom.document.body.appendChild(stopButton);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  // Synchronously intercepted
  assert.strictEqual(event.defaultPrevented, true);

  await new Promise(r => { setTimeout(r, 10); });

  const enqueueMsgs = sentMessages.filter(m => m.action === 'enqueueMessage');
  assert.strictEqual(enqueueMsgs.length, 1);
  assert.strictEqual(enqueueMsgs[0].waitForIdleBeforeStart, true);
  assert.strictEqual(enqueueMsgs[0].message, 'Queued before completion');
});

test('Gemini: Enter during active generation queues and clears composer only after success', async () => {
  const { dom, optimizer, sentMessages } = setupGeminiTestEnv();

  assert.equal(optimizer.provider?.id, 'gemini');
  assert.equal(optimizer.provider?.supportsOptimizer, false);

  const composer = dom.document.createElement('div');
  composer.setAttribute('class', 'ql-editor');
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'Gemini queued prompt';
  composer.textContent = 'Gemini queued prompt';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('aria-label', 'Stop response');
  dom.document.body.appendChild(stopButton);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(event.propagationStopped, true);

  await new Promise(r => { setTimeout(r, 10); });

  const enqueueMsg = sentMessages.find(m => m.action === 'enqueueMessage');
  assert.ok(enqueueMsg);
  assert.strictEqual(enqueueMsg.message, 'Gemini queued prompt');
  assert.strictEqual(enqueueMsg.waitForIdleBeforeStart, true);
  assert.equal(enqueueMsg.conversationIdentity?.provider, 'gemini');
  assert.equal(composer.textContent, '');
});

test('Gemini: idle Enter, Shift+Enter, and IME remain native', () => {
  const { dom, sentMessages } = setupGeminiTestEnv();

  const composer = dom.document.createElement('div');
  composer.setAttribute('class', 'ql-editor');
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'Idle gemini text';
  composer.textContent = 'Idle gemini text';
  dom.document.body.appendChild(composer);

  const idleEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(idleEvent);
  assert.strictEqual(idleEvent.defaultPrevented, false);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('aria-label', 'Stop response');
  dom.document.body.appendChild(stopButton);

  const shiftEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
  composer.dispatchEvent(shiftEvent);
  assert.strictEqual(shiftEvent.defaultPrevented, false);

  const imeEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', isComposing: true });
  composer.dispatchEvent(imeEvent);
  assert.strictEqual(imeEvent.defaultPrevented, false);

  assert.strictEqual(sentMessages.filter(m => m.action === 'enqueueMessage').length, 0);
});

test('Gemini: enqueue failure retains composer text', async () => {
  const { dom, setEnqueueResponse } = setupGeminiTestEnv();

  const composer = dom.document.createElement('div');
  composer.setAttribute('class', 'ql-editor');
  composer.setAttribute('contenteditable', 'true');
  composer.innerText = 'Keep this draft';
  composer.textContent = 'Keep this draft';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('aria-label', 'Stop response');
  dom.document.body.appendChild(stopButton);

  setEnqueueResponse(() => ({ ok: false, error: 'Gemini tab disconnected' }));

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);
  assert.strictEqual(event.defaultPrevented, true);

  await new Promise(r => { setTimeout(r, 10); });

  assert.strictEqual(composer.textContent, 'Keep this draft');
});
function setupClaudeTestEnv() {
  process.env.NODE_ENV = 'test';
  const dom = createMockDOM();
  dom.window.location.href = 'https://claude.ai/chat/test-conv';
  dom.document.title = 'Claude';
  global.window = dom.window;
  global.document = dom.document;
  global.location = dom.window.location;
  global.Node = { ELEMENT_NODE: 1 };
  global.InputEvent = class { constructor(type) { this.type = type; } };
  global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  };
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  const sentMessages = [];
  let enqueueResponseHandler = (msg) => ({ ok: true });

  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message.action === 'enqueueMessage') {
          const res = enqueueResponseHandler(message);
          if (cb) setTimeout(() => cb(res), 0);
        } else if (cb) {
          setTimeout(() => cb({ ok: true }), 0);
        }
      },
      onMessage: { addListener: () => {} }
    },
    storage: {
      sync: {
        get: (defs, cb) => cb ? cb(defs) : Promise.resolve(defs),
        set: (items, cb) => cb ? cb() : Promise.resolve()
      }
    }
  };

  delete require.cache[require.resolve('../utils.js')];
  delete require.cache[require.resolve('../provider-adapter.js')];
  delete require.cache[require.resolve('../content.js')];
  require('../utils.js');
  require('../provider-adapter.js');
  const { ChatGPTOptimizer } = require('../content.js');
  delete dom.window.ChatGPTOptimizerInstance;
  const optimizer = new ChatGPTOptimizer();

  return {
    dom,
    optimizer,
    sentMessages,
    setEnqueueResponse: (fn) => { enqueueResponseHandler = fn; }
  };
}

test('Claude: Enter during active generation queues and clears composer only after success', async () => {
  const { dom, optimizer, sentMessages } = setupClaudeTestEnv();

  assert.equal(optimizer.provider?.id, 'claude');
  assert.equal(optimizer.provider?.supportsOptimizer, false);

  const composer = dom.document.createElement('div');
  composer.setAttribute('class', 'ProseMirror');
  composer.setAttribute('contenteditable', 'true');
  composer.setAttribute('data-testid', 'chat-input');
  composer.innerText = 'Claude queued prompt';
  composer.textContent = 'Claude queued prompt';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('aria-label', 'Stop generating');
  dom.document.body.appendChild(stopButton);

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);

  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(event.propagationStopped, true);

  await new Promise(r => { setTimeout(r, 10); });

  const enqueueMsg = sentMessages.find(m => m.action === 'enqueueMessage');
  assert.ok(enqueueMsg);
  assert.strictEqual(enqueueMsg.message, 'Claude queued prompt');
  assert.strictEqual(enqueueMsg.waitForIdleBeforeStart, true);
  assert.equal(enqueueMsg.conversationIdentity?.provider, 'claude');
  assert.equal(composer.textContent, '');
});

test('Claude: idle Enter, Shift+Enter, and IME remain native', () => {
  const { dom, sentMessages } = setupClaudeTestEnv();

  const composer = dom.document.createElement('div');
  composer.setAttribute('class', 'ProseMirror');
  composer.setAttribute('contenteditable', 'true');
  composer.setAttribute('data-testid', 'chat-input');
  composer.innerText = 'Idle claude text';
  composer.textContent = 'Idle claude text';
  dom.document.body.appendChild(composer);

  const idleEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(idleEvent);
  assert.strictEqual(idleEvent.defaultPrevented, false);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('aria-label', 'Stop generating');
  dom.document.body.appendChild(stopButton);

  const shiftEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
  composer.dispatchEvent(shiftEvent);
  assert.strictEqual(shiftEvent.defaultPrevented, false);

  const imeEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', isComposing: true });
  composer.dispatchEvent(imeEvent);
  assert.strictEqual(imeEvent.defaultPrevented, false);

  const metaEvent = new dom.MockKeyboardEvent('keydown', { key: 'Enter', metaKey: true });
  composer.dispatchEvent(metaEvent);
  assert.strictEqual(metaEvent.defaultPrevented, false);

  assert.strictEqual(sentMessages.filter(m => m.action === 'enqueueMessage').length, 0);
});

test('Claude: enqueue failure retains composer text', async () => {
  const { dom, setEnqueueResponse } = setupClaudeTestEnv();

  const composer = dom.document.createElement('div');
  composer.setAttribute('class', 'ProseMirror');
  composer.setAttribute('contenteditable', 'true');
  composer.setAttribute('data-testid', 'chat-input');
  composer.innerText = 'Keep this draft';
  composer.textContent = 'Keep this draft';
  dom.document.body.appendChild(composer);

  const stopButton = dom.document.createElement('button');
  stopButton.setAttribute('aria-label', 'Stop generating');
  dom.document.body.appendChild(stopButton);

  setEnqueueResponse(() => ({ ok: false, error: 'Claude tab disconnected' }));

  const event = new dom.MockKeyboardEvent('keydown', { key: 'Enter' });
  composer.dispatchEvent(event);
  assert.strictEqual(event.defaultPrevented, true);

  await new Promise(r => { setTimeout(r, 10); });

  assert.strictEqual(composer.textContent, 'Keep this draft');
});
