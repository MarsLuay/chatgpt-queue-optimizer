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
    assert.equal(base.isValidMessageNode(null), false);
    assert.equal(base.isValidFallbackNode(null), false);
});

test('ChatGPTAdapter implements ProviderAdapter with complete selectors and methods', () => {
    const chatgpt = getProvider('chatgpt');
    assert.ok(chatgpt instanceof ProviderAdapter);
    assert.ok(chatgpt instanceof ChatGPTAdapter);
    assert.equal(chatgpt.id, 'chatgpt');
    assert.equal(chatgpt.name, 'ChatGPT');

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

