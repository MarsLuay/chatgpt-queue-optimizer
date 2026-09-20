const test = require('node:test');
const assert = require('node:assert/strict');

const mockTabs = new Map();
const mockStorageLocal = {};
let mockSyncStorage = {
    queueUnlimitedRetryWait: false,
    queueDeepResearchAware: true,
    queueDeliveryTimeoutRefresh: true
};

global.chrome = {
    runtime: {
        lastError: null,
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        getURL: () => '',
        sendMessage: (_message, callback) => callback && callback()
    },
    browserAction: {
        onClicked: { addListener: () => {} }
    },
    commands: {
        onCommand: { addListener: () => {} }
    },
    storage: {
        sync: {
            get: (defaults, callback) => callback && callback({ ...defaults, ...mockSyncStorage }),
            set: (items, callback) => {
                Object.assign(mockSyncStorage, items);
                callback && callback();
            }
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
            const tab = mockTabs.get(tabId) || { id: tabId, url: 'https://chatgpt.com/' };
            callback && callback(tab);
            return Promise.resolve(tab);
        },
        update: (tabId, props, callback) => {
            const current = mockTabs.get(tabId) || { id: tabId };
            const next = { ...current, ...props, id: tabId };
            mockTabs.set(tabId, next);
            callback && callback(next);
            return Promise.resolve(next);
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
        executeScript: () => Promise.resolve([{ result: { ok: true, details: {} } }])
    }
};

require('../utils.js');

const {
    jobs,
    waitForTabResponse,
    retryCurrentCommandIfEnabled,
    classifyQueueFailure,
    handleConversationCapacityRollover,
    isConversationCapacityFailure,
    validateJobTargetConversation,
    restoreDurableJobs,
    getDurableJobsState,
    getRunningJobsSnapshot,
    QUEUE_WAIT_POLICY,
    QUEUE_RETRY_POLICY
} = require('../background.js');

function muteConsole() {
    const original = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info
    };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.info = () => {};
    return () => {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
        console.info = original.info;
    };
}

async function withWaitPolicy(overrides, fn) {
    const original = { ...QUEUE_WAIT_POLICY };
    Object.assign(QUEUE_WAIT_POLICY, overrides);
    try {
        return await fn();
    } finally {
        Object.assign(QUEUE_WAIT_POLICY, original);
    }
}

function createJob(tabId, overrides = {}) {
    return {
        tabId,
        provider: 'chatgpt',
        conversationId: `old-chat-${tabId}`,
        conversationType: 'existing',
        targetKey: `chatgpt:c:old-chat-${tabId}`,
        queue: ['Apply the same process to topic #33', 'topic-34'],
        currentMessage: 'current-unresolved-command',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        pausedReason: '',
        lastError: '',
        runId: `run-${tabId}`,
        totalMessages: 3,
        completedCount: 11,
        currentCommandNumber: 12,
        currentPhase: 'awaiting-response',
        waitForIdleBeforeSend: false,
        deliveryTimeoutAttempts: 0,
        retryAttemptCount: 1,
        lastRetryableReason: 'generation-error',
        retryClass: 'generation-error',
        retryMode: 'finite',
        nextRetryDelayMs: 0,
        nextRetryAt: 0,
        retryExhausted: false,
        waitStartedAt: 0,
        lastResearchProgressAt: 0,
        sawDeepResearch: false,
        sawGenerating: true,
        deliveryState: 'confirmed-submission',
        commandId: `run-${tabId}:12`,
        commandFingerprint: 'old-command',
        submittedUserTurnId: 'user-old',
        assistantTurnId: null,
        submissionAckSource: 'user-turn',
        terminalAckSource: '',
        lastResponsePhase: 'error',
        rolloverInProgress: false,
        conversationGeneration: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides
    };
}

function installTab(tabId, { url, handoffTurnId = 'handoff-user-1' } = {}) {
    const tabState = { sent: false };
    const previousExecute = chrome.scripting.executeScript;
    chrome.scripting.executeScript = async (details) => {
        tabState.sent = true;
        if (typeof previousExecute === 'function') {
            try {
                return await previousExecute(details);
            } catch {
                // Fall through to a successful queued-send result.
            }
        }
        return [{ result: { ok: true, details: {} } }];
    };
    mockTabs.set(tabId, {
        id: tabId,
        url: url || `https://chatgpt.com/c/old-chat-${tabId}`,
        onMessage: (message) => {
            if (message.type === 'CHECK_GENERATION_STATE') {
                return {
                    state: {
                        generating: false,
                        hasError: false,
                        conversationCapacityReached: false,
                        requiresNewConversation: false
                    },
                    responseState: { phase: '' }
                };
            }
            if (message.type === 'GET_COMMAND_TURN_SNAPSHOT') {
                if (tabState.sent && String(message.expectedText || '').includes('Continuation handoff')) {
                    return {
                        ok: true,
                        snapshot: {
                            userTurns: [{
                                turnId: handoffTurnId,
                                index: 0,
                                fingerprint: 'handoff',
                                matchedExpected: true
                            }],
                            assistantTurns: [],
                            latestUserTurnId: handoffTurnId,
                            matchedUserTurnId: handoffTurnId,
                            conversationId: null
                        }
                    };
                }
                return {
                    ok: true,
                    snapshot: {
                        userTurns: [],
                        assistantTurns: [],
                        latestUserTurnId: null,
                        matchedUserTurnId: null
                    }
                };
            }
            return { ok: true };
        }
    });
    return tabState;
}

test('conversation-max-length is a non-retryable capacity failure', async () => {
    const restoreConsole = muteConsole();
    const classified = classifyQueueFailure(
        'wait',
        'ChatGPT conversation reached maximum length.',
        {
            failureClass: 'conversation-max-length',
            conversationCapacityReached: true,
            state: { conversationCapacityReached: true, hasError: true, matchedError: 'conversation-max-length' }
        }
    );
    assert.equal(classified.class, 'conversation-max-length');
    assert.equal(classified.retryable, false);
    assert.equal(isConversationCapacityFailure({
        ok: false,
        details: { failureClass: 'conversation-max-length', conversationCapacityReached: true }
    }), true);

    const tabId = 5101;
    const job = createJob(tabId);
    jobs.set(tabId, job);
    const retried = await retryCurrentCommandIfEnabled(
        tabId,
        job,
        'wait',
        'ChatGPT conversation reached maximum length.',
        { failureClass: 'conversation-max-length', state: { conversationCapacityReached: true } }
    );
    assert.equal(retried, false);
    assert.equal(job.retryAttemptCount, 1);
    assert.equal(job.currentMessage, 'current-unresolved-command');
    jobs.clear();
    restoreConsole();
});

test('waitForTabResponse reports conversation-max-length before a generic error', async () => {
    const restoreConsole = muteConsole();
    const tabId = 5102;
    const job = createJob(tabId, { queue: [] });
    jobs.set(tabId, job);
    mockTabs.set(tabId, {
        id: tabId,
        url: 'https://chatgpt.com/c/old-chat-5102',
        onMessage: (message) => {
            if (message.type === 'CHECK_GENERATION_STATE') {
                return {
                    state: {
                        generating: false,
                        hasError: true,
                        hasTryAgainButton: true,
                        conversationCapacityReached: true,
                        requiresNewConversation: true,
                        matchedError: 'conversation-max-length'
                    },
                    responseState: { phase: 'error', source: 'conversation-max-length' }
                };
            }
            return { ok: true };
        }
    });

    const result = await waitForTabResponse(tabId, {
        commandNumber: 12,
        totalMessages: 12,
        queueSettings: { queueUnlimitedRetryWait: false, queueDeepResearchAware: true },
        maxWaitMs: 200,
        checkIntervalMs: 20
    });
    assert.equal(result.ok, false);
    assert.equal(result.details.failureClass, 'conversation-max-length');
    assert.equal(result.details.conversationCapacityReached, true);
    assert.match(result.error, /maximum length/i);
    jobs.clear();
    restoreConsole();
});

test('ordinary unexpected navigation stays fail-closed while rollover rebind is authorized', async () => {
    const restoreConsole = muteConsole();
    const tabId = 5103;
    mockTabs.set(tabId, { id: tabId, url: 'https://chatgpt.com/c/other-chat' });
    const ordinary = await validateJobTargetConversation(tabId, {
        provider: 'chatgpt',
        conversationId: 'old-chat-5103',
        conversationType: 'existing',
        targetKey: 'chatgpt:c:old-chat-5103',
        rolloverInProgress: false
    });
    assert.equal(ordinary.ok, false);
    assert.match(ordinary.reason, /Conversation mismatch/);

    const rolling = {
        provider: 'chatgpt',
        conversationId: 'old-chat-5103',
        conversationType: 'existing',
        targetKey: 'chatgpt:c:old-chat-5103',
        rolloverInProgress: true,
        rolloverFromConversationId: 'old-chat-5103',
        rolloverRebindApplied: false
    };
    mockTabs.set(tabId, { id: tabId, url: 'https://chatgpt.com/c/old-chat-5103' });
    const waiting = await validateJobTargetConversation(tabId, rolling);
    assert.equal(waiting.ok, false);
    assert.equal(waiting.awaitingRollover, true);

    mockTabs.set(tabId, { id: tabId, url: 'https://chatgpt.com/' });
    const rebound = await validateJobTargetConversation(tabId, rolling);
    assert.equal(rebound.ok, true);
    assert.equal(rebound.rolloverRebind, true);
    assert.equal(rolling.conversationType, 'new');
    assert.equal(rolling.conversationGeneration, 1);
    restoreConsole();
});

test('capacity rollover preserves FIFO, sends a bounded handoff, and does not count it complete', async () => {
    const restoreConsole = muteConsole();
    const tabId = 5104;
    const job = createJob(tabId);
    jobs.set(tabId, job);
    installTab(tabId);

    await withWaitPolicy({
        submissionAckTimeoutMs: 250,
        submissionAckPollMs: 15,
        checkIntervalMs: 15,
        responseMaxWaitMs: 400,
        terminalConfirmSamples: 1
    }, async () => {
        const result = await handleConversationCapacityRollover(tabId, job, {
            ok: false,
            details: { failureClass: 'conversation-max-length', conversationCapacityReached: true }
        });
        assert.equal(result.action, 'continue');
        assert.equal(job.rolloverInProgress, false);
        assert.equal(job.currentPhase, 'queued');
        assert.equal(job.completedCount, 11);
        assert.equal(job.conversationGeneration, 1);
        assert.equal(job.currentMessage, null);
        assert.equal(job.queue[0], 'current-unresolved-command');
        assert.equal(job.queue[1], 'Apply the same process to topic #33');
        assert.equal(job.queue[2], 'topic-34');
        assert.equal(job.retryAttemptCount, 0);
        assert.equal(job.conversationType, 'new');
        assert.equal(mockTabs.get(tabId).url, 'https://chatgpt.com/');

        const snapshot = getRunningJobsSnapshot()[tabId];
        assert.equal(snapshot.currentPhase, 'queued');
        assert.equal(snapshot.conversationGeneration, 1);
        assert.equal(snapshot.hasCurrentMessage, false);

        const durable = getDurableJobsState()[tabId];
        assert.equal(durable.queue[0], 'current-unresolved-command');
        assert.equal(durable.completedCount, 11);
        assert.equal(durable.queue.includes('Apply the same process to topic #33'), true);

        await new Promise((resolve) => {
            setTimeout(resolve, 80);
        });
        const debugLogs = JSON.stringify(mockStorageLocal.queueDebugLogs || []);
        assert.equal(debugLogs.includes('Apply the same process to topic #33'), false);
        assert.equal(debugLogs.includes('current-unresolved-command'), false);
        assert.equal(debugLogs.includes('Continuation handoff for an automated'), false);
    });

    jobs.clear();
    restoreConsole();
});

test('worker restart during rollover does not open a second replacement chat', async () => {
    const restoreConsole = muteConsole();
    const tabId = 5105;
    installTab(tabId, { url: 'https://chatgpt.com/' });
    const restored = restoreDurableJobs({
        [tabId]: {
            tabId,
            provider: 'chatgpt',
            conversationId: 'old-chat-5105',
            conversationType: 'existing',
            targetKey: 'chatgpt:c:old-chat-5105',
            queue: ['next-after-current'],
            currentMessage: 'pending-once',
            isRunning: true,
            isPaused: false,
            runId: 'run-5105',
            totalMessages: 13,
            completedCount: 11,
            currentCommandNumber: 12,
            currentPhase: 'rollover-in-progress',
            rolloverInProgress: true,
            rolloverStage: 'awaiting-new-identity',
            rolloverReason: 'conversation-max-length',
            rolloverFromConversationId: 'old-chat-5105',
            rolloverNavigationStarted: true,
            rolloverRebindApplied: false,
            handoffSubmitted: false,
            conversationGeneration: 0
        }
    });
    assert.equal(restored.length, 1);
    jobs.set(tabId, restored[0]);
    const job = restored[0];
    let updateCount = 0;
    const originalUpdate = chrome.tabs.update;
    chrome.tabs.update = (id, props, callback) => {
        updateCount += 1;
        return originalUpdate(id, props, callback);
    };

    await withWaitPolicy({
        submissionAckTimeoutMs: 250,
        submissionAckPollMs: 15,
        checkIntervalMs: 15,
        responseMaxWaitMs: 400,
        terminalConfirmSamples: 1
    }, async () => {
        const result = await handleConversationCapacityRollover(tabId, job);
        assert.equal(result.action, 'continue');
        assert.equal(updateCount, 0);
        assert.equal(job.queue[0], 'pending-once');
        assert.equal(job.completedCount, 11);
        assert.equal(job.conversationGeneration, 1);
    });

    chrome.tabs.update = originalUpdate;
    jobs.clear();
    restoreConsole();
});

test('restart after handoff submission does not duplicate the pending command or handoff', async () => {
    const restoreConsole = muteConsole();
    const tabId = 5106;
    installTab(tabId, { url: 'https://chatgpt.com/', handoffTurnId: 'handoff-user-restart' });
    const restored = restoreDurableJobs({
        [tabId]: {
            tabId,
            provider: 'chatgpt',
            conversationId: null,
            conversationType: 'new',
            targetKey: 'chatgpt:new',
            queue: ['kept-second'],
            currentMessage: 'pending-once',
            isRunning: true,
            isPaused: false,
            runId: 'run-5106',
            totalMessages: 13,
            completedCount: 4,
            currentCommandNumber: 5,
            currentPhase: 'rollover-in-progress',
            rolloverInProgress: true,
            rolloverStage: 'handoff-waiting',
            rolloverReason: 'conversation-max-length',
            rolloverFromConversationId: 'old-chat-5106',
            rolloverNavigationStarted: true,
            rolloverRebindApplied: true,
            handoffSubmitted: true,
            handoffEstablished: false,
            conversationGeneration: 1
        }
    });
    jobs.set(tabId, restored[0]);
    const job = restored[0];
    let executeCount = 0;
    const originalExecute = chrome.scripting.executeScript;
    chrome.scripting.executeScript = async () => {
        executeCount += 1;
        return [{ result: { ok: true, details: {} } }];
    };

    await withWaitPolicy({
        submissionAckTimeoutMs: 250,
        submissionAckPollMs: 15,
        checkIntervalMs: 15,
        responseMaxWaitMs: 400,
        terminalConfirmSamples: 1
    }, async () => {
        const result = await handleConversationCapacityRollover(tabId, job);
        assert.equal(result.action, 'continue');
        assert.equal(executeCount, 0);
        assert.equal(job.queue.filter((message) => message === 'pending-once').length, 1);
        assert.equal(job.queue[0], 'pending-once');
        assert.equal(job.completedCount, 4);
    });

    chrome.scripting.executeScript = originalExecute;
    jobs.clear();
    restoreConsole();
});

test('sequential rollovers increment conversation generation and keep the same run', async () => {
    const restoreConsole = muteConsole();
    const tabId = 5107;
    const job = createJob(tabId, {
        conversationId: 'seg-0',
        targetKey: 'chatgpt:c:seg-0',
        completedCount: 2,
        currentCommandNumber: 3,
        queue: ['fourth']
    });
    jobs.set(tabId, job);

    await withWaitPolicy({
        submissionAckTimeoutMs: 250,
        submissionAckPollMs: 15,
        checkIntervalMs: 15,
        responseMaxWaitMs: 400,
        terminalConfirmSamples: 1
    }, async () => {
        installTab(tabId, { url: 'https://chatgpt.com/c/seg-0', handoffTurnId: 'handoff-a' });
        await handleConversationCapacityRollover(tabId, job);
        assert.equal(job.conversationGeneration, 1);
        assert.equal(job.runId, 'run-5107');
        job.conversationId = 'seg-1';
        job.conversationType = 'existing';
        job.targetKey = 'chatgpt:c:seg-1';
        job.currentMessage = job.queue.shift();
        job.currentCommandNumber = 3;
        installTab(tabId, { url: 'https://chatgpt.com/c/seg-1', handoffTurnId: 'handoff-b' });
        await handleConversationCapacityRollover(tabId, job);
        assert.equal(job.conversationGeneration, 2);
        assert.equal(job.runId, 'run-5107');
        assert.equal(job.completedCount, 2);
        assert.equal(job.queue[0], 'current-unresolved-command');
    });

    jobs.clear();
    restoreConsole();
});
