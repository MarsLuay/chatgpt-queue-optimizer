const test = require('node:test');
const assert = require('node:assert/strict');

// Set up minimal chrome API mock for background.js require
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
            const tab = mockTabs.get(tabId) || { id: tabId, url: 'https://chatgpt.com/' };
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
const { ChatGPTAdapter, ProviderAdapter, getProvider, getProviderForUrl } = adapterModule;
const {
    validateJobTargetConversation,
    resolveTabConversationIdentity,
    restoreDurableJobs,
    getDurableJobsState,
    getRunningJobsSnapshot,
    handleStartSequence,
    handleEnqueueMessage,
    pauseJob,
    recoverFromDeliveryTimeout,
    refreshChatGPTTab,
    waitForTabToRecover,
    waitForTabResponse,
    QUEUE_SETTINGS_DEFAULTS,
    jobs
} = require('../background.js');

test('ProviderAdapter base class defines expected contract and safe fallback defaults', () => {
    const base = new ProviderAdapter({ id: 'test-base', name: 'Test' });
    assert.equal(base.id, 'test-base');
    assert.equal(base.name, 'Test');
    assert.equal(base.isSupportedUrl('https://example.com'), false);
    assert.deepEqual(base.getConversationIdentity('https://example.com'), {
        provider: 'test-base',
        type: 'unsupported',
        conversationId: null,
        key: 'test-base:unsupported'
    });
    assert.equal(base.getComposerFromEventTarget(null), null);
    assert.equal(base.getComposerText(null), '');
    assert.equal(base.clearComposer(null), undefined);
    assert.equal(base.getGenerationState().generating, false);
    assert.equal(base.getGenerationState().hasDeliveryTimedOut, false);
    assert.equal(base.getRetryButton(null), null);
    assert.equal(base.clickRetryButton(null), false);
    assert.equal(base.getLastAssistantTurn(null), null);
    assert.equal(base.isValidMessageNode(null), false);
    assert.equal(base.isValidFallbackNode(null), false);
});

test('ChatGPTAdapter implements ProviderAdapter with complete selectors and methods', () => {
    const chatgpt = getProvider('chatgpt');
    assert.ok(chatgpt instanceof ProviderAdapter);
    assert.ok(chatgpt instanceof ChatGPTAdapter);
    assert.equal(chatgpt.id, 'chatgpt');
    assert.equal(chatgpt.name, 'ChatGPT');
    assert.equal(typeof chatgpt.getRetryButton, 'function');
    assert.equal(typeof chatgpt.clickRetryButton, 'function');
    assert.equal(typeof chatgpt.getLastAssistantTurn, 'function');

    // Selector sanity check
    const selectors = chatgpt.selectors;
    assert.ok(Array.isArray(selectors.composer) && selectors.composer.length > 0);
    assert.ok(Array.isArray(selectors.sendButton) && selectors.sendButton.length > 0);
    assert.ok(Array.isArray(selectors.stopButton) && selectors.stopButton.length > 0);
    assert.ok(Array.isArray(selectors.streaming) && selectors.streaming.length > 0);
    assert.ok(Array.isArray(selectors.status) && selectors.status.length > 0);
    assert.ok(Array.isArray(selectors.spinner) && selectors.spinner.length > 0);
    assert.ok(Array.isArray(selectors.messages) && selectors.messages.length > 0);
    assert.ok(Array.isArray(selectors.fallbackMessages) && selectors.fallbackMessages.length > 0);
    assert.ok(Array.isArray(selectors.mainRoot) && selectors.mainRoot.length > 0);
});

test('URL classification in utils.js distinguishes supported and unsupported providers', () => {
    // Supported ChatGPT URLs
    assert.equal(utils.isSupportedProviderUrl('https://chatgpt.com/'), true);
    assert.equal(utils.isSupportedProviderUrl('https://chatgpt.com/c/123-abc'), true);
    assert.equal(utils.isSupportedProviderUrl('https://chat.openai.com/'), true);
    assert.equal(utils.isSupportedProviderUrl('https://chat.openai.com/g/g-456/c/789'), true);
    assert.equal(utils.getUrlProvider('https://chatgpt.com/c/123'), 'chatgpt');
    assert.equal(utils.getUrlProvider('https://chat.openai.com/'), 'chatgpt');
    assert.equal(utils.isChatGPTUrl('https://chatgpt.com/c/123'), true);
    assert.equal(utils.isChatGPTUrl('https://chat.openai.com/'), true);

    // Unsupported URLs: Claude, Gemini, arbitrary sites, extension pages
    assert.equal(utils.isSupportedProviderUrl('https://claude.ai/chats'), false);
    assert.equal(utils.isSupportedProviderUrl('https://gemini.google.com/app'), false);
    assert.equal(utils.isSupportedProviderUrl('https://example.com/'), false);
    assert.equal(utils.isSupportedProviderUrl('chrome-extension://someid/popup.html'), false);
    assert.equal(utils.getUrlProvider('https://claude.ai/chats'), null);
    assert.equal(utils.getUrlProvider('https://gemini.google.com/app'), null);
    assert.equal(utils.getUrlProvider('https://example.com/'), null);
    assert.equal(utils.isChatGPTUrl('https://claude.ai/chats'), false);
    assert.equal(utils.isChatGPTUrl('https://gemini.google.com/app'), false);
    assert.equal(utils.isChatGPTUrl('https://example.com/'), false);
});

test('getProviderForUrl resolves ChatGPTAdapter for ChatGPT URLs and null for others', () => {
    const adapter1 = getProviderForUrl('https://chatgpt.com/c/test-chat');
    assert.ok(adapter1 instanceof ChatGPTAdapter);
    assert.equal(adapter1.id, 'chatgpt');

    const adapter2 = getProviderForUrl('https://chat.openai.com/');
    assert.ok(adapter2 instanceof ChatGPTAdapter);

    const adapter3 = getProviderForUrl('https://claude.ai/');
    assert.equal(adapter3, null);

    const adapter4 = getProviderForUrl('https://google.com/');
    assert.equal(adapter4, null);
});

test('ChatGPT conversation identity extraction classifies routes accurately', () => {
    const chatgpt = getProvider('chatgpt');

    // Existing chat: standard /c/:id
    const id1 = chatgpt.getConversationIdentity('https://chatgpt.com/c/67890-abc-def');
    assert.deepEqual(id1, {
        provider: 'chatgpt',
        type: 'existing',
        conversationId: '67890-abc-def',
        key: 'chatgpt:c:67890-abc-def'
    });

    // Existing chat with query and hash
    const id2 = chatgpt.getConversationIdentity('https://chatgpt.com/c/uuid-1234?model=o3#bottom');
    assert.deepEqual(id2, {
        provider: 'chatgpt',
        type: 'existing',
        conversationId: 'uuid-1234',
        key: 'chatgpt:c:uuid-1234'
    });

    // Existing GPT chat: /g/:gptId/c/:id
    const id3 = chatgpt.getConversationIdentity('https://chat.openai.com/g/g-abc12345/c/conv-67890');
    assert.deepEqual(id3, {
        provider: 'chatgpt',
        type: 'existing',
        conversationId: 'conv-67890',
        key: 'chatgpt:c:conv-67890'
    });

    // New chat: root /
    const id4 = chatgpt.getConversationIdentity('https://chatgpt.com/');
    assert.deepEqual(id4, {
        provider: 'chatgpt',
        type: 'new',
        conversationId: null,
        key: 'chatgpt:new'
    });

    // New chat in GPT: /g/:gptId without /c/
    const id5 = chatgpt.getConversationIdentity('https://chatgpt.com/g/g-abc12345-code-helper');
    assert.deepEqual(id5, {
        provider: 'chatgpt',
        type: 'new',
        conversationId: null,
        key: 'chatgpt:new'
    });

    // Unsupported routes
    const unsupportedRoutes = [
        'https://chatgpt.com/settings',
        'https://chatgpt.com/settings/data-controls',
        'https://chatgpt.com/admin',
        'https://chatgpt.com/auth/login',
        'https://chatgpt.com/share/snapshot-id'
    ];
    for (const route of unsupportedRoutes) {
        const idUnsup = chatgpt.getConversationIdentity(route);
        assert.equal(idUnsup.type, 'unsupported', `Expected ${route} to be unsupported`);
        assert.equal(idUnsup.provider, 'chatgpt');
    }
});

test('validateJobTargetConversation permits matches and detects cross-conversation navigation', async () => {
    const tabId = 101;

    // Helper to simulate tab URL
    function setTabUrl(url, identityResponse = null) {
        mockTabs.set(tabId, {
            id: tabId,
            url,
            onMessage: identityResponse ? () => ({ ok: true, identity: identityResponse }) : null
        });
    }

    // 1. Matching existing conversation
    setTabUrl('https://chatgpt.com/c/chat-111');
    const jobExisting = {
        tabId,
        provider: 'chatgpt',
        conversationId: 'chat-111',
        conversationType: 'existing',
        targetKey: 'chatgpt:c:chat-111',
        queue: ['msg 1', 'msg 2']
    };
    const valid1 = await validateJobTargetConversation(tabId, jobExisting);
    assert.equal(valid1.ok, true);

    // 2. Navigated to different existing conversation -> mismatch error
    setTabUrl('https://chatgpt.com/c/chat-222');
    const mismatchDiff = await validateJobTargetConversation(tabId, jobExisting);
    assert.equal(mismatchDiff.ok, false);
    assert.match(mismatchDiff.reason, /Conversation mismatch/);
    assert.match(mismatchDiff.reason, /chat-111/);
    assert.match(mismatchDiff.reason, /chat-222/);

    // 3. Navigated from existing conversation to a new conversation -> mismatch error
    setTabUrl('https://chatgpt.com/');
    const mismatchNew = await validateJobTargetConversation(tabId, jobExisting);
    assert.equal(mismatchNew.ok, false);
    assert.match(mismatchNew.reason, /Conversation mismatch.*new conversation/);

    // 4. Navigated from existing conversation to unsupported route (e.g. /settings) -> pauses
    setTabUrl('https://chatgpt.com/settings');
    const mismatchUnsup = await validateJobTargetConversation(tabId, jobExisting);
    assert.equal(mismatchUnsup.ok, false);
    assert.match(mismatchUnsup.reason, /unsupported page/);

    // 5. Job started on new conversation stays on new conversation -> ok
    setTabUrl('https://chatgpt.com/');
    const jobNew = {
        tabId,
        provider: 'chatgpt',
        conversationId: null,
        conversationType: 'new',
        targetKey: 'chatgpt:new',
        queue: ['msg 1']
    };
    const validNew = await validateJobTargetConversation(tabId, jobNew);
    assert.equal(validNew.ok, true);

    // 6. Job started on new conversation: after sending first message, tab URL updates to /c/:assignedId -> dynamic binding update
    setTabUrl('https://chatgpt.com/c/chat-dynamic-assigned');
    const validAssigned = await validateJobTargetConversation(tabId, jobNew);
    assert.equal(validAssigned.ok, true);
    assert.equal(validAssigned.updatedBinding, true);
    assert.equal(jobNew.conversationId, 'chat-dynamic-assigned');
    assert.equal(jobNew.conversationType, 'existing');
    assert.equal(jobNew.targetKey, 'chatgpt:c:chat-dynamic-assigned');

    // 7. Content script identity response takes precedence over tab URL
    setTabUrl('https://chatgpt.com/', {
        provider: 'chatgpt',
        type: 'existing',
        conversationId: 'content-script-id',
        key: 'chatgpt:c:content-script-id'
    });
    const resolvedCS = await resolveTabConversationIdentity(tabId);
    assert.equal(resolvedCS.conversationId, 'content-script-id');
    assert.equal(resolvedCS.type, 'existing');
});

test('Durable state serialization and restoration preserves conversation identity across restarts', () => {
    // 1. Restore legacy job without provider or conversation identity
    const legacyDurableJobs = {
        201: {
            tabId: 201,
            queue: ['command A', 'command B'],
            isRunning: true,
            completedCount: 1
        }
    };
    jobs.clear();
    restoreDurableJobs(legacyDurableJobs);
    assert.equal(jobs.has(201), true);
    const restoredLegacy = jobs.get(201);
    assert.equal(restoredLegacy.provider, 'chatgpt');
    assert.equal(restoredLegacy.conversationType, 'unknown');
    assert.equal(restoredLegacy.conversationId, null);
    assert.equal(restoredLegacy.targetKey, 'chatgpt:unknown');

    // 2. Restore modern job with full conversation binding
    const modernDurableJobs = {
        202: {
            tabId: 202,
            provider: 'chatgpt',
            conversationId: 'persisted-uuid-999',
            conversationType: 'existing',
            targetKey: 'chatgpt:c:persisted-uuid-999',
            queue: ['command C'],
            isRunning: true
        }
    };
    restoreDurableJobs(modernDurableJobs);
    assert.equal(jobs.has(202), true);
    const restoredModern = jobs.get(202);
    assert.equal(restoredModern.provider, 'chatgpt');
    assert.equal(restoredModern.conversationId, 'persisted-uuid-999');
    assert.equal(restoredModern.conversationType, 'existing');
    assert.equal(restoredModern.targetKey, 'chatgpt:c:persisted-uuid-999');

    // 3. getDurableJobsState serializes all 4 conversation fields
    const durableState = getDurableJobsState();
    assert.ok(durableState[202]);
    assert.equal(durableState[202].provider, 'chatgpt');
    assert.equal(durableState[202].conversationId, 'persisted-uuid-999');
    assert.equal(durableState[202].conversationType, 'existing');
    assert.equal(durableState[202].targetKey, 'chatgpt:c:persisted-uuid-999');

    // 4. getRunningJobsSnapshot serializes all 4 conversation fields
    const snapshot = getRunningJobsSnapshot();
    assert.ok(snapshot[202]);
    assert.equal(snapshot[202].provider, 'chatgpt');
    assert.equal(snapshot[202].conversationId, 'persisted-uuid-999');
    assert.equal(snapshot[202].conversationType, 'existing');
    assert.equal(snapshot[202].targetKey, 'chatgpt:c:persisted-uuid-999');

    jobs.clear();
});

test('handleStartSequence and handleEnqueueMessage bind conversation identity', async () => {
    jobs.clear();
    const tabId = 301;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/sequence-chat-123'
    });

    // 1. handleStartSequence
    let startResponse = null;
    handleStartSequence({
        tabId,
        messages: ['prompt 1', 'prompt 2']
    }, (res) => { startResponse = res; });

    // Allow microtasks to settle
    await new Promise(r => setTimeout(r, 10));

    assert.ok(startResponse && startResponse.ok);
    const job = jobs.get(tabId);
    assert.ok(job);
    assert.equal(job.provider, 'chatgpt');
    assert.equal(job.conversationId, 'sequence-chat-123');
    assert.equal(job.conversationType, 'existing');
    assert.equal(job.targetKey, 'chatgpt:c:sequence-chat-123');

    // Clean up
    jobs.clear();

    // 2. handleEnqueueMessage on new chat
    const tabIdNew = 302;
    mockTabs.set(tabIdNew, {
        id: tabIdNew,
        url: 'https://chatgpt.com/'
    });

    let enqueueResponse = null;
    handleEnqueueMessage({
        tabId: tabIdNew,
        message: 'single prompt',
        source: 'test'
    }, null, (res) => { enqueueResponse = res; });

    await new Promise(r => setTimeout(r, 10));

    assert.ok(enqueueResponse && enqueueResponse.ok);
    const jobNew = jobs.get(tabIdNew);
    assert.ok(jobNew);
    assert.equal(jobNew.provider, 'chatgpt');
    assert.equal(jobNew.conversationId, null);
    assert.equal(jobNew.conversationType, 'new');
    assert.equal(jobNew.targetKey, 'chatgpt:new');

    // 3. Pause on conversation mismatch preserves queue
    pauseJob(tabIdNew, 'Conversation mismatch: navigated away', { phase: 'pre-send-validation', mismatch: true });
    assert.equal(jobNew.isPaused, true);
    assert.equal(jobNew.isRunning, false);
    assert.equal(jobNew.pausedReason, 'Conversation mismatch: navigated away');
    assert.equal(jobNew.queue.length, 1);
    assert.equal(jobNew.queue[0], 'single prompt');

    jobs.clear();
});

class MockTestElement {
    constructor(tagName, attrs = {}, text = '') {
        this.tagName = (tagName || 'div').toUpperCase();
        this.attributes = new Map(Object.entries(attrs));
        this.innerText = text;
        this.textContent = text;
        this.children = [];
        this.disabled = !!attrs.disabled;
        this.parentElement = null;
        this.clicked = false;
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, val) {
        this.attributes.set(name, String(val));
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    click() {
        this.clicked = true;
    }

    querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
    }

    querySelectorAll(sel) {
        const results = [];
        const parts = sel.split(',').map(s => s.trim());

        const matchesThis = (el) => {
            return parts.some(part => {
                if (part === 'button') return el.tagName === 'BUTTON';
                if (part === 'article') return el.tagName === 'ARTICLE';
                if (part.startsWith('[data-testid')) {
                    const val = el.getAttribute('data-testid') || '';
                    if (part.includes('*=')) {
                        const target = part.match(/\*="([^"]+)"/)?.[1];
                        return target && val.includes(target);
                    }
                    if (part.includes('^=')) {
                        const target = part.match(/\^="([^"]+)"/)?.[1];
                        return target && val.startsWith(target);
                    }
                    if (part.includes('=')) {
                        const target = part.match(/="([^"]+)"/)?.[1];
                        return target && val === target;
                    }
                    return el.attributes.has('data-testid');
                }
                if (part.startsWith('[role=')) {
                    const target = part.match(/="([^"]+)"/)?.[1];
                    return el.getAttribute('role') === target;
                }
                if (part.startsWith('[data-message-author-role=')) {
                    const target = part.match(/="([^"]+)"/)?.[1];
                    return el.getAttribute('data-message-author-role') === target;
                }
                if (part.startsWith('.')) {
                    const cls = part.slice(1);
                    return (el.getAttribute('class') || '').includes(cls);
                }
                return false;
            });
        };

        for (const child of this.children) {
            if (matchesThis(child)) results.push(child);
            results.push(...child.querySelectorAll(sel));
        }
        return results;
    }
}

const MockElement = MockTestElement;

// Helper to construct lightweight DOM trees for provider adapter tests
function createTestDoc({ turns = [], alertNodes = [], buttons = [] } = {}) {
    const docRoot = new MockTestElement('body');

    for (const btn of buttons) {
        docRoot.appendChild(btn);
    }
    for (const alert of alertNodes) {
        docRoot.appendChild(alert);
    }
    for (const turn of turns) {
        docRoot.appendChild(turn);
    }

    return {
        MockElement: MockTestElement,
        doc: docRoot
    };
}

test('ChatGPTAdapter detects delivery timeout distinct from generic errors', () => {
    const chatgpt = getProvider('chatgpt');

    // 1. Delivery timeout inside an alert node
    const alertEl = new MockTestElement('div', { role: 'alert' }, 'Message delivery timed out. Please try again.');
    const { doc: doc1 } = createTestDoc({
        alertNodes: [alertEl]
    });

    const state1 = chatgpt.getGenerationState(doc1);
    assert.equal(state1.hasDeliveryTimedOut, true);
    assert.equal(state1.hasError, true);
    assert.equal(state1.matchedError, 'Message delivery timed out. Please try again.');
    assert.equal(state1.generating, false);

    // 2. Delivery timeout inside the latest turn
    const { doc: doc2 } = createTestDoc({
        turns: [
            new MockElement('article', { 'data-testid': 'conversation-turn-3' }, 'Message delivery timed out. Please try again.')
        ]
    });

    const state2 = chatgpt.getGenerationState(doc2);
    assert.equal(state2.hasDeliveryTimedOut, true);
    assert.equal(state2.hasError, true);
    assert.equal(state2.matchedError, 'Message delivery timed out. Please try again.');

    // 3. Generic error without delivery timeout
    const { doc: doc3 } = createTestDoc({
        alertNodes: [
            new MockElement('div', { role: 'alert' }, 'Something went wrong')
        ]
    });

    const state3 = chatgpt.getGenerationState(doc3);
    assert.equal(state3.hasDeliveryTimedOut, false);
    assert.equal(state3.hasError, true);
    assert.equal(state3.matchedError, 'something went wrong');
});

test('ChatGPTAdapter detects and clicks retry / regenerate button', () => {
    const chatgpt = getProvider('chatgpt');
    const { MockElement, doc } = createTestDoc();

    // 1. Button with "Regenerate"
    const regenBtn = new MockElement('button', { 'data-testid': 'regenerate-button' }, 'Regenerate response');
    doc.appendChild(regenBtn);

    assert.equal(chatgpt.getRetryButton(doc), regenBtn);
    assert.equal(chatgpt.clickRetryButton(doc), true);
    assert.equal(regenBtn.clicked, true);

    // 2. Latest turn takes priority over earlier buttons
    const turn1 = new MockElement('article', { 'data-testid': 'conversation-turn-1' });
    const oldBtn = new MockElement('button', {}, 'Retry');
    turn1.appendChild(oldBtn);

    const turn2 = new MockElement('article', { 'data-testid': 'conversation-turn-2' });
    const latestBtn = new MockElement('button', { 'aria-label': 'Try again' });
    turn2.appendChild(latestBtn);

    const { doc: docPriority } = createTestDoc({ turns: [turn1, turn2] });
    assert.equal(chatgpt.getRetryButton(docPriority), latestBtn);
});

test('ChatGPTAdapter getLastAssistantTurn verifies completed vs error states', () => {
    const chatgpt = getProvider('chatgpt');
    const { MockElement } = createTestDoc();

    // 1. Cleanly completed assistant response
    const turnAssistant = new MockElement('article', {
        'data-testid': 'conversation-turn-2',
        'data-message-author-role': 'assistant'
    }, 'This is the completed explanation of how the queue optimizer works.');

    const { doc: docCompleted } = createTestDoc({ turns: [turnAssistant] });
    const res1 = chatgpt.getLastAssistantTurn(docCompleted);
    assert.ok(res1);
    assert.equal(res1.isAssistant, true);
    assert.equal(res1.hasCompletedText, true);
    assert.equal(res1.hasError, false);
    assert.equal(res1.hasRetry, false);

    // 2. Assistant turn with delivery timeout
    const turnTimeout = new MockElement('article', {
        'data-testid': 'conversation-turn-2',
        'data-message-author-role': 'assistant'
    }, 'Message delivery timed out. Please try again.');

    const { doc: docTimeout } = createTestDoc({ turns: [turnTimeout] });
    const res2 = chatgpt.getLastAssistantTurn(docTimeout);
    assert.ok(res2);
    assert.equal(res2.isAssistant, true);
    assert.equal(res2.hasCompletedText, false);
    assert.equal(res2.hasDeliveryTimeout, true);
    assert.equal(res2.hasError, true);

    // 3. Assistant turn with retry button
    const turnWithRetry = new MockElement('article', {
        'data-testid': 'conversation-turn-2',
        'data-message-author-role': 'assistant'
    }, 'An error occurred.');
    turnWithRetry.appendChild(new MockElement('button', {}, 'Try again'));

    const { doc: docRetry } = createTestDoc({ turns: [turnWithRetry] });
    const res3 = chatgpt.getLastAssistantTurn(docRetry);
    assert.ok(res3);
    assert.equal(res3.isAssistant, true);
    assert.equal(res3.hasCompletedText, false);
    assert.equal(res3.hasRetry, true);

    // 4. User turn only
    const turnUser = new MockElement('article', {
        'data-testid': 'conversation-turn-1',
        'data-message-author-role': 'user'
    }, 'My question to ChatGPT');

    const { doc: docUser } = createTestDoc({ turns: [turnUser] });
    const res4 = chatgpt.getLastAssistantTurn(docUser);
    assert.ok(res4);
    assert.equal(res4.isAssistant, false);
    assert.equal(res4.hasCompletedText, false);
});

test('waitForTabResponse classifies delivery timeout correctly', async () => {
    const tabId = 401;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/delivery-test',
        onMessage: (message) => {
            if (message.type === 'CHECK_GENERATION_STATE') {
                return {
                    state: {
                        generating: false,
                        hasError: true,
                        hasDeliveryTimedOut: true,
                        matchedError: 'Message delivery timed out. Please try again.'
                    }
                };
            }
            return { ok: true };
        }
    });

    jobs.set(tabId, {
        tabId,
        isRunning: true,
        isPaused: false,
        isStopped: false
    });

    const waitResult = await waitForTabResponse(tabId, {
        commandNumber: 1,
        totalMessages: 1
    });

    assert.equal(waitResult.ok, false);
    assert.equal(waitResult.isDeliveryTimeout, true);
    assert.equal(waitResult.error, 'Message delivery timed out. Please try again.');

    jobs.clear();
});

test('recoverFromDeliveryTimeout handles Stage 1 in-page retry', async () => {
    const tabId = 501;
    let retryClicked = false;
    let checkCount = 0;

    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/stage1-test',
        onMessage: (message) => {
            if (message.type === 'CLICK_RETRY_BUTTON') {
                retryClicked = true;
                return { ok: true };
            }
            if (message.type === 'CHECK_GENERATION_STATE') {
                checkCount++;
                if (checkCount === 1) {
                    // Check after click: shows generating
                    return { state: { generating: true } };
                }
                // Later check finishes generating
                return { state: { generating: false, hasError: false, hasTryAgainButton: false } };
            }
            return { ok: true };
        }
    });

    const job = {
        tabId,
        provider: 'chatgpt',
        conversationId: 'stage1-test',
        targetKey: 'chatgpt:c:stage1-test',
        queue: ['next prompt'],
        currentMessage: 'prompt to retry',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        currentCommandNumber: 1,
        completedCount: 0,
        deliveryTimeoutAttempts: 0
    };
    jobs.set(tabId, job);

    const waitResult = {
        ok: false,
        isDeliveryTimeout: true,
        details: { state: { hasTryAgainButton: true } }
    };

    const recovery = await recoverFromDeliveryTimeout(tabId, job, waitResult, 2, {
        queueUnlimitedRetryWait: false,
        queueDeepResearchAware: true,
        queueDeliveryTimeoutRefresh: true
    });

    assert.equal(retryClicked, true);
    assert.equal(recovery.action, 'complete');
    assert.equal(job.deliveryTimeoutAttempts, 0);

    jobs.clear();
});

test('recoverFromDeliveryTimeout Stage 2 Case A advances queue when turn completed on backend', async () => {
    const tabId = 502;
    let reloadRequested = false;

    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/stage2-backend-complete',
        onMessage: (message) => {
            if (message.type === 'RELOAD_PAGE') {
                reloadRequested = true;
                return { ok: true };
            }
            if (message.type === 'CHECK_GENERATION_STATE') {
                return { state: { generating: false } };
            }
            if (message.type === 'INSPECT_GENERATION_STATE') {
                return {
                    ok: true,
                    state: { generating: false, hasError: false, hasTryAgainButton: false },
                    lastAssistant: {
                        isAssistant: true,
                        text: 'Full answer that ChatGPT finished on backend before timeout.',
                        hasCompletedText: true,
                        hasError: false,
                        hasRetry: false
                    }
                };
            }
            return { ok: true };
        }
    });

    const job = {
        tabId,
        provider: 'chatgpt',
        conversationId: 'stage2-backend-complete',
        targetKey: 'chatgpt:c:stage2-backend-complete',
        queue: [],
        currentMessage: 'prompt that timed out',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        currentCommandNumber: 1,
        completedCount: 0,
        deliveryTimeoutAttempts: 0
    };
    jobs.set(tabId, job);

    const waitResult = {
        ok: false,
        isDeliveryTimeout: true,
        details: { state: { hasTryAgainButton: false } }
    };

    const recovery = await recoverFromDeliveryTimeout(tabId, job, waitResult, 1, {
        queueUnlimitedRetryWait: false,
        queueDeepResearchAware: true,
        queueDeliveryTimeoutRefresh: true
    });

    assert.equal(reloadRequested, true);
    assert.equal(recovery.action, 'complete');
    assert.equal(job.deliveryTimeoutAttempts, 0);
    assert.equal(recovery.details?.recoveredViaBackendCompletion, true);

    jobs.clear();
});

test('recoverFromDeliveryTimeout Stage 2 Case C re-enqueues message when turn was incomplete', async () => {
    const tabId = 503;

    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/stage2-incomplete',
        onMessage: (message) => {
            if (message.type === 'RELOAD_PAGE') return { ok: true };
            if (message.type === 'CHECK_GENERATION_STATE') return { state: { generating: false } };
            if (message.type === 'INSPECT_GENERATION_STATE') {
                return {
                    ok: true,
                    state: { generating: false, hasError: false, hasTryAgainButton: false },
                    lastAssistant: {
                        isAssistant: false,
                        text: '',
                        hasCompletedText: false
                    }
                };
            }
            return { ok: true };
        }
    });

    const job = {
        tabId,
        provider: 'chatgpt',
        conversationId: 'stage2-incomplete',
        targetKey: 'chatgpt:c:stage2-incomplete',
        queue: ['subsequent prompt'],
        currentMessage: 'timed out prompt to resend',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        currentCommandNumber: 1,
        completedCount: 0,
        deliveryTimeoutAttempts: 0
    };
    jobs.set(tabId, job);

    const waitResult = {
        ok: false,
        isDeliveryTimeout: true,
        details: { state: { hasTryAgainButton: false } }
    };

    const recovery = await recoverFromDeliveryTimeout(tabId, job, waitResult, 2, {
        queueUnlimitedRetryWait: false,
        queueDeepResearchAware: true,
        queueDeliveryTimeoutRefresh: true
    });

    assert.equal(recovery.action, 'retry');
    assert.equal(job.currentMessage, null);
    assert.equal(job.queue.length, 2);
    assert.equal(job.queue[0], 'timed out prompt to resend');
    assert.equal(job.deliveryTimeoutAttempts, 1);

    jobs.clear();
});

test('recoverFromDeliveryTimeout bounds attempts to 3 when unlimited retry is false', async () => {
    const tabId = 504;

    const job = {
        tabId,
        provider: 'chatgpt',
        conversationId: 'attempt-limit',
        targetKey: 'chatgpt:c:attempt-limit',
        queue: [],
        currentMessage: 'prompt',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        currentCommandNumber: 1,
        completedCount: 0,
        deliveryTimeoutAttempts: 3
    };
    jobs.set(tabId, job);

    const waitResult = {
        ok: false,
        isDeliveryTimeout: true,
        details: { state: {} }
    };

    const recovery = await recoverFromDeliveryTimeout(tabId, job, waitResult, 1, {
        queueUnlimitedRetryWait: false,
        queueDeepResearchAware: true,
        queueDeliveryTimeoutRefresh: true
    });

    assert.equal(recovery.action, 'fail');
    assert.equal(job.deliveryTimeoutAttempts, 4);

    jobs.clear();
});

test('Durable state and settings preserve deliveryTimeoutAttempts and defaults', () => {
    assert.equal(QUEUE_SETTINGS_DEFAULTS.queueDeliveryTimeoutRefresh, true);

    const job = {
        tabId: 601,
        provider: 'chatgpt',
        conversationId: 'persist-attempts',
        conversationType: 'existing',
        targetKey: 'chatgpt:c:persist-attempts',
        queue: ['p1'],
        currentMessage: 'p2',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        currentCommandNumber: 2,
        completedCount: 1,
        deliveryTimeoutAttempts: 2,
        startedAt: Date.now(),
        updatedAt: Date.now()
    };
    jobs.set(601, job);

    const snapshot = getRunningJobsSnapshot();
    assert.equal(snapshot[601].deliveryTimeoutAttempts, 2);

    const durable = getDurableJobsState();
    assert.equal(durable[601].deliveryTimeoutAttempts, 2);

    jobs.clear();

    const restored = restoreDurableJobs(durable);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].deliveryTimeoutAttempts, 2);

    jobs.clear();
});

