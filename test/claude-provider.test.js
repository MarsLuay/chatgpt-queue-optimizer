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
            const tab = mockTabs.get(tabId) || { id: tabId, url: 'https://claude.ai/new' };
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
    ClaudeAdapter,
    ChatGPTAdapter,
    GeminiAdapter,
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

test('Claude URL classification supports claude.ai only', () => {
    assert.equal(utils.getUrlProvider('https://claude.ai/new'), 'claude');
    assert.equal(utils.getUrlProvider('https://claude.ai/chat/abc-123'), 'claude');
    assert.equal(utils.getUrlProvider('https://claude.ai/'), 'claude');
    assert.equal(utils.isSupportedProviderUrl('https://claude.ai/new'), true);
    assert.equal(utils.isChatGPTUrl('https://claude.ai/new'), false);
    assert.equal(utils.isClaudeUrl('https://claude.ai/new'), true);
    assert.equal(utils.isClaudeUrl('https://chatgpt.com/'), false);

    // Unrelated Anthropic/Claude hosts remain unsupported
    assert.equal(utils.getUrlProvider('https://console.anthropic.com/'), null);
    assert.equal(utils.getUrlProvider('https://www.anthropic.com/'), null);
    assert.equal(utils.isSupportedProviderUrl('https://docs.anthropic.com/'), false);
});

test('getProviderForUrl resolves ClaudeAdapter for Claude URLs', () => {
    const adapter = getProviderForUrl('https://claude.ai/chat/chat-1');
    assert.ok(adapter instanceof ProviderAdapter);
    assert.ok(adapter instanceof ClaudeAdapter);
    assert.equal(adapter.id, 'claude');
    assert.equal(adapter.name, 'Claude');
    assert.equal(adapter.supportsOptimizer, false);
    assert.equal(getProviderForUrl('https://chatgpt.com/'), getProvider('chatgpt'));
    assert.ok(getProviderForUrl('https://chatgpt.com/') instanceof ChatGPTAdapter);
    assert.ok(getProviderForUrl('https://gemini.google.com/app') instanceof GeminiAdapter);
});

test('ClaudeAdapter conversation identity classifies chat routes', () => {
    const claude = getProvider('claude');

    assert.deepEqual(claude.getConversationIdentity('https://claude.ai/new'), {
        provider: 'claude',
        type: 'new',
        conversationId: null,
        key: 'claude:new'
    });

    assert.deepEqual(claude.getConversationIdentity('https://claude.ai/'), {
        provider: 'claude',
        type: 'new',
        conversationId: null,
        key: 'claude:new'
    });

    assert.deepEqual(claude.getConversationIdentity('https://claude.ai/chat/abc-conv-123'), {
        provider: 'claude',
        type: 'existing',
        conversationId: 'abc-conv-123',
        key: 'claude:c:abc-conv-123'
    });

    assert.deepEqual(claude.getConversationIdentity('https://claude.ai/chat/90000000-0000-0000-0000-000000000009'), {
        provider: 'claude',
        type: 'existing',
        conversationId: '90000000-0000-0000-0000-000000000009',
        key: 'claude:c:90000000-0000-0000-0000-000000000009'
    });

    const unsupported = claude.getConversationIdentity('https://claude.ai/share/token');
    assert.equal(unsupported.type, 'unsupported');
    assert.equal(unsupported.provider, 'claude');

    const recents = claude.getConversationIdentity('https://claude.ai/recents');
    assert.equal(recents.type, 'unsupported');
});

test('Claude route-change mismatch pauses and keeps queued items', async () => {
    const tabId = 601;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://claude.ai/chat/conv-aaa'
    });

    const job = {
        tabId,
        provider: 'claude',
        conversationId: 'conv-aaa',
        conversationType: 'existing',
        targetKey: 'claude:c:conv-aaa',
        queue: ['queued prompt A', 'queued prompt B'],
        isRunning: true,
        isPaused: false
    };

    const mismatch = await validateJobTargetConversation(tabId, {
        ...job
    });
    assert.equal(mismatch.ok, true);

    mockTabs.set(tabId, { id: tabId, url: 'https://claude.ai/chat/conv-bbb' });
    const afterNav = await validateJobTargetConversation(tabId, job);
    assert.equal(afterNav.ok, false);
    assert.match(afterNav.reason, /Conversation mismatch/);
    assert.match(afterNav.reason, /conv-aaa/);
    assert.match(afterNav.reason, /conv-bbb/);
    assert.deepEqual(job.queue, ['queued prompt A', 'queued prompt B']);
});

test('Cross-provider protection blocks Claude queue delivery on ChatGPT tab', async () => {
    const tabId = 602;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/chat-1'
    });

    const claudeJob = {
        tabId,
        provider: 'claude',
        conversationId: 'conv-aaa',
        conversationType: 'existing',
        targetKey: 'claude:c:conv-aaa',
        queue: ['do not cross deliver']
    };

    const result = await validateJobTargetConversation(tabId, claudeJob);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Provider mismatch/);
    assert.match(result.reason, /claude/);
    assert.match(result.reason, /chatgpt/);
    assert.equal(claudeJob.queue.length, 1);
});

test('Cross-provider protection blocks Claude queue delivery on Gemini tab', async () => {
    const tabId = 605;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://gemini.google.com/app/conv-x'
    });

    const claudeJob = {
        tabId,
        provider: 'claude',
        conversationId: 'conv-aaa',
        conversationType: 'existing',
        targetKey: 'claude:c:conv-aaa',
        queue: ['do not cross deliver to gemini']
    };

    const result = await validateJobTargetConversation(tabId, claudeJob);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Provider mismatch/);
    assert.match(result.reason, /claude/);
    assert.match(result.reason, /gemini/);
    assert.equal(claudeJob.queue.length, 1);
});

test('Claude enqueue binds provider/tab/conversation identity', async () => {
    jobs.clear();
    const tabId = 603;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://claude.ai/chat/bound-conv'
    });

    let enqueueResponse = null;
    handleEnqueueMessage({
        tabId,
        message: 'claude prompt',
        source: 'test'
    }, null, (res) => { enqueueResponse = res; });

    await new Promise(r => { setTimeout(r, 10); });

    assert.ok(enqueueResponse && enqueueResponse.ok);
    const job = jobs.get(tabId);
    assert.ok(job);
    assert.equal(job.provider, 'claude');
    assert.equal(job.conversationId, 'bound-conv');
    assert.equal(job.conversationType, 'existing');
    assert.equal(job.targetKey, 'claude:c:bound-conv');
    assert.equal(job.queue[0] || job.currentMessage, 'claude prompt');

    pauseJob(tabId, 'Conversation mismatch: navigated away', { phase: 'pre-send-validation', mismatch: true });
    assert.equal(job.isPaused, true);
    assert.ok((job.queue.length + (job.currentMessage ? 1 : 0)) >= 1);

    jobs.clear();
});

test('Claude FIFO enqueue preserves order across multiple messages', async () => {
    jobs.clear();
    const tabId = 604;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://claude.ai/chat/fifo-conv'
    });

    let startResponse = null;
    handleStartSequence({
        tabId,
        messages: ['first', 'second', 'third']
    }, (res) => { startResponse = res; });

    await new Promise(r => { setTimeout(r, 20); });

    assert.ok(startResponse && startResponse.ok);
    const job = jobs.get(tabId);
    assert.ok(job);
    assert.equal(job.provider, 'claude');

    const remaining = [
        ...(job.currentMessage ? [job.currentMessage] : []),
        ...job.queue
    ];
    assert.deepEqual(remaining.slice(0, 3), ['first', 'second', 'third']);

    jobs.clear();
});

test('ClaudeAdapter detects generation via stop button and keeps idle otherwise', () => {
    const claude = getProvider('claude');

    const idleDoc = {
        querySelector: () => null,
        querySelectorAll: () => [],
        title: 'Claude',
        defaultView: { location: { href: 'https://claude.ai/new' } }
    };
    assert.equal(claude.getGenerationState(idleDoc).generating, false);

    const stopButton = {
        disabled: false,
        getAttribute: (name) => (name === 'aria-label' ? 'Stop generating' : name === 'aria-disabled' ? null : null),
        innerText: 'Stop',
        textContent: 'Stop',
        closest: () => null
    };

    const buttons = [stopButton];
    const richDoc = {
        querySelectorAll: (sel) => {
            if (sel === 'button') return buttons;
            return [];
        },
        querySelector: () => null,
        title: 'Claude',
        defaultView: { location: { href: 'https://claude.ai/chat/x' } }
    };

    const state = claude.getGenerationState(richDoc);
    assert.equal(state.hasActiveStopButton, true);
    assert.equal(state.generating, true);
});

test('ClaudeAdapter composer text read/clear for ProseMirror editor', () => {
    const claude = getProvider('claude');
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
            classes: new Set(['ProseMirror']),
            contains: (c) => composer.classList.classes.has(c),
            add: (c) => composer.classList.classes.add(c),
            remove: (c) => composer.classList.classes.delete(c)
        },
        getAttribute: (name) => (name === 'contenteditable' ? 'true' : name === 'data-testid' ? 'chat-input' : null),
        innerText: 'Draft prompt',
        textContent: 'Draft prompt',
        focus() {},
        dispatchEvent(ev) { events.push(ev); }
    };

    assert.equal(claude.getComposerText(composer), 'Draft prompt');
    claude.clearComposer(composer);
    assert.equal(composer.textContent, '');
    assert.ok(events.length >= 1);
});

test('Claude missing controls preserve queued work with provider error signal', async () => {
    jobs.clear();
    const tabId = 606;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://claude.ai/chat/missing-controls'
    });

    // Script injection returns empty (no composer/send controls found).
    chrome.scripting.executeScript = async () => [{ result: {
        ok: false,
        error: 'Claude input box was not found.',
        details: { provider: 'Claude' }
    } }];

    let startResponse = null;
    handleStartSequence({
        tabId,
        messages: ['must stay queued']
    }, (res) => { startResponse = res; });

    await new Promise(r => { setTimeout(r, 30); });

    assert.ok(startResponse && startResponse.ok);
    const job = jobs.get(tabId);
    assert.ok(job);
    assert.equal(job.provider, 'claude');
    const remaining = [
        ...(job.currentMessage ? [job.currentMessage] : []),
        ...job.queue
    ];
    assert.ok(remaining.includes('must stay queued'));

    jobs.clear();
});

test('Claude optimizer is explicitly unsupported without blocking queue registration', () => {
    const claude = getProvider('claude');
    assert.equal(claude.supportsOptimizer, false);
    assert.equal(getProvider('chatgpt').supportsOptimizer, true);
    assert.equal(getProvider('gemini').supportsOptimizer, false);

    assert.deepEqual(claude.getMessageNodes({ querySelectorAll: () => [], querySelector: () => null }), []);
    assert.equal(claude.getMainRoot({ querySelector: () => null, body: null }), null);
});

test('manifest includes Claude host without all_urls', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
    const hosts = manifest.host_permissions || [];
    const matches = (manifest.content_scripts || []).flatMap((e) => e.matches || []);

    assert.ok(hosts.includes('https://claude.ai/*'));
    assert.ok(matches.includes('https://claude.ai/*'));
    assert.equal(hosts.includes('<all_urls>'), false);
    assert.equal(matches.includes('<all_urls>'), false);
});
