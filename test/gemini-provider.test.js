const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let mockTabs = new Map();
let mockStorageLocal = {};

global.chrome = {
    runtime: {
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        getURL: () => ''
    },
    browserAction: {
        onClicked: { addListener: () => {} }
    },
    commands: {
        onCommand: { addListener: () => {} }
    },
    storage: {
        sync: {
            get: (keys, cb) => cb && cb({}),
            set: (keys, cb) => cb && cb({})
        },
        local: {
            get: (keys, cb) => {
                if (typeof keys === 'function') {
                    keys(mockStorageLocal);
                    return;
                }
                const res = {};
                const arr = Array.isArray(keys) ? keys : (typeof keys === 'object' && keys !== null ? Object.keys(keys) : [keys]);
                for (const k of arr) {
                    if (k in mockStorageLocal) res[k] = mockStorageLocal[k];
                }
                cb && cb(res);
            },
            set: (items, cb) => {
                Object.assign(mockStorageLocal, items);
                cb && cb();
            }
        }
    },
    tabs: {
        onRemoved: { addListener: () => {} },
        query: (queryInfo, cb) => {
            const tabs = Array.from(mockTabs.values());
            cb && cb(tabs);
            return Promise.resolve(tabs);
        },
        get: (tabId, cb) => {
            const tab = mockTabs.get(tabId) || { id: tabId, url: 'https://gemini.google.com/app' };
            cb && cb(tab);
            return Promise.resolve(tab);
        },
        sendMessage: (tabId, message, cb) => {
            const tab = mockTabs.get(tabId);
            if (tab && tab.onMessage) {
                const res = tab.onMessage(message);
                cb && cb(res);
                return Promise.resolve(res);
            }
            cb && cb({ ok: true });
            return Promise.resolve({ ok: true });
        },
        create: () => Promise.resolve({}),
        executeScript: () => Promise.resolve([])
    },
    alarms: {
        onAlarm: { addListener: () => {} },
        create: () => {},
        clear: () => {}
    },
    scripting: {
        executeScript: () => Promise.resolve([])
    }
};

const utils = require('../utils.js');
const adapterModule = require('../provider-adapter.js');
const {
    GeminiAdapter,
    ChatGPTAdapter,
    ProviderAdapter,
    getProvider,
    getProviderForUrl
} = adapterModule;
const {
    validateJobTargetConversation,
    handleStartSequence,
    handleEnqueueMessage,
    pauseJob,
    jobs
} = require('../background.js');

test('Gemini URL classification supports gemini.google.com only', () => {
    assert.equal(utils.getUrlProvider('https://gemini.google.com/app'), 'gemini');
    assert.equal(utils.getUrlProvider('https://gemini.google.com/app/abc123'), 'gemini');
    assert.equal(utils.getUrlProvider('https://gemini.google.com/u/0/app/xyz'), 'gemini');
    assert.equal(utils.isSupportedProviderUrl('https://gemini.google.com/app'), true);
    assert.equal(utils.isChatGPTUrl('https://gemini.google.com/app'), false);

    // Unrelated Google hosts remain unsupported
    assert.equal(utils.getUrlProvider('https://google.com/'), null);
    assert.equal(utils.getUrlProvider('https://mail.google.com/'), null);
    assert.equal(utils.getUrlProvider('https://aistudio.google.com/'), null);
    assert.equal(utils.getUrlProvider('https://bard.google.com/'), null);
    assert.equal(utils.isSupportedProviderUrl('https://docs.google.com/'), false);
});

test('getProviderForUrl resolves GeminiAdapter for Gemini URLs', () => {
    const adapter = getProviderForUrl('https://gemini.google.com/app/chat-1');
    assert.ok(adapter instanceof ProviderAdapter);
    assert.ok(adapter instanceof GeminiAdapter);
    assert.equal(adapter.id, 'gemini');
    assert.equal(adapter.name, 'Gemini');
    assert.equal(adapter.supportsOptimizer, false);
    assert.equal(getProviderForUrl('https://chatgpt.com/'), getProvider('chatgpt'));
    assert.ok(getProviderForUrl('https://chatgpt.com/') instanceof ChatGPTAdapter);
});

test('GeminiAdapter conversation identity classifies app routes', () => {
    const gemini = getProvider('gemini');

    assert.deepEqual(gemini.getConversationIdentity('https://gemini.google.com/app'), {
        provider: 'gemini',
        type: 'new',
        conversationId: null,
        key: 'gemini:new'
    });

    assert.deepEqual(gemini.getConversationIdentity('https://gemini.google.com/'), {
        provider: 'gemini',
        type: 'new',
        conversationId: null,
        key: 'gemini:new'
    });

    assert.deepEqual(gemini.getConversationIdentity('https://gemini.google.com/app/abc-conv-123'), {
        provider: 'gemini',
        type: 'existing',
        conversationId: 'abc-conv-123',
        key: 'gemini:c:abc-conv-123'
    });

    assert.deepEqual(gemini.getConversationIdentity('https://gemini.google.com/u/0/app/conv-xyz'), {
        provider: 'gemini',
        type: 'existing',
        conversationId: 'conv-xyz',
        key: 'gemini:c:conv-xyz'
    });

    assert.deepEqual(gemini.getConversationIdentity('https://gemini.google.com/u/1/app'), {
        provider: 'gemini',
        type: 'new',
        conversationId: null,
        key: 'gemini:new'
    });

    const unsupported = gemini.getConversationIdentity('https://gemini.google.com/share/token');
    assert.equal(unsupported.type, 'unsupported');
    assert.equal(unsupported.provider, 'gemini');
});

test('Gemini route-change mismatch pauses and keeps queued items', async () => {
    const tabId = 501;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://gemini.google.com/app/conv-aaa'
    });

    const job = {
        tabId,
        provider: 'gemini',
        conversationId: 'conv-aaa',
        conversationType: 'existing',
        targetKey: 'gemini:c:conv-aaa',
        queue: ['queued prompt A', 'queued prompt B'],
        isRunning: true,
        isPaused: false
    };

    const mismatch = await validateJobTargetConversation(tabId, {
        ...job,
        // simulate navigation by pointing tab at a different conversation
    });
    assert.equal(mismatch.ok, true);

    mockTabs.set(tabId, { id: tabId, url: 'https://gemini.google.com/app/conv-bbb' });
    const afterNav = await validateJobTargetConversation(tabId, job);
    assert.equal(afterNav.ok, false);
    assert.match(afterNav.reason, /Conversation mismatch/);
    assert.match(afterNav.reason, /conv-aaa/);
    assert.match(afterNav.reason, /conv-bbb/);
    assert.deepEqual(job.queue, ['queued prompt A', 'queued prompt B']);
});

test('Cross-provider protection blocks Gemini queue delivery on ChatGPT tab', async () => {
    const tabId = 502;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/chat-1'
    });

    const geminiJob = {
        tabId,
        provider: 'gemini',
        conversationId: 'conv-aaa',
        conversationType: 'existing',
        targetKey: 'gemini:c:conv-aaa',
        queue: ['do not cross deliver']
    };

    const result = await validateJobTargetConversation(tabId, geminiJob);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Provider mismatch/);
    assert.match(result.reason, /gemini/);
    assert.match(result.reason, /chatgpt/);
    assert.equal(geminiJob.queue.length, 1);
});

test('Gemini enqueue binds provider/tab/conversation identity', async () => {
    jobs.clear();
    const tabId = 503;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://gemini.google.com/app/bound-conv'
    });

    let enqueueResponse = null;
    handleEnqueueMessage({
        tabId,
        message: 'gemini prompt',
        source: 'test'
    }, null, (res) => { enqueueResponse = res; });

    await new Promise(r => { setTimeout(r, 10); });

    assert.ok(enqueueResponse && enqueueResponse.ok);
    const job = jobs.get(tabId);
    assert.ok(job);
    assert.equal(job.provider, 'gemini');
    assert.equal(job.conversationId, 'bound-conv');
    assert.equal(job.conversationType, 'existing');
    assert.equal(job.targetKey, 'gemini:c:bound-conv');
    assert.equal(job.queue[0] || job.currentMessage, 'gemini prompt');

    pauseJob(tabId, 'Conversation mismatch: navigated away', { phase: 'pre-send-validation', mismatch: true });
    assert.equal(job.isPaused, true);
    assert.ok((job.queue.length + (job.currentMessage ? 1 : 0)) >= 1);

    jobs.clear();
});

test('Gemini FIFO enqueue preserves order across multiple messages', async () => {
    jobs.clear();
    const tabId = 504;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://gemini.google.com/app/fifo-conv'
    });

    // Start a paused-like job by enqueueing while simulating an already-running queue
    // that will not drain (script injection returns empty).
    let startResponse = null;
    handleStartSequence({
        tabId,
        messages: ['first', 'second', 'third']
    }, (res) => { startResponse = res; });

    await new Promise(r => { setTimeout(r, 20); });

    assert.ok(startResponse && startResponse.ok);
    const job = jobs.get(tabId);
    assert.ok(job);
    assert.equal(job.provider, 'gemini');

    // After start, first message may be in-flight; remaining must stay FIFO.
    const remaining = [
        ...(job.currentMessage ? [job.currentMessage] : []),
        ...job.queue
    ];
    assert.deepEqual(remaining.slice(0, 3), ['first', 'second', 'third']);

    jobs.clear();
});

test('GeminiAdapter detects generation via stop button and keeps idle otherwise', () => {
    const gemini = getProvider('gemini');

    const idleDoc = {
        querySelector: () => null,
        querySelectorAll: () => [],
        title: 'Gemini',
        defaultView: { location: { href: 'https://gemini.google.com/app' } }
    };
    assert.equal(gemini.getGenerationState(idleDoc).generating, false);

    const stopButton = {
        disabled: false,
        getAttribute: (name) => (name === 'aria-label' ? 'Stop response' : name === 'aria-disabled' ? null : null),
        innerText: 'Stop',
        textContent: 'Stop',
        closest: () => null
    };

    const activeDoc = {
        querySelector: (sel) => (String(sel).includes('stop') || String(sel).includes('Stop') ? stopButton : null),
        querySelectorAll: (sel) => {
            if (sel === 'button' || String(sel).includes('button')) return [stopButton];
            return [];
        },
        title: 'Gemini',
        defaultView: { location: { href: 'https://gemini.google.com/app/x' } }
    };

    // Use a richer mock that getGenerationState can scan
    const buttons = [stopButton];
    const richDoc = {
        querySelectorAll: (sel) => {
            if (sel === 'button') return buttons;
            return [];
        },
        querySelector: () => null,
        title: 'Gemini',
        defaultView: { location: { href: 'https://gemini.google.com/app/x' } }
    };

    const state = gemini.getGenerationState(richDoc);
    assert.equal(state.hasActiveStopButton, true);
    assert.equal(state.generating, true);
});

test('GeminiAdapter composer text read/clear for Quill editor', () => {
    const gemini = getProvider('gemini');
    const events = [];
    global.InputEvent = class InputEvent {
        constructor(type, init = {}) {
            this.type = type;
            Object.assign(this, init);
        }
    };
    const composer = {
        tagName: 'DIV',
        classList: {
            classes: new Set(['ql-editor']),
            contains: (c) => composer.classList.classes.has(c),
            add: (c) => composer.classList.classes.add(c),
            remove: (c) => composer.classList.classes.delete(c)
        },
        getAttribute: (name) => (name === 'contenteditable' ? 'true' : null),
        innerText: 'Draft prompt',
        textContent: 'Draft prompt',
        focus() {},
        dispatchEvent(ev) { events.push(ev); }
    };

    assert.equal(gemini.getComposerText(composer), 'Draft prompt');
    gemini.clearComposer(composer);
    assert.equal(composer.textContent, '');
    assert.equal(composer.classList.contains('ql-blank'), true);
    assert.ok(events.length >= 1);
});

test('Gemini optimizer is explicitly unsupported without blocking queue registration', () => {
    const gemini = getProvider('gemini');
    assert.equal(gemini.supportsOptimizer, false);
    assert.equal(getProvider('chatgpt').supportsOptimizer, true);

    // Message discovery returns empty (unsupported) rather than ChatGPT assumptions
    assert.deepEqual(gemini.getMessageNodes({ querySelectorAll: () => [], querySelector: () => null }), []);
    assert.equal(gemini.getMainRoot({ querySelector: () => null, body: null }), null);
});

test('manifest includes Gemini host without all_urls', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
    const hosts = manifest.host_permissions || [];
    const matches = (manifest.content_scripts || []).flatMap((e) => e.matches || []);

    assert.ok(hosts.includes('https://gemini.google.com/*'));
    assert.ok(matches.includes('https://gemini.google.com/*'));
    assert.equal(hosts.includes('<all_urls>'), false);
    assert.equal(matches.includes('<all_urls>'), false);
});
