const test = require('node:test');
const assert = require('node:assert/strict');

const storage = {};
const tabs = new Map();
const alarms = new Map();

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

global.extensionApiPromise = (callWithCallback, callWithoutCallback) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
        if (!settled) {
            settled = true;
            resolve(value);
        }
    };

    try {
        const result = callWithCallback(finish);
        if (result && typeof result.then === 'function') {
            result.then(finish, reject);
        }
    } catch (error) {
        try {
            const fallback = callWithoutCallback();
            if (fallback && typeof fallback.then === 'function') {
                fallback.then(finish, reject);
            } else {
                finish(fallback);
            }
        } catch (fallbackError) {
            reject(fallbackError || error);
        }
    }
});

global.isSupportedProviderUrl = (url) => /^https:\/\/(chatgpt\.com|chat\.openai\.com|gemini\.google\.com|claude\.ai)\//.test(url || '');

global.chrome = {
    runtime: {
        lastError: undefined,
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: (_message, callback) => callback?.(),
        getURL: () => ''
    },
    browserAction: { onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
    storage: {
        sync: {
            get: (defaults, callback) => callback?.(clone(defaults)),
            set: (_items, callback) => callback?.()
        },
        local: {
            get: (keys, callback) => {
                const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
                const result = {};
                for (const key of names) {
                    if (Object.prototype.hasOwnProperty.call(storage, key)) result[key] = clone(storage[key]);
                }
                callback?.(result);
            },
            set: (items, callback) => {
                Object.assign(storage, clone(items));
                callback?.();
            }
        }
    },
    tabs: {
        onRemoved: { addListener: () => {} },
        get: (tabId, callback) => callback?.(tabs.get(Number(tabId))),
        query: (_query, callback) => callback?.([]),
        sendMessage: (tabId, _message, callback) => callback?.({ ok: true, identity: tabs.get(Number(tabId))?.identity }),
        create: () => {},
        executeScript: () => {}
    },
    alarms: {
        onAlarm: { addListener: () => {} },
        create: (name, info) => alarms.set(name, clone(info)),
        clear: (name, callback) => {
            const existed = alarms.delete(name);
            callback?.(existed);
        }
    },
    scripting: { executeScript: () => {} }
};

const api = require('../background.js');

const identity = {
    provider: 'chatgpt',
    type: 'existing',
    conversationId: 'conversation-1',
    key: 'chatgpt:c:conversation-1'
};

function addTab(tabId, currentIdentity = identity) {
    tabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/conversation-1',
        identity: currentIdentity
    });
}

function pendingItem(id, dueTs = Date.now() - 100, overrides = {}) {
    return {
        id,
        text: `message-${id}`,
        dueTs,
        tabId: 7,
        provider: identity.provider,
        conversationId: identity.conversationId,
        conversationType: identity.type,
        targetKey: identity.key,
        createdAt: dueTs - 1000,
        updatedAt: dueTs - 1000,
        status: 'pending',
        failureReason: '',
        ...overrides
    };
}

test.beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
    tabs.clear();
    alarms.clear();
    api.jobs.clear();
});

test('scheduled messages persist absolute due time and create one alarm', async () => {
    addTab(7);
    const dueTs = Date.now() + 60_000;

    const result = await api.createScheduledMessage({
        text: '  send this later  ',
        dueTs,
        tabId: 7,
        conversationIdentity: identity
    });

    assert.equal(result.ok, true);
    assert.equal(result.item.text, 'send this later');
    assert.equal(result.item.dueTs, dueTs);
    assert.equal(storage.scheduledMessages.length, 1);
    assert.deepEqual(alarms.get(`scheduled-msg:${result.item.id}`), { when: dueTs });
});

test('scheduled items are restored in due order and alarms are recreated after restart', async () => {
    storage.scheduledMessages = [
        pendingItem('later', Date.now() + 120_000),
        pendingItem('earlier', Date.now() + 60_000),
        pendingItem('firing', Date.now() - 1, { status: 'firing' })
    ];

    const result = await api.recoverScheduledMessages('startup');
    const items = await api.readScheduledMessages();

    assert.deepEqual(items.map((item) => item.id), ['firing', 'earlier', 'later']);
    assert.equal(items.find((item) => item.id === 'firing').status, 'failed');
    assert.match(items.find((item) => item.id === 'firing').failureReason, /background restart/);
    assert.equal(result.length, 0);
    assert.ok(alarms.has('scheduled-msg:earlier'));
    assert.ok(alarms.has('scheduled-msg:later'));
    assert.equal(alarms.has('scheduled-msg:firing'), false);
});

test('duplicate alarm claims are idempotent', async () => {
    storage.scheduledMessages = [pendingItem('once')];

    const first = await api.claimScheduledMessageForFire('once');
    const second = await api.claimScheduledMessageForFire('once');

    assert.equal(first.id, 'once');
    assert.equal(second, null);
    assert.equal((await api.readScheduledMessages())[0].status, 'firing');
});

test('due messages enter the existing busy queue once and become completed', async () => {
    addTab(7);
    storage.scheduledMessages = [pendingItem('busy')];
    api.jobs.set(7, {
        tabId: 7,
        queue: ['already queued'],
        currentMessage: null,
        isRunning: false,
        isPaused: true,
        completedCount: 0,
        totalMessages: 1,
        updatedAt: Date.now()
    });

    const first = await api.processDueScheduledMessages('alarm', null, Date.now());
    const second = await api.processDueScheduledMessages('duplicate-alarm', null, Date.now());
    const item = (await api.readScheduledMessages())[0];

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(item.status, 'completed');
    assert.deepEqual(api.jobs.get(7).queue, ['already queued', 'message-busy']);
});

test('changed conversation fails closed without sending to another chat', async () => {
    addTab(7, {
        provider: 'chatgpt',
        type: 'existing',
        conversationId: 'different-conversation',
        key: 'chatgpt:c:different-conversation'
    });
    storage.scheduledMessages = [pendingItem('mismatch')];

    const result = await api.processDueScheduledMessages('alarm', null, Date.now());
    const item = (await api.readScheduledMessages())[0];

    assert.equal(result[0].status, 'failed');
    assert.equal(item.status, 'failed');
    assert.match(item.failureReason, /not sent to another chat/);
    assert.equal(api.jobs.size, 0);
});

test('cancel and delete clear scheduled delivery state', async () => {
    addTab(7);
    storage.scheduledMessages = [pendingItem('cancel-me', Date.now() + 60_000)];
    alarms.set('scheduled-msg:cancel-me', { when: Date.now() + 60_000 });

    const cancelled = await api.cancelScheduledMessage('cancel-me');
    assert.equal(cancelled.ok, true);
    assert.equal((await api.readScheduledMessages())[0].status, 'cancelled');
    assert.equal(alarms.has('scheduled-msg:cancel-me'), false);

    const deleted = await api.deleteScheduledMessage('cancel-me');
    assert.equal(deleted.ok, true);
    assert.deepEqual(await api.readScheduledMessages(), []);
});

test('schedule identity matching rejects provider and conversation changes', () => {
    const stored = { ...identity, conversationType: identity.type, targetKey: identity.key };
    assert.equal(api.identitiesMatchForSchedule(stored, identity), true);
    assert.equal(api.identitiesMatchForSchedule(stored, { ...identity, provider: 'claude' }), false);
    assert.equal(api.identitiesMatchForSchedule(stored, { ...identity, conversationId: 'other', key: 'chatgpt:c:other' }), false);
    assert.equal(api.identitiesMatchForSchedule(identity, { provider: 'chatgpt', type: 'unsupported', key: 'unsupported' }), false);
});
