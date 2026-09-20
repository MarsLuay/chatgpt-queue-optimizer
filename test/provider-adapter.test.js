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
    sendPromptToSpecificTab,
    refreshChatGPTTab,
    waitForTabToRecover,
    waitForTabResponse,
    classifyQueueFailure,
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

    // Supported Gemini URLs
    assert.equal(utils.isSupportedProviderUrl('https://gemini.google.com/app'), true);
    assert.equal(utils.getUrlProvider('https://gemini.google.com/app/abc'), 'gemini');
    assert.equal(utils.isChatGPTUrl('https://gemini.google.com/app'), false);

    // Supported Claude URLs
    assert.equal(utils.isSupportedProviderUrl('https://claude.ai/new'), true);
    assert.equal(utils.getUrlProvider('https://claude.ai/chat/abc-123'), 'claude');
    assert.equal(utils.isChatGPTUrl('https://claude.ai/new'), false);

    // Unsupported URLs: other Google hosts, arbitrary sites, extension pages
    assert.equal(utils.isSupportedProviderUrl('https://mail.google.com/'), false);
    assert.equal(utils.isSupportedProviderUrl('https://aistudio.google.com/'), false);
    assert.equal(utils.isSupportedProviderUrl('https://example.com/'), false);
    assert.equal(utils.isSupportedProviderUrl('chrome-extension://someid/popup.html'), false);
    assert.equal(utils.getUrlProvider('https://mail.google.com/'), null);
    assert.equal(utils.getUrlProvider('https://example.com/'), null);
    assert.equal(utils.isChatGPTUrl('https://example.com/'), false);
});

test('getProviderForUrl resolves ChatGPTAdapter for ChatGPT URLs and null for others', () => {
    const adapter1 = getProviderForUrl('https://chatgpt.com/c/test-chat');
    assert.ok(adapter1 instanceof ChatGPTAdapter);
    assert.equal(adapter1.id, 'chatgpt');

    const adapter2 = getProviderForUrl('https://chat.openai.com/');
    assert.ok(adapter2 instanceof ChatGPTAdapter);

    const adapterGemini = getProviderForUrl('https://gemini.google.com/app');
    assert.equal(adapterGemini.id, 'gemini');

    const adapterClaude = getProviderForUrl('https://claude.ai/');
    assert.equal(adapterClaude.id, 'claude');

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
    await new Promise(r => { setTimeout(r, 10); });

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

    await new Promise(r => { setTimeout(r, 10); });

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

test('popup queue starts wait for idle while active-queue append ordering stays unchanged', async () => {
    jobs.clear();

    const enqueueTabId = 303;
    mockTabs.set(enqueueTabId, {
        id: enqueueTabId,
        url: 'https://chatgpt.com/c/popup-enqueue'
    });

    let enqueueResponse = null;
    handleEnqueueMessage({
        tabId: enqueueTabId,
        message: 'popup next',
        source: 'popup',
        waitForIdleBeforeStart: true
    }, null, (res) => { enqueueResponse = res; });

    await new Promise(r => { setTimeout(r, 10); });

    assert.ok(enqueueResponse?.ok);
    assert.equal(enqueueResponse.waitingForIdle, true);
    const enqueueJob = jobs.get(enqueueTabId);
    assert.equal(enqueueJob.currentPhase, 'waiting-for-idle');
    assert.equal(enqueueJob.waitForIdleBeforeSend, true);
    assert.deepEqual(enqueueJob.queue, ['popup next']);
    enqueueJob.isStopped = true;
    enqueueJob.isRunning = false;

    jobs.clear();

    const sequenceTabId = 304;
    mockTabs.set(sequenceTabId, {
        id: sequenceTabId,
        url: 'https://chatgpt.com/c/popup-sequence'
    });

    let sequenceResponse = null;
    handleStartSequence({
        tabId: sequenceTabId,
        messages: ['sequence first', 'sequence second'],
        waitForIdleBeforeStart: true
    }, (res) => { sequenceResponse = res; });

    await new Promise(r => { setTimeout(r, 10); });

    assert.ok(sequenceResponse?.ok);
    assert.equal(sequenceResponse.waitingForIdle, true);
    const sequenceJob = jobs.get(sequenceTabId);
    assert.equal(sequenceJob.currentPhase, 'waiting-for-idle');
    assert.equal(sequenceJob.waitForIdleBeforeSend, true);
    assert.deepEqual(sequenceJob.queue, ['sequence first', 'sequence second']);
    sequenceJob.isStopped = true;
    sequenceJob.isRunning = false;

    jobs.clear();

    const appendTabId = 305;
    const appendJob = {
        tabId: appendTabId,
        provider: 'chatgpt',
        conversationId: 'append-chat',
        conversationType: 'existing',
        targetKey: 'chatgpt:c:append-chat',
        queue: ['existing queued item'],
        currentMessage: 'in-flight item',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        currentPhase: 'waiting',
        waitForIdleBeforeSend: false
    };
    jobs.set(appendTabId, appendJob);

    let appendResponse = null;
    handleEnqueueMessage({
        tabId: appendTabId,
        message: 'popup appended item',
        position: 'end',
        waitForIdleBeforeStart: true
    }, null, (res) => { appendResponse = res; });

    await new Promise(r => { setTimeout(r, 10); });

    assert.ok(appendResponse?.ok);
    assert.equal(appendResponse.started, false);
    assert.deepEqual(appendJob.queue, ['existing queued item', 'popup appended item']);
    assert.equal(appendJob.currentMessage, 'in-flight item');
    assert.equal(appendJob.currentPhase, 'waiting');

    jobs.clear();
});

class MockTestElement {
    constructor(tagName, attrs = {}, text = '') {
        this.nodeType = 1;
        this.tagName = (tagName || 'div').toUpperCase();
        this.attributes = new Map(Object.entries(attrs));
        this.innerText = text;
        this.textContent = text;
        this.children = [];
        this.disabled = !!attrs.disabled;
        this.hidden = false;
        this.parentElement = null;
        this.clicked = false;
        this.id = attrs.id || '';
    }

    getAttribute(name) {
        if (name === 'id') return this.id || null;
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, val) {
        this.attributes.set(name, String(val));
        if (name === 'id') this.id = String(val);
    }

    contains(node) {
        let current = node;
        while (current) {
            if (current === this) return true;
            current = current.parentElement;
        }
        return false;
    }

    matches(selector) {
        return selector.split(',').some((part) => {
            part = part.trim();
            if (!part) return false;
            const descendant = part.split(/\s+/);
            if (descendant.length > 1) {
                let current = this;
                for (let index = descendant.length - 1; index >= 0; index -= 1) {
                    if (!current || !current.matches(descendant[index])) return false;
                    current = current.parentElement;
                }
                return true;
            }
            if (part.startsWith('#')) return this.id === part.slice(1);
            const tagMatch = part.match(/^([a-z0-9_-]+)?(\[.+\])?$/i);
            if (!tagMatch) return false;
            if (tagMatch[1] && this.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
            if (!tagMatch[2]) return !part.startsWith('[') || this.tagName.toLowerCase() === part.toLowerCase();
            const attr = tagMatch[2].slice(1, -1);
            const operator = attr.match(/(\^=|\*=|=)/)?.[1];
            const [name, rawValue] = operator ? attr.split(operator) : [attr, null];
            const value = this.getAttribute(name.trim());
            if (!operator) return value !== null;
            const expected = rawValue.replace(/[\"']/g, '').trim();
            if (operator === '=') return value === expected;
            if (operator === '^=') return String(value || '').startsWith(expected);
            return String(value || '').includes(expected);
        });
    }

    closest(selector) {
        let current = this;
        while (current) {
            if (current.matches(selector)) return current;
            current = current.parentElement;
        }
        return null;
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    click() {
        this.clicked = true;
    }

    focus() {
        this.focused = true;
    }

    dispatchEvent() {
        return true;
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
                if (part === 'textarea') return el.tagName === 'TEXTAREA';
                if (part === 'main') return el.tagName === 'MAIN';
                if (part === 'body') return el.tagName === 'BODY';
                if (part.startsWith('#')) return el.id === part.slice(1);
                if (part.includes('contenteditable')) {
                    return el.getAttribute('contenteditable') === 'true' &&
                        (!part.includes('role="textbox"') || el.getAttribute('role') === 'textbox');
                }
                if (part.includes('[') && typeof el.matches === 'function') {
                    return el.matches(part);
                }
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
                if (part.startsWith('[data-message-id')) {
                    return el.getAttribute('data-message-id') !== null;
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
function createTestDoc({ turns = [], alertNodes = [], buttons = [], extraNodes = [] } = {}) {
    const docRoot = new MockTestElement('body');

    for (const node of [...extraNodes, ...buttons, ...alertNodes, ...turns]) {
        docRoot.appendChild(node);
    }

    return {
        MockElement: MockTestElement,
        doc: docRoot
    };
}

test('ChatGPT compatibility surface resolves canonical controls and rejects unscoped editable fallbacks', () => {
    const chatgpt = getProvider('chatgpt');
    const contract = chatgpt.getCompatibilityContract();
    assert.deepEqual(contract.selectors, chatgpt.selectors);
    assert.deepEqual(contract.requiredSignals, ['composer', 'sendButton']);
    assert.ok(contract.signals.messageContext.includes('[data-testid^="conversation-turn"]'));
    assert.ok(contract.signals.researchMarkers.includes('deep research'));
    assert.ok(contract.signals.deliveryTimeoutMarkers.includes('message delivery timed out'));

    const canonical = new MockTestElement('div', {
        'data-testid': 'prompt-textarea',
        contenteditable: 'true'
    });
    const unrelated = new MockTestElement('div', { contenteditable: 'true' });
    const sendButton = new MockTestElement('button', { 'data-testid': 'send-button' });
    const { doc } = createTestDoc({ extraNodes: [unrelated, canonical, sendButton] });

    const composerMatch = chatgpt.getComposerMatch(doc);
    assert.equal(composerMatch.element, canonical);
    assert.equal(composerMatch.selector, '[data-testid="prompt-textarea"]');
    assert.equal(chatgpt.getSendActionMatch(doc).element, sendButton);

    const { doc: missingCanonical } = createTestDoc({
        extraNodes: [new MockTestElement('div', { contenteditable: 'true' })]
    });
    assert.equal(chatgpt.getComposerMatch(missingCanonical).element, null);

    const { doc: unscopedTextarea } = createTestDoc({
        extraNodes: [new MockTestElement('textarea')]
    });
    assert.equal(chatgpt.getComposerMatch(unscopedTextarea).element, null);

    const form = new MockTestElement('form');
    const fallbackTextarea = new MockTestElement('textarea');
    form.appendChild(fallbackTextarea);
    const { doc: scopedTextarea } = createTestDoc({ extraNodes: [form] });
    assert.equal(chatgpt.getComposerMatch(scopedTextarea).element, fallbackTextarea);
});

test('ChatGPT compatibility diagnostics distinguish empty conversations from missing controls', () => {
    const chatgpt = getProvider('chatgpt');
    const composer = new MockTestElement('textarea', { id: 'prompt-textarea' });
    const sendButton = new MockTestElement('button', { 'data-testid': 'send-button' });
    const { doc } = createTestDoc({ extraNodes: [composer, sendButton] });
    doc.defaultView = { location: { href: 'https://chatgpt.com/' } };

    const empty = chatgpt.getCompatibilityDiagnostics(doc);
    assert.equal(empty.root.selector, 'body');
    assert.equal(empty.composer.selector, '#prompt-textarea');
    assert.equal(empty.sendAction.selector, 'button[data-testid="send-button"]');
    assert.equal(empty.messages.state, 'empty-conversation');
    assert.deepEqual(empty.requiredFailures, []);
    assert.equal(JSON.stringify(empty).includes('prompt text'), false);

    const missing = chatgpt.getCompatibilityDiagnostics(createTestDoc({}).doc);
    assert.equal(missing.messages.state, 'required-signals-missing');
    assert.equal(missing.composer.matched, false);
    assert.equal(missing.sendAction.matched, false);
    assert.deepEqual(missing.requiredFailures, ['composer', 'sendButton']);

    const composerOnly = new MockTestElement('textarea', { id: 'prompt-textarea' });
    const missingSend = chatgpt.getCompatibilityDiagnostics(createTestDoc({ extraNodes: [composerOnly] }).doc);
    assert.equal(missingSend.messages.state, 'required-signals-missing');
    assert.deepEqual(missingSend.requiredFailures, ['sendButton']);
});

test('ChatGPT message and generation diagnostics report matched canonical signals', () => {
    const chatgpt = getProvider('chatgpt');
    const composer = new MockTestElement('textarea', { id: 'prompt-textarea' });
    const turn = new MockTestElement('article', {
        'data-testid': 'conversation-turn-1',
        'data-message-author-role': 'assistant'
    }, 'A visible assistant response with enough text for message normalization.');
    const status = new MockTestElement('div', { role: 'status' }, 'Deep research is searching sources');
    const stop = new MockTestElement('button', { 'data-testid': 'stop-button' });
    const { doc } = createTestDoc({ extraNodes: [composer, turn, status, stop] });

    const messages = chatgpt.getMessageDiscovery(doc).nodes;
    assert.deepEqual(messages, [turn]);

    const dataIdMessage = new MockTestElement('div', {
        'data-message-id': 'message-1'
    }, 'A fallback message identified by a stable data-message-id attribute.');
    const fallbackDoc = createTestDoc({ extraNodes: [dataIdMessage] }).doc;
    assert.deepEqual(chatgpt.getMessageNodes(fallbackDoc), [dataIdMessage]);

    const state = chatgpt.getGenerationState(doc);
    assert.equal(state.generating, true);
    assert.equal(state.deepResearchActive, true);
    assert.equal(state.matchedSignals.stopButton, 'button[data-testid="stop-button"]');
    assert.equal(state.matchedSignals.status, '[role="status"]');
    assert.equal(state.matchedSignals.research, 'researchMarkers:deep research');
});

test('Queued ChatGPT send uses the canonical composer and reports compatibility failures without mutation', async () => {
    const originalExecuteScript = chrome.scripting.executeScript;
    const originalDocument = global.document;
    const originalLocation = global.location;
    const originalInputEvent = global.InputEvent;

    try {
        chrome.scripting.executeScript = async (details) => [{
            result: await details.func(...details.args)
        }];
        global.InputEvent = class {
            constructor(type, init) {
                this.type = type;
                this.init = init;
            }
        };
        global.location = { href: 'https://chatgpt.com/c/send-contract' };

        const canonicalDoc = new MockTestElement('body');
        canonicalDoc.title = 'ChatGPT';
        canonicalDoc.createElement = (tag) => new MockTestElement(tag);
        canonicalDoc.activeElement = null;
        const composer = new MockTestElement('textarea', { id: 'prompt-textarea' });
        const sendButton = new MockTestElement('button', { 'data-testid': 'send-button' });
        canonicalDoc.appendChild(composer);
        canonicalDoc.appendChild(sendButton);
        global.document = canonicalDoc;
        mockTabs.set(901, {
            id: 901,
            url: global.location.href,
            onMessage: (message) => {
                if (message.type === 'GET_COMMAND_TURN_SNAPSHOT') {
                    const chatgpt = getProvider('chatgpt');
                    return {
                        ok: true,
                        snapshot: chatgpt.getCommandTurnSnapshot(canonicalDoc, {
                            expectedText: message.expectedText
                        })
                    };
                }
                return { ok: true };
            }
        });

        sendButton.click = function clickAndAccept() {
            this.clicked = true;
            const userTurn = new MockTestElement('article', {
                'data-testid': 'conversation-turn-1',
                'data-message-author-role': 'user',
                'data-message-id': 'user-turn-queued'
            }, 'queued prompt');
            canonicalDoc.appendChild(userTurn);
        };

        const sent = await sendPromptToSpecificTab(901, 'queued prompt');
        assert.equal(sent.ok, true);
        assert.equal(composer.value, 'queued prompt');
        assert.equal(sendButton.clicked, true);
        assert.equal(sent.details.composerSelector, '#prompt-textarea');
        assert.equal(sent.details.sendButtonSelector, 'button[data-testid="send-button"]');

        const unrelatedDoc = new MockTestElement('body');
        unrelatedDoc.title = 'ChatGPT';
        unrelatedDoc.createElement = (tag) => new MockTestElement(tag);
        unrelatedDoc.activeElement = null;
        const unrelated = new MockTestElement('div', { contenteditable: 'true' });
        unrelated.textContent = 'draft';
        const unrelatedTextarea = new MockTestElement('textarea');
        unrelatedTextarea.value = 'keep this draft';
        unrelatedDoc.appendChild(unrelated);
        unrelatedDoc.appendChild(unrelatedTextarea);
        global.document = unrelatedDoc;

        const failed = await sendPromptToSpecificTab(901, 'must not send');
        assert.equal(failed.ok, false);
        assert.match(failed.error, /compatibility failure: required composer signal/);
        assert.equal(failed.details.compatibilityFailure, 'composer');
        assert.equal(unrelated.textContent, 'draft');
        assert.equal(unrelatedTextarea.value, 'keep this draft');
    } finally {
        chrome.scripting.executeScript = originalExecuteScript;
        if (originalDocument === undefined) delete global.document;
        else global.document = originalDocument;
        if (originalLocation === undefined) delete global.location;
        else global.location = originalLocation;
        if (originalInputEvent === undefined) delete global.InputEvent;
        else global.InputEvent = originalInputEvent;
        mockTabs.delete(901);
    }
});

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
    const timeoutClass = classifyQueueFailure('wait', state1.matchedError, { state: state1 });
    assert.equal(timeoutClass.class, 'timeout');
    assert.equal(timeoutClass.retryable, true);

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

test('waitForTabResponse keeps Deep Research finite unless unlimited retry is enabled', async () => {
    const tabId = 702;
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/deep-research-wait',
        onMessage: (message) => {
            if (message.type === 'CHECK_GENERATION_STATE') {
                return {
                    state: {
                        generating: false,
                        deepResearchActive: true,
                        researchStatusPreview: 'Deep research is searching sources',
                        hasError: false,
                        hasTryAgainButton: false
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
        isStopped: false,
        currentPhase: 'waiting'
    });

    const waitResult = await waitForTabResponse(tabId, {
        commandNumber: 1,
        totalMessages: 1,
        queueSettings: {
            queueUnlimitedRetryWait: false,
            queueDeepResearchAware: true
        },
        maxWaitMs: 80,
        deepResearchMaxWaitMs: 180,
        deepResearchStaleMs: 1000,
        checkIntervalMs: 20
    });

    assert.equal(waitResult.ok, false);
    assert.match(waitResult.error, /Deep Research|timed out/i);
    assert.equal(waitResult.details.sawDeepResearch, true);

    const classified = classifyQueueFailure('wait', waitResult.error, waitResult.details);
    assert.equal(classified.retryable, true);
    jobs.clear();
});

test('ChatGPT command turn snapshot matches a new user turn without returning prompt text', () => {
    const chatgpt = getProvider('chatgpt');
    const user = new MockTestElement('article', {
        'data-testid': 'conversation-turn-1',
        'data-message-author-role': 'user',
        'data-message-id': 'user-25'
    }, '#25 fixture topic');
    const assistant = new MockTestElement('article', {
        'data-testid': 'conversation-turn-2',
        'data-message-author-role': 'assistant',
        'data-message-id': 'asst-25'
    }, 'A completed assistant answer for topic 25.');
    const { doc } = createTestDoc({ turns: [user, assistant] });
    doc.defaultView = { location: { href: 'https://chatgpt.com/c/issue-43' } };

    const snapshot = chatgpt.getCommandTurnSnapshot(doc, { expectedText: '#25 fixture topic' });
    assert.equal(snapshot.matchedUserTurnId, 'user-25');
    assert.equal(snapshot.latestUserTurnId, 'user-25');
    assert.equal(snapshot.latestAssistantTurnId, 'asst-25');
    assert.equal(snapshot.userTurns[0].matchedExpected, true);
    assert.equal(JSON.stringify(snapshot).includes('#25 fixture topic'), false);
    assert.equal(JSON.stringify(snapshot).includes('completed assistant answer'), false);

    const terminal = chatgpt.getCommandResponseState(doc, { userTurnId: 'user-25' });
    assert.equal(terminal.phase, 'terminal');
    assert.equal(terminal.assistantTurnId, 'asst-25');
    assert.equal(terminal.source, 'bound-assistant-turn');
    assert.equal(JSON.stringify(terminal).includes('#25 fixture topic'), false);
});

test('ChatGPT command response state treats idle gaps as transient until the bound assistant turn completes', () => {
    const chatgpt = getProvider('chatgpt');
    const user = new MockTestElement('article', {
        'data-testid': 'conversation-turn-1',
        'data-message-author-role': 'user',
        'data-message-id': 'user-26'
    }, '#26 fixture topic');
    const { doc } = createTestDoc({ turns: [user] });
    const idle = chatgpt.getCommandResponseState(doc, { userTurnId: 'user-26' });
    assert.equal(idle.phase, 'transient-idle');

    const streamingAssistant = new MockTestElement('article', {
        'data-testid': 'conversation-turn-2',
        'data-message-author-role': 'assistant',
        'data-message-id': 'asst-26',
        'data-message-streaming': 'true'
    }, 'partial');
    const { doc: streamingDoc } = createTestDoc({
        turns: [user, streamingAssistant],
        extraNodes: [new MockTestElement('button', { 'data-testid': 'stop-button' })]
    });
    const active = chatgpt.getCommandResponseState(streamingDoc, { userTurnId: 'user-26' });
    assert.equal(active.phase, 'active');
});

