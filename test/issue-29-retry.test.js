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
    getRetryBackoffDelayMs,
    handleRetryPausedJob,
    completeCurrentCommand,
    pauseJob,
    restoreDurableJobs,
    getDurableJobsState,
    getRunningJobsSnapshot,
    flushQueueDebugLogs,
    QUEUE_RETRY_POLICY,
    QUEUE_WAIT_POLICY,
    QUEUE_SETTINGS_DEFAULTS,
    UNLIMITED_RETRY_DELAY_MS
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

async function withRetryPolicy(overrides, fn) {
    const original = { ...QUEUE_RETRY_POLICY };
    Object.assign(QUEUE_RETRY_POLICY, overrides);
    try {
        return await fn();
    } finally {
        Object.assign(QUEUE_RETRY_POLICY, original);
    }
}

function createJob(tabId, overrides = {}) {
    return {
        tabId,
        provider: 'chatgpt',
        conversationId: `issue-29-${tabId}`,
        conversationType: 'existing',
        targetKey: `chatgpt:c:issue-29-${tabId}`,
        queue: ['next-command'],
        currentMessage: 'retry-me',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        pausedReason: '',
        lastError: '',
        runId: `run-${tabId}`,
        totalMessages: 2,
        completedCount: 0,
        currentCommandNumber: 1,
        currentPhase: 'waiting',
        waitForIdleBeforeSend: false,
        deliveryTimeoutAttempts: 0,
        retryAttemptCount: 0,
        lastRetryableReason: '',
        retryClass: '',
        retryMode: '',
        nextRetryDelayMs: 0,
        nextRetryAt: 0,
        retryExhausted: false,
        waitStartedAt: 0,
        lastResearchProgressAt: 0,
        sawDeepResearch: false,
        sawGenerating: false,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides
    };
}

function generationState(overrides = {}) {
    return {
        generating: false,
        hasError: false,
        hasTryAgainButton: false,
        hasDeliveryTimedOut: false,
        deepResearchActive: false,
        researchStatusPreview: '',
        matchedError: '',
        ...overrides
    };
}

function installTab(tabId, getState, getResponseState = () => null) {
    mockTabs.set(tabId, {
        id: tabId,
        url: `https://chatgpt.com/c/issue-29-${tabId}`,
        onMessage: (message) => {
            if (message.type === 'CHECK_GENERATION_STATE') {
                return { state: getState(), responseState: getResponseState() };
            }
            return { ok: true };
        }
    });
}

async function waitContext(tabId, overrides = {}) {
    return waitForTabResponse(tabId, {
        commandNumber: 1,
        totalMessages: 1,
        queueSettings: {
            queueUnlimitedRetryWait: false,
            queueDeepResearchAware: true,
            queueDeliveryTimeoutRefresh: true
        },
        maxWaitMs: 80,
        deepResearchMaxWaitMs: 220,
        deepResearchStaleMs: 90,
        checkIntervalMs: 20,
        ...overrides
    });
}

test('classifyQueueFailure covers retryable and non-retryable classes from generation state', () => {
    assert.equal(
        classifyQueueFailure('wait', 'Queue was stopped.', { failureClass: 'user-stop' }).class,
        'user-stop'
    );
    assert.equal(
        classifyQueueFailure('wait', 'Queue was stopped.').retryable,
        false
    );

    const compatibility = classifyQueueFailure(
        'send',
        'ChatGPT compatibility failure: required composer signal was not found.',
        { compatibilityFailure: 'composer' }
    );
    assert.equal(compatibility.class, 'compatibility');
    assert.equal(compatibility.retryable, false);

    const retryVisible = classifyQueueFailure('wait', 'ChatGPT showed an error or retry state.', {
        state: generationState({ hasTryAgainButton: true, hasError: true })
    });
    assert.equal(retryVisible.class, 'retry-visible');
    assert.equal(retryVisible.retryable, true);

    const generationError = classifyQueueFailure('wait', 'ChatGPT showed an error or retry state.', {
        state: generationState({ hasError: true, matchedError: 'something went wrong' })
    });
    assert.equal(generationError.class, 'generation-error');
    assert.equal(generationError.retryable, true);

    const timeout = classifyQueueFailure('wait', 'Timed out waiting for ChatGPT response.', {
        failureClass: 'timeout'
    });
    assert.equal(timeout.class, 'timeout');
    assert.equal(timeout.retryable, true);

    const stalled = classifyQueueFailure('wait', 'Deep Research stalled without progress.', {
        stalledResearch: true
    });
    assert.equal(stalled.class, 'stalled-research');
    assert.equal(stalled.retryable, true);

    const transient = classifyQueueFailure('wait', 'Could not read ChatGPT tab.', {
        error: { message: 'Could not read ChatGPT tab.' }
    });
    assert.equal(transient.class, 'transient');
    assert.equal(transient.retryable, true);
});

test('finite retry backoff increases and respects the cap', () => {
    const first = getRetryBackoffDelayMs(0, false);
    const second = getRetryBackoffDelayMs(1, false);
    const third = getRetryBackoffDelayMs(2, false);
    assert.ok(first > 0);
    assert.ok(second > first);
    assert.ok(third > second);

    const capped = getRetryBackoffDelayMs(20, false);
    assert.equal(capped, QUEUE_RETRY_POLICY.backoffMaxMs);

    const unlimited = getRetryBackoffDelayMs(99, true);
    assert.equal(unlimited, UNLIMITED_RETRY_DELAY_MS);
    assert.ok(unlimited > 0);
});

test('success-after-retry requeues the same command and resets after completion', async () => {
    const restoreConsole = muteConsole();
    const tabId = 2901;
    const job = createJob(tabId);
    jobs.set(tabId, job);

    await withRetryPolicy({ backoffBaseMs: 15, backoffMaxMs: 20, sleepSliceMs: 5 }, async () => {
        const retried = await retryCurrentCommandIfEnabled(
            tabId,
            job,
            'wait',
            'ChatGPT showed an error or retry state.',
            { state: generationState({ hasError: true, hasTryAgainButton: true }) }
        );

        assert.equal(retried, true);
        assert.equal(job.retryAttemptCount, 1);
        assert.equal(job.retryMode, 'finite');
        assert.equal(job.queue[0], 'retry-me');
        assert.equal(job.currentMessage, null);
        assert.equal(job.queue.filter((message) => message === 'retry-me').length, 1);

        job.currentMessage = job.queue.shift();
        job.currentCommandNumber = 1;
        completeCurrentCommand(tabId, job, 2, { recoveredAfterRetry: true });
        assert.equal(job.retryAttemptCount, 0);
        assert.equal(job.currentMessage, null);
        assert.equal(job.lastRetryableReason, '');
    });

    jobs.clear();
    restoreConsole();
});

test('finite retry exhausts exactly at the default attempt limit', async () => {
    const restoreConsole = muteConsole();
    const tabId = 2902;
    const job = createJob(tabId, { queue: [] });
    jobs.set(tabId, job);

    await withRetryPolicy({ backoffBaseMs: 10, backoffMaxMs: 15, sleepSliceMs: 5 }, async () => {
        for (let attempt = 0; attempt < QUEUE_RETRY_POLICY.maxAutomaticAttempts; attempt += 1) {
            job.currentMessage = 'retry-me';
            job.currentCommandNumber = 1;
            const retried = await retryCurrentCommandIfEnabled(
                tabId,
                job,
                'wait',
                'Timed out waiting for ChatGPT response.',
                { failureClass: 'timeout' }
            );
            assert.equal(retried, true, `retry ${attempt + 1} should run`);
        }

        job.currentMessage = 'retry-me';
        job.currentCommandNumber = 1;
        const exhausted = await retryCurrentCommandIfEnabled(
            tabId,
            job,
            'wait',
            'Timed out waiting for ChatGPT response.',
            { failureClass: 'timeout' }
        );
        assert.equal(exhausted, false);
        assert.equal(job.retryAttemptCount, QUEUE_RETRY_POLICY.maxAutomaticAttempts);
        assert.equal(job.retryExhausted, true);
        assert.match(job.lastError, /Automatic retry exhausted after 3 attempts/);
        assert.match(job.lastError, /Timed out waiting for ChatGPT response/);
    });

    jobs.clear();
    restoreConsole();
});

test('assistant error stop settles after bounded retries without dropping queued work', async () => {
    const restoreConsole = muteConsole();
    const tabId = 2968;
    const job = createJob(tabId, {
        queue: ['y'],
        currentMessage: 'x',
        totalMessages: 2,
        currentPhase: 'awaiting-response',
        deliveryState: 'confirmed-submission',
        submittedUserTurnId: 'user-error-stop'
    });
    jobs.set(tabId, job);

    await withRetryPolicy({ backoffBaseMs: 1, backoffMaxMs: 2, sleepSliceMs: 1, maxAutomaticAttempts: 2 }, async () => {
        for (let attempt = 0; attempt < QUEUE_RETRY_POLICY.maxAutomaticAttempts; attempt += 1) {
            const retried = await retryCurrentCommandIfEnabled(
                tabId,
                job,
                'wait',
                'ChatGPT showed an error or retry state.',
                {
                    failureClass: 'generation-error',
                    responseState: { source: 'assistant-error-stop' }
                }
            );
            assert.equal(retried, true);
            assert.equal(job.currentMessage, 'x');
            assert.deepEqual(job.queue, ['y']);
        }

        const exhausted = await retryCurrentCommandIfEnabled(
            tabId,
            job,
            'wait',
            'ChatGPT showed an error or retry state.',
            {
                failureClass: 'generation-error',
                responseState: { source: 'assistant-error-stop' }
            }
        );

        assert.equal(exhausted, false);
        assert.equal(job.retryAttemptCount, 2);
        assert.equal(job.retryExhausted, true);
        assert.match(job.lastError, /Automatic retry exhausted after 2 attempts/);

        pauseJob(tabId, job.lastError, {
            phase: 'wait',
            retryClass: job.retryClass,
            retryAttemptCount: job.retryAttemptCount,
            diagnostics: { responseState: { source: 'assistant-error-stop' } }
        });

        assert.equal(job.isPaused, true);
        assert.equal(job.completedCount, 0);
        assert.equal(job.currentMessage, 'x');
        assert.deepEqual(job.queue, ['y']);

        const snapshot = getRunningJobsSnapshot()[tabId];
        assert.equal(snapshot.currentMessage, undefined);
        assert.equal(snapshot.currentMessageLength, 1);
    });

    jobs.clear();
    restoreConsole();
});

test('repeated assistant error stops preserve terminal diagnostics without private data', async () => {
    const restoreConsole = muteConsole();
    const tabId = 2969;
    const promptMarker = 'CQO-ISSUE-69-PRIVATE-PROMPT';
    const contentMarker = 'CQO-ISSUE-69-CONVERSATION-CONTENT';
    const credentialMarker = 'CQO-ISSUE-69-CREDENTIAL';
    const tokenMarker = 'CQO-ISSUE-69-TOKEN';
    const privatePath = 'C:\\private\\assistant-error.log';
    const job = createJob(tabId, {
        queue: ['next-command'],
        currentMessage: promptMarker,
        totalMessages: 2,
        currentPhase: 'awaiting-response',
        deliveryState: 'confirmed-submission',
        submittedUserTurnId: 'user-error-stop-69'
    });
    jobs.set(tabId, job);
    installTab(tabId, () => ({
        ...generationState({
            hasError: true,
            matchedError: 'assistant-error-stop',
            conversationContent: contentMarker,
            credentials: credentialMarker,
            accessToken: tokenMarker,
            privatePath,
            url: `https://chatgpt.com/c/private-69?token=${tokenMarker}`,
            title: contentMarker
        }),
        prompt: promptMarker
    }), () => ({
        phase: 'error',
        source: 'assistant-error-stop',
        userTurnId: 'user-error-stop-69'
    }));

    await withRetryPolicy({ backoffBaseMs: 1, backoffMaxMs: 2, sleepSliceMs: 1, maxAutomaticAttempts: 2 }, async () => {
        const waitResult = await waitContext(tabId, {
            commandBinding: { userTurnId: 'user-error-stop-69' }
        });

        assert.equal(waitResult.ok, false);
        assert.equal(waitResult.details.failureClass, 'generation-error');
        assert.equal(waitResult.details.responseState.source, 'assistant-error-stop');

        for (let attempt = 0; attempt < QUEUE_RETRY_POLICY.maxAutomaticAttempts; attempt += 1) {
            job.currentMessage = promptMarker;
            job.currentCommandNumber = 1;
            const retried = await retryCurrentCommandIfEnabled(
                tabId,
                job,
                'wait',
                waitResult.error,
                waitResult.details
            );
            assert.equal(retried, true);
            assert.equal(job.currentMessage, promptMarker);
            assert.deepEqual(job.queue, ['next-command']);
        }

        const exhausted = await retryCurrentCommandIfEnabled(
            tabId,
            job,
            'wait',
            waitResult.error,
            waitResult.details
        );
        assert.equal(exhausted, false);
        assert.equal(job.retryExhausted, true);
        assert.match(job.lastError, /Automatic retry exhausted after 2 attempts/);

        pauseJob(tabId, job.lastError, {
            phase: 'wait',
            retryClass: job.retryClass,
            retryAttemptCount: job.retryAttemptCount,
            diagnostics: waitResult.details
        });
        await flushQueueDebugLogs();

        assert.equal(job.isPaused, true);
        assert.equal(job.completedCount, 0);
        assert.equal(job.currentMessage, promptMarker);
        assert.deepEqual(job.queue, ['next-command']);

        const serializedLogs = JSON.stringify(mockStorageLocal.queueDebugLogs || []);
        for (const marker of [promptMarker, contentMarker, credentialMarker, tokenMarker, privatePath]) {
            assert.equal(serializedLogs.includes(marker), false, marker);
        }
    });

    jobs.clear();
    mockTabs.delete(tabId);
    restoreConsole();
});

test('unlimited retry continues past the finite limit and stays interruptible', async () => {
    const restoreConsole = muteConsole();
    const tabId = 2903;
    mockSyncStorage.queueUnlimitedRetryWait = true;
    const job = createJob(tabId, { queue: [] });
    jobs.set(tabId, job);

    await withRetryPolicy({
        backoffBaseMs: 10,
        unlimitedDelayMs: 20,
        sleepSliceMs: 5
    }, async () => {
        job.retryAttemptCount = QUEUE_RETRY_POLICY.maxAutomaticAttempts;
        const retried = await retryCurrentCommandIfEnabled(
            tabId,
            job,
            'wait',
            'ChatGPT showed an error or retry state.',
            { state: generationState({ hasError: true }) }
        );
        assert.equal(retried, true);
        assert.equal(job.retryMode, 'unlimited');
        assert.ok(job.retryAttemptCount > QUEUE_RETRY_POLICY.maxAutomaticAttempts);

        job.currentMessage = 'retry-me';
        job.queue = [];
        const retryPromise = retryCurrentCommandIfEnabled(
            tabId,
            job,
            'wait',
            'ChatGPT showed an error or retry state.',
            { state: generationState({ hasError: true }) }
        );
        job.isStopped = true;
        job.isRunning = false;
        const stopped = await retryPromise;
        assert.equal(stopped, false);
        assert.equal(job.currentMessage, 'retry-me');
        assert.equal(job.queue.includes('retry-me'), false);
    });

    mockSyncStorage.queueUnlimitedRetryWait = false;
    jobs.clear();
    restoreConsole();
});

test('queueDeepResearchAware cannot disable all wait limits by itself', { timeout: 4000 }, async () => {
    const restoreConsole = muteConsole();
    const tabId = 2904;
    const job = createJob(tabId, { currentPhase: 'waiting' });
    jobs.set(tabId, job);
    installTab(tabId, () => generationState({
        generating: true,
        deepResearchActive: true,
        researchStatusPreview: 'Deep research is searching sources'
    }));

    const result = await waitContext(tabId, {
        queueSettings: {
            queueUnlimitedRetryWait: false,
            queueDeepResearchAware: true
        }
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Deep Research|timed out/i);
    assert.equal(result.details.sawDeepResearch, true);
    assert.notEqual(result.details.settings.queueUnlimitedRetryWait, true);

    jobs.clear();
    mockTabs.delete(tabId);
    restoreConsole();
});

test('continuing Deep Research may wait longer than an ordinary response', { timeout: 4000 }, async () => {
    const restoreConsole = muteConsole();
    const tabId = 2905;
    const job = createJob(tabId);
    jobs.set(tabId, job);
    const startedAt = Date.now();
    let polls = 0;

    installTab(tabId, () => {
        polls += 1;
        const elapsed = Date.now() - startedAt;
        const active = elapsed < 140;
        return generationState({
            generating: active,
            deepResearchActive: active,
            researchStatusPreview: active ? `Deep research step ${polls}` : 'done'
        });
    });

    const result = await waitContext(tabId, {
        maxWaitMs: 80,
        deepResearchMaxWaitMs: 400,
        deepResearchStaleMs: 300
    });

    assert.equal(result.ok, true);
    assert.ok(result.details.elapsedMs > 80);
    assert.equal(result.details.sawDeepResearch, true);

    jobs.clear();
    mockTabs.delete(tabId);
    restoreConsole();
});

test('stalled Deep Research fails with a specific reason under default finite settings', { timeout: 4000 }, async () => {
    const restoreConsole = muteConsole();
    const tabId = 2906;
    const job = createJob(tabId);
    jobs.set(tabId, job);
    installTab(tabId, () => generationState({
        generating: false,
        deepResearchActive: true,
        researchStatusPreview: 'Deep research is searching sources'
    }));

    const result = await waitContext(tabId, {
        maxWaitMs: 1000,
        deepResearchMaxWaitMs: 1000,
        deepResearchStaleMs: 70
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /stalled/i);
    assert.equal(result.details.stalledResearch, true);
    assert.equal(result.details.failureClass, 'stalled-research');

    jobs.clear();
    mockTabs.delete(tabId);
    restoreConsole();
});

test('stop during wait or backoff prevents later submission', { timeout: 4000 }, async () => {
    const restoreConsole = muteConsole();
    const tabId = 2907;
    const job = createJob(tabId, { queue: ['other'] });
    jobs.set(tabId, job);
    installTab(tabId, () => generationState({
        generating: true,
        deepResearchActive: true,
        researchStatusPreview: `tick ${Date.now()}`
    }));

    const waitPromise = waitContext(tabId, {
        maxWaitMs: 1000,
        deepResearchMaxWaitMs: 1000,
        deepResearchStaleMs: 1000
    });
    await new Promise((resolve) => {
        setTimeout(resolve, 40);
    });
    job.isStopped = true;
    job.isRunning = false;
    const waitResult = await waitPromise;
    assert.equal(waitResult.ok, false);
    assert.match(waitResult.error, /stopped/i);

    job.isStopped = false;
    job.isRunning = true;
    job.currentMessage = 'retry-me';
    job.queue = ['other'];

    const retryPromise = withRetryPolicy({
        backoffBaseMs: 200,
        sleepSliceMs: 10
    }, () => retryCurrentCommandIfEnabled(
        tabId,
        job,
        'wait',
        'Timed out waiting for ChatGPT response.',
        { failureClass: 'timeout' }
    ));
    await new Promise((resolve) => {
        setTimeout(resolve, 20);
    });
    job.isStopped = true;
    job.isRunning = false;
    const retried = await retryPromise;
    assert.equal(retried, false);
    assert.equal(job.currentMessage, 'retry-me');
    assert.deepEqual(job.queue, ['other']);

    jobs.clear();
    mockTabs.delete(tabId);
    restoreConsole();
});

test('non-retryable compatibility failures do not enter an automatic retry loop', async () => {
    const restoreConsole = muteConsole();
    const tabId = 2908;
    const job = createJob(tabId, { queue: [] });
    jobs.set(tabId, job);

    const retried = await retryCurrentCommandIfEnabled(
        tabId,
        job,
        'send',
        'ChatGPT compatibility failure: required composer signal was not found.',
        { compatibilityFailure: 'composer' }
    );

    assert.equal(retried, false);
    assert.equal(job.retryAttemptCount, 0);
    assert.equal(job.currentMessage, 'retry-me');
    assert.deepEqual(job.queue, []);
    assert.equal(classifyQueueFailure(
        'send',
        'ChatGPT compatibility failure: required composer signal was not found.',
        { compatibilityFailure: 'composer' }
    ).retryable, false);

    jobs.clear();
    restoreConsole();
});

test('durable recovery preserves retry budget and research wait state without duplicating the command', () => {
    const tabId = 2909;
    jobs.clear();
    jobs.set(tabId, createJob(tabId, {
        queue: ['next-command'],
        currentMessage: 'retry-me',
        currentPhase: 'retry-wait',
        retryAttemptCount: 2,
        lastRetryableReason: 'Timed out waiting for ChatGPT response.',
        retryClass: 'timeout',
        retryMode: 'finite',
        nextRetryDelayMs: 4000,
        nextRetryAt: Date.now() + 4000,
        waitStartedAt: 123,
        lastResearchProgressAt: 456,
        sawDeepResearch: true,
        sawGenerating: true
    }));

    const durable = getDurableJobsState();
    assert.equal(durable[tabId].retryAttemptCount, 2);
    assert.equal(durable[tabId].currentMessage, 'retry-me');
    assert.equal(durable[tabId].currentPhase, 'retry-wait');
    assert.equal(durable[tabId].sawDeepResearch, true);
    assert.equal(durable[tabId].waitStartedAt, 123);

    const snapshot = getRunningJobsSnapshot();
    assert.equal(snapshot[tabId].retryAttemptCount, 2);
    assert.equal(snapshot[tabId].lastError, '');

    jobs.clear();
    const restored = restoreDurableJobs(durable);
    assert.equal(restored.length, 1);
    const job = restored[0];
    assert.equal(job.currentMessage, 'retry-me');
    assert.equal(job.currentPhase, 'retry-wait');
    assert.equal(job.retryAttemptCount, 2);
    assert.equal(job.lastRetryableReason, 'Timed out waiting for ChatGPT response.');
    assert.equal(job.sawDeepResearch, true);
    assert.equal(job.waitStartedAt, 123);
    assert.equal(job.lastResearchProgressAt, 456);
    assert.deepEqual(job.queue, ['next-command']);
    assert.equal(job.queue.filter((message) => message === 'retry-me').length, 0);

    jobs.clear();
    restoreDurableJobs({
        2910: {
            tabId: 2910,
            provider: 'chatgpt',
            conversationId: 'waiting',
            conversationType: 'existing',
            targetKey: 'chatgpt:c:waiting',
            queue: [],
            currentMessage: 'keep-waiting',
            isRunning: true,
            currentPhase: 'waiting',
            retryAttemptCount: 1,
            waitStartedAt: 50,
            lastResearchProgressAt: 75,
            sawDeepResearch: true
        }
    });
    const waiting = jobs.get(2910);
    assert.equal(waiting.currentMessage, 'keep-waiting');
    assert.equal(waiting.currentPhase, 'waiting');
    assert.equal(waiting.retryAttemptCount, 1);
    assert.deepEqual(waiting.queue, []);

    jobs.clear();
});

test('manual retryPausedJob resumes the paused command once', () => {
    const restoreConsole = muteConsole();
    const tabId = 2911;
    const job = createJob(tabId, {
        currentMessage: 'retry-me',
        queue: ['next-command']
    });
    jobs.set(tabId, job);
    job.isProcessing = true;
    pauseJob(tabId, 'Automatic retry exhausted after 3 attempts: Timed out waiting for ChatGPT response.');
    assert.deepEqual(job.queue, ['retry-me', 'next-command']);
    assert.equal(job.currentMessage, null);

    let response = null;
    handleRetryPausedJob({ tabId }, (result) => {
        response = result;
    });

    assert.equal(response.ok, true);
    assert.equal(job.isPaused, false);
    assert.equal(job.isRunning, true);
    assert.deepEqual(job.queue, ['retry-me', 'next-command']);
    assert.equal(job.retryAttemptCount, 0);
    assert.equal(job.lastError, '');

    jobs.clear();
    restoreConsole();
});

test('exactly-once sending recovery still rewrites an unconfirmed command once', () => {
    jobs.clear();
    restoreDurableJobs({
        2912: {
            tabId: 2912,
            provider: 'chatgpt',
            conversationId: 'send-once',
            conversationType: 'existing',
            targetKey: 'chatgpt:c:send-once',
            queue: [],
            currentMessage: 'only-once',
            isRunning: true,
            currentPhase: 'sending',
            currentCommandNumber: 1,
            retryAttemptCount: 1
        }
    });
    const job = jobs.get(2912);
    assert.deepEqual(job.queue, ['only-once']);
    assert.equal(job.currentMessage, null);
    assert.equal(job.currentPhase, 'queued');
    assert.equal(job.retryAttemptCount, 1);
    jobs.clear();
});

test('recovered wait elapsed time is preserved so Deep Research cannot restart its budget', { timeout: 4000 }, async () => {
    const restoreConsole = muteConsole();
    const tabId = 2913;
    const job = createJob(tabId, {
        waitStartedAt: Date.now() - 250,
        lastResearchProgressAt: Date.now() - 250,
        sawDeepResearch: true
    });
    jobs.set(tabId, job);
    installTab(tabId, () => generationState({
        generating: true,
        deepResearchActive: true,
        researchStatusPreview: `Deep research ${Date.now()}`
    }));

    const result = await waitContext(tabId, {
        maxWaitMs: 1000,
        deepResearchMaxWaitMs: 80,
        deepResearchStaleMs: 1000
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Deep Research|timed out/i);

    jobs.clear();
    mockTabs.delete(tabId);
    restoreConsole();
});

test('queue defaults keep Deep Research aware and finite retry/wait', () => {
    assert.equal(QUEUE_SETTINGS_DEFAULTS.queueUnlimitedRetryWait, false);
    assert.equal(QUEUE_SETTINGS_DEFAULTS.queueDeepResearchAware, true);
    assert.equal(QUEUE_RETRY_POLICY.maxAutomaticAttempts, 3);
    assert.ok(QUEUE_WAIT_POLICY.deepResearchMaxWaitMs > QUEUE_WAIT_POLICY.responseMaxWaitMs);
    assert.ok(QUEUE_WAIT_POLICY.deepResearchStaleMs > 0);
});
