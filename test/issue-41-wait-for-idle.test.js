const test = require('node:test');
const assert = require('node:assert/strict');

const mockTabs = new Map();
const mockStorageLocal = {};
let executeScriptCount = 0;

global.chrome = {
    runtime: {
        lastError: null,
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        getURL: () => ''
    },
    commands: {
        onCommand: { addListener: () => {} }
    },
    storage: {
        sync: {
            get: (keys, callback) => callback && callback(keys || {}),
            set: (items, callback) => callback && callback()
        },
        local: {
            get: (keys, callback) => {
                const requested = Array.isArray(keys)
                    ? keys
                    : (typeof keys === 'object' && keys !== null ? Object.keys(keys) : [keys]);
                const result = {};
                for (const key of requested) {
                    if (key in mockStorageLocal) result[key] = mockStorageLocal[key];
                }
                callback && callback(result);
            },
            set: (items, callback) => {
                Object.assign(mockStorageLocal, items);
                callback && callback();
            }
        }
    },
    tabs: {
        onRemoved: { addListener: () => {} },
        get: (tabId, callback) => {
            const tab = mockTabs.get(tabId);
            callback && callback(tab);
            return Promise.resolve(tab);
        },
        sendMessage: (tabId, message, callback) => {
            const tab = mockTabs.get(tabId);
            const response = tab?.onMessage ? tab.onMessage(message) : { ok: true };
            callback && callback(response);
            return Promise.resolve(response);
        }
    },
    alarms: {
        onAlarm: { addListener: () => {} },
        create: () => {},
        clear: () => {}
    },
    scripting: {
        executeScript: (details, callback) => {
            executeScriptCount += 1;
            const result = [{ result: { ok: true, details: {} } }];
            callback && callback(result);
            return Promise.resolve(result);
        }
    }
};

require('../utils.js');

const {
    handleEnqueueMessage,
    handleStartSequence,
    jobs
} = require('../background.js');

async function waitUntil(predicate, timeoutMs = 6000) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            assert.fail('Timed out waiting for queue state.');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function runPopupStart({ mode, busy }) {
    const tabId = mode === 'enqueue' ? 601 : 602;
    let generationChecks = 0;

    mockTabs.set(tabId, {
        id: tabId,
        url: `https://chatgpt.com/c/issue-41-${mode}-${busy ? 'busy' : 'idle'}`,
        onMessage: (message) => {
            if (message.type === 'CHECK_GENERATION_STATE') {
                generationChecks += 1;
                return {
                    state: {
                        generating: busy && generationChecks === 1,
                        hasError: false,
                        hasTryAgainButton: false
                    }
                };
            }
            return { ok: true };
        }
    });

    jobs.clear();
    executeScriptCount = 0;
    let response = null;

    try {
        if (mode === 'enqueue') {
            handleEnqueueMessage({
                tabId,
                message: 'popup message',
                source: 'popup',
                waitForIdleBeforeStart: true
            }, null, (result) => { response = result; });
        } else {
            handleStartSequence({
                tabId,
                messages: ['sequence message'],
                waitForIdleBeforeStart: true
            }, (result) => { response = result; });
        }

        await waitUntil(() => response?.ok && jobs.has(tabId));

        const job = jobs.get(tabId);
        assert.equal(response.waitingForIdle, true);
        assert.equal(job.currentPhase, 'waiting-for-idle');
        assert.equal(job.waitForIdleBeforeSend, true);
        assert.equal(executeScriptCount, 0);

        if (busy) {
            await new Promise(resolve => setTimeout(resolve, 1100));
            assert.equal(executeScriptCount, 0, `${mode} steered a busy ChatGPT response`);
        }

        await waitUntil(() => executeScriptCount === 1);
    } finally {
        const job = jobs.get(tabId);
        if (job) {
            job.isStopped = true;
            job.isRunning = false;
        }
        jobs.clear();
        mockTabs.delete(tabId);
    }
}

test('popup enqueue and sequence starts use the canonical busy/idle wait path', async () => {
    for (const mode of ['enqueue', 'sequence']) {
        for (const busy of [true, false]) {
            await runPopupStart({ mode, busy });
        }
    }
});
