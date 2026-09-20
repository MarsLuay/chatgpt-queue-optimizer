const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mockTabs = new Map();
const mockStorageLocal = {};
let mockSyncStorage = {
    queueUnlimitedRetryWait: false,
    queueDeepResearchAware: true,
    queueDeliveryTimeoutRefresh: true
};
let executeScriptImpl = async () => [{ result: { ok: true, details: { clickOnly: true } } }];

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
            const tab = mockTabs.get(tabId) || { id: tabId, url: 'https://chatgpt.com/c/issue-43' };
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
            const promise = Promise.resolve().then(() => executeScriptImpl(details));
            if (callback) {
                promise.then(callback);
            }
            return promise;
        }
    }
};

require('../utils.js');

const {
    jobs,
    waitForTabResponse,
    sendPromptToSpecificTab,
    restoreDurableJobs,
    getDurableJobsState,
    completeCurrentCommand,
    pauseJob,
    handleStartSequence,
    classifyQueueFailure,
    QUEUE_WAIT_POLICY,
    QUEUE_RETRY_POLICY
} = require('../background.js');

const FIXTURE_COMMANDS = [
    '#25 first topic',
    '#26 second topic',
    '#27 third topic',
    '#28 fourth topic',
    '#29 fifth topic',
    '#30 sixth topic',
    '#31 seventh topic',
    '#32 eighth topic',
    '#33 ninth topic'
];

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

async function waitUntil(predicate, timeoutMs = 4000) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            assert.fail('Timed out waiting for queue state.');
        }
        await new Promise(resolve => { setTimeout(resolve, 10); });
    }
}

function withWaitPolicy(overrides, fn) {
    const original = { ...QUEUE_WAIT_POLICY };
    Object.assign(QUEUE_WAIT_POLICY, overrides);
    const finish = async () => {
        try {
            return await fn();
        } finally {
            Object.assign(QUEUE_WAIT_POLICY, original);
        }
    };
    return finish();
}

function createJob(tabId, overrides = {}) {
    return {
        tabId,
        provider: 'chatgpt',
        conversationId: `issue-43-${tabId}`,
        conversationType: 'existing',
        targetKey: `chatgpt:c:issue-43-${tabId}`,
        queue: ['next-command'],
        currentMessage: 'current-command',
        isRunning: true,
        isPaused: false,
        isStopped: false,
        pausedReason: '',
        lastError: '',
        runId: `run-${tabId}`,
        totalMessages: 2,
        completedCount: 0,
        currentCommandNumber: 1,
        currentPhase: 'awaiting-response',
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
        deliveryState: 'confirmed-submission',
        commandId: `run-${tabId}:1`,
        commandFingerprint: 'fnv1a:test:len:16',
        submittedUserTurnId: 'user-1',
        assistantTurnId: null,
        submissionAckSource: 'content-script',
        terminalAckSource: '',
        lastResponsePhase: '',
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

function responseState(overrides = {}) {
    return {
        phase: 'transient-idle',
        userTurnId: 'user-1',
        assistantTurnId: null,
        conversationId: 'issue-43',
        generating: false,
        deepResearchActive: false,
        hasCompletedAssistant: false,
        source: 'transient-idle',
        ...overrides
    };
}

function installTab(tabId, handler) {
    mockTabs.set(tabId, {
        id: tabId,
        url: `https://chatgpt.com/c/issue-43-${tabId}`,
        onMessage: handler
    });
}

function stopJob(tabId) {
    const job = jobs.get(tabId);
    if (job) {
        job.isStopped = true;
        job.isRunning = false;
    }
    jobs.delete(tabId);
    mockTabs.delete(tabId);
}

test('background source removes the assumed-complete wait path', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    assert.equal(source.includes('assuming it completed'), false);
    assert.equal(source.includes('assumedCompleteWithoutGeneratingIndicator'), false);
});

test('click alone never acknowledges submission', async () => {
    const restoreConsole = muteConsole();
    const tabId = 4301;
    await withWaitPolicy({ submissionAckTimeoutMs: 40, submissionAckPollMs: 10 }, async () => {
        executeScriptImpl = async () => [{ result: { ok: true, details: { sendButtonSelector: 'button[data-testid="send-button"]' } } }];
        installTab(tabId, (message) => {
            if (message.type === 'GET_COMMAND_TURN_SNAPSHOT') {
                return { ok: true, snapshot: { userTurns: [], latestUserTurnId: null, matchedUserTurnId: null } };
            }
            return { ok: true };
        });
        const job = createJob(tabId, {
            currentPhase: 'sending',
            deliveryState: 'pre-click',
            submittedUserTurnId: null
        });
        jobs.set(tabId, job);

        const sent = await sendPromptToSpecificTab(tabId, '#25 first topic');
        assert.equal(sent.ok, false);
        assert.match(sent.error, /not acknowledged as a new user turn/i);
        assert.equal(sent.details.failureClass, 'submission-unconfirmed');
        assert.equal(sent.details.clickOnly, true);
        assert.equal(job.completedCount, 0);
        assert.equal(job.currentMessage, 'current-command');
        assert.equal(JSON.stringify(sent.details).includes('#25 first topic'), false);
    });
    stopJob(tabId);
    restoreConsole();
});

test('ignored click does not skip the prompt or increment completedCount', async () => {
    const restoreConsole = muteConsole();
    const tabId = 4302;
    const originalRetry = { ...QUEUE_RETRY_POLICY };
    Object.assign(QUEUE_RETRY_POLICY, { backoffBaseMs: 10, backoffMaxMs: 15, sleepSliceMs: 5, maxAutomaticAttempts: 1 });

    await withWaitPolicy({
        submissionAckTimeoutMs: 30,
        submissionAckPollMs: 10,
        checkIntervalMs: 15
    }, async () => {
        executeScriptImpl = async () => [{ result: { ok: true, details: {} } }];
        installTab(tabId, (message) => {
            if (message.type === 'GET_COMMAND_TURN_SNAPSHOT') {
                return { ok: true, snapshot: { userTurns: [], latestUserTurnId: null, matchedUserTurnId: null } };
            }
            if (message.type === 'CHECK_GENERATION_STATE') {
                return { state: generationState(), responseState: responseState({ phase: 'transient-idle' }) };
            }
            return { ok: true };
        });

        let response = null;
        handleStartSequence({
            tabId,
            messages: ['#25 first topic', '#26 second topic']
        }, (result) => { response = result; });

        await waitUntil(() => response?.ok && jobs.has(tabId));
        await waitUntil(() => {
            const job = jobs.get(tabId);
            return job && (job.isPaused || job.completedCount > 0);
        }, 3000);

        const job = jobs.get(tabId);
        assert.ok(job);
        assert.equal(job.completedCount, 0);
        assert.equal(job.queue.includes('#25 first topic') || job.currentMessage === '#25 first topic', true);
        assert.equal(job.queue.includes('#26 second topic'), true);
        assert.notEqual(job.currentPhase, 'queued');
        stopJob(tabId);
    });

    Object.assign(QUEUE_RETRY_POLICY, originalRetry);
    restoreConsole();
});

test('transient idle after generating does not complete a bound command', async () => {
    const restoreConsole = muteConsole();
    const tabId = 4303;
    const job = createJob(tabId);
    jobs.set(tabId, job);
    let polls = 0;
    installTab(tabId, (message) => {
        if (message.type === 'CHECK_GENERATION_STATE') {
            polls += 1;
            if (polls === 1) {
                return {
                    state: generationState({ generating: true }),
                    responseState: responseState({ phase: 'active', generating: true })
                };
            }
            return {
                state: generationState(),
                responseState: responseState({ phase: 'transient-idle' })
            };
        }
        return { ok: true };
    });

    const result = await waitForTabResponse(tabId, {
        commandNumber: 1,
        totalMessages: 1,
        maxWaitMs: 90,
        checkIntervalMs: 15,
        terminalConfirmSamples: 2,
        commandBinding: { userTurnId: 'user-1', commandFingerprint: job.commandFingerprint }
    });

    assert.equal(result.ok, false);
    assert.equal(result.details.assumedCompleteWithoutGeneratingIndicator, undefined);
    assert.equal(job.completedCount, 0);
    stopJob(tabId);
    restoreConsole();
});

test('multi-phase generating-idle-research-generating-terminal stays on the current command', async () => {
    const restoreConsole = muteConsole();
    const tabId = 4304;
    const job = createJob(tabId);
    jobs.set(tabId, job);
    const startedAt = Date.now();
    installTab(tabId, (message) => {
        if (message.type === 'CHECK_GENERATION_STATE') {
            const elapsed = Date.now() - startedAt;
            if (elapsed < 40) {
                return { state: generationState({ generating: true }), responseState: responseState({ phase: 'active' }) };
            }
            if (elapsed < 80) {
                return { state: generationState(), responseState: responseState({ phase: 'transient-idle' }) };
            }
            if (elapsed < 120) {
                return {
                    state: generationState({ generating: true, deepResearchActive: true, researchStatusPreview: 'Deep research is searching sources' }),
                    responseState: responseState({ phase: 'active', deepResearchActive: true, source: 'deep-research' })
                };
            }
            if (elapsed < 160) {
                return { state: generationState({ generating: true }), responseState: responseState({ phase: 'active' }) };
            }
            return {
                state: generationState(),
                responseState: responseState({
                    phase: 'terminal',
                    assistantTurnId: 'asst-1',
                    hasCompletedAssistant: true,
                    source: 'bound-assistant-turn'
                })
            };
        }
        return { ok: true };
    });

    const result = await waitForTabResponse(tabId, {
        commandNumber: 1,
        totalMessages: 1,
        maxWaitMs: 500,
        checkIntervalMs: 15,
        terminalConfirmSamples: 2,
        commandBinding: { userTurnId: 'user-1', commandFingerprint: job.commandFingerprint }
    });

    assert.equal(result.ok, true);
    assert.equal(result.details.terminalAckSource, 'bound-assistant-turn');
    assert.equal(result.details.assistantTurnId, 'asst-1');
    assert.equal(job.completedCount, 0);
    assert.ok(result.details.elapsedMs >= 160);
    stopJob(tabId);
    restoreConsole();
});

test('terminal confirmation is tied to the current command turn', async () => {
    const restoreConsole = muteConsole();
    const tabId = 4305;
    const job = createJob(tabId, { submittedUserTurnId: 'user-25' });
    jobs.set(tabId, job);
    installTab(tabId, (message) => {
        if (message.type === 'CHECK_GENERATION_STATE') {
            return {
                state: generationState(),
                responseState: responseState({
                    phase: 'terminal',
                    userTurnId: 'user-25',
                    assistantTurnId: 'asst-25',
                    hasCompletedAssistant: true,
                    source: 'bound-assistant-turn'
                })
            };
        }
        return { ok: true };
    });

    const result = await waitForTabResponse(tabId, {
        commandNumber: 1,
        totalMessages: 1,
        maxWaitMs: 120,
        checkIntervalMs: 15,
        terminalConfirmSamples: 2,
        commandBinding: { userTurnId: 'user-25', commandFingerprint: 'fp-25' }
    });

    assert.equal(result.ok, true);
    assert.equal(result.details.userTurnId, 'user-25');
    assert.equal(result.details.assistantTurnId, 'asst-25');
    assert.equal(JSON.stringify(result.details).includes('#25'), false);
    stopJob(tabId);
    restoreConsole();
});

test('wait for existing generation treats transient idle as idle without completing a command', async () => {
    const restoreConsole = muteConsole();
    const tabId = 4307;
    const job = createJob(tabId, {
        currentPhase: 'waiting-for-idle',
        waitForIdleBeforeSend: true,
        currentMessage: null,
        queue: ['#25 first topic'],
        deliveryState: '',
        submittedUserTurnId: null,
        commandFingerprint: ''
    });
    jobs.set(tabId, job);
    installTab(tabId, (message) => {
        if (message.type === 'CHECK_GENERATION_STATE') {
            return {
                state: generationState(),
                responseState: responseState({ phase: 'transient-idle', userTurnId: null, source: 'transient-idle' })
            };
        }
        return { ok: true };
    });

    const result = await waitForTabResponse(tabId, {
        waitForExistingGeneration: true,
        maxWaitMs: 120,
        checkIntervalMs: 15,
        terminalConfirmSamples: 1
    });

    assert.equal(result.ok, true);
    assert.equal(result.details.waitedForExistingGeneration, true);
    assert.equal(job.completedCount, 0);
    assert.equal(job.currentPhase, 'waiting-for-idle');
    stopJob(tabId);
    restoreConsole();
});

test('delayed generation after accepted submission does not skip or duplicate', async () => {
    const restoreConsole = muteConsole();
    const tabId = 4306;
    const job = createJob(tabId);
    jobs.set(tabId, job);
    const startedAt = Date.now();
    installTab(tabId, (message) => {
        if (message.type === 'CHECK_GENERATION_STATE') {
            const elapsed = Date.now() - startedAt;
            if (elapsed < 70) {
                return { state: generationState(), responseState: responseState({ phase: 'transient-idle' }) };
            }
            if (elapsed < 110) {
                return { state: generationState({ generating: true }), responseState: responseState({ phase: 'active' }) };
            }
            return {
                state: generationState(),
                responseState: responseState({
                    phase: 'terminal',
                    assistantTurnId: 'asst-delayed',
                    hasCompletedAssistant: true,
                    source: 'bound-assistant-turn'
                })
            };
        }
        return { ok: true };
    });

    const result = await waitForTabResponse(tabId, {
        commandNumber: 1,
        totalMessages: 1,
        maxWaitMs: 400,
        checkIntervalMs: 15,
        terminalConfirmSamples: 2,
        commandBinding: { userTurnId: 'user-1', commandFingerprint: job.commandFingerprint }
    });

    assert.equal(result.ok, true);
    assert.equal(result.details.assumedCompleteWithoutGeneratingIndicator, undefined);
    assert.equal(job.queue.filter(message => message === 'current-command').length, 0);
    assert.equal(job.currentMessage, 'current-command');
    stopJob(tabId);
    restoreConsole();
});

test('error retry stop interrupted and waiting-for-user never complete as success', async () => {
    const restoreConsole = muteConsole();
    const cases = [
        { tabId: 4310, responseState: responseState({ phase: 'error', source: 'generation-error' }), state: generationState({ hasError: true }), class: 'generation-error' },
        { tabId: 4311, responseState: responseState({ phase: 'error', source: 'retry-visible' }), state: generationState({ hasTryAgainButton: true, hasError: true }), class: 'retry-visible' },
        { tabId: 4312, responseState: responseState({ phase: 'interrupted', source: 'interrupted' }), state: generationState(), class: 'interrupted' },
        { tabId: 4313, responseState: responseState({ phase: 'waiting-for-user', source: 'waiting-for-user' }), state: generationState(), class: 'waiting-for-user' }
    ];

    for (const testCase of cases) {
        const job = createJob(testCase.tabId);
        jobs.set(testCase.tabId, job);
        installTab(testCase.tabId, (message) => {
            if (message.type === 'CHECK_GENERATION_STATE') {
                return { state: testCase.state, responseState: testCase.responseState };
            }
            return { ok: true };
        });
        const result = await waitForTabResponse(testCase.tabId, {
            commandNumber: 1,
            totalMessages: 1,
            maxWaitMs: 80,
            checkIntervalMs: 15,
            commandBinding: { userTurnId: 'user-1' }
        });
        assert.equal(result.ok, false, testCase.class);
        assert.equal(job.completedCount, 0, testCase.class);
        const classified = classifyQueueFailure('wait', result.error, result.details);
        assert.equal(classified.class, testCase.class);
        if (testCase.class === 'waiting-for-user' || testCase.class === 'interrupted') {
            assert.equal(classified.retryable, false);
        }
        stopJob(testCase.tabId);
    }

    const stoppedId = 4314;
    const stoppedJob = createJob(stoppedId);
    jobs.set(stoppedId, stoppedJob);
    installTab(stoppedId, (message) => {
        if (message.type === 'CHECK_GENERATION_STATE') {
            return { state: generationState({ generating: true }), responseState: responseState({ phase: 'active' }) };
        }
        return { ok: true };
    });
    const waitPromise = waitForTabResponse(stoppedId, {
        commandNumber: 1,
        totalMessages: 1,
        maxWaitMs: 400,
        checkIntervalMs: 15,
        commandBinding: { userTurnId: 'user-1' }
    });
    stoppedJob.isStopped = true;
    stoppedJob.isRunning = false;
    const stopped = await waitPromise;
    assert.equal(stopped.ok, false);
    assert.equal(stoppedJob.completedCount, 0);
    stopJob(stoppedId);
    restoreConsole();
});

test('durable recovery distinguishes unconfirmed send, confirmed submission, active response, and terminal', () => {
    jobs.clear();
    const unconfirmed = restoreDurableJobs({
        4320: {
            tabId: 4320,
            provider: 'chatgpt',
            conversationId: 'unconfirmed',
            conversationType: 'existing',
            queue: ['#26 second topic'],
            currentMessage: '#25 first topic',
            isRunning: true,
            currentPhase: 'awaiting-submission-ack',
            deliveryState: 'unknown-acceptance',
            currentCommandNumber: 1,
            completedCount: 0
        }
    })[0];
    assert.deepEqual(unconfirmed.queue[0], '#25 first topic');
    assert.equal(unconfirmed.currentMessage, null);
    assert.equal(unconfirmed.currentPhase, 'queued');
    assert.equal(unconfirmed.completedCount, 0);

    jobs.clear();
    const confirmed = restoreDurableJobs({
        4321: {
            tabId: 4321,
            provider: 'chatgpt',
            conversationId: 'confirmed',
            conversationType: 'existing',
            queue: ['#26 second topic'],
            currentMessage: '#25 first topic',
            isRunning: true,
            currentPhase: 'awaiting-response',
            deliveryState: 'confirmed-submission',
            submittedUserTurnId: 'user-25',
            commandId: 'run:1',
            currentCommandNumber: 1,
            completedCount: 0
        }
    })[0];
    assert.equal(confirmed.currentMessage, '#25 first topic');
    assert.equal(confirmed.queue[0], '#26 second topic');
    assert.equal(confirmed.currentPhase, 'awaiting-response');
    assert.equal(confirmed.submittedUserTurnId, 'user-25');

    jobs.clear();
    const active = restoreDurableJobs({
        4322: {
            tabId: 4322,
            provider: 'chatgpt',
            conversationId: 'active',
            conversationType: 'existing',
            queue: ['#26 second topic'],
            currentMessage: '#25 first topic',
            isRunning: true,
            currentPhase: 'sending',
            deliveryState: 'active-response',
            submittedUserTurnId: 'user-25',
            currentCommandNumber: 1,
            completedCount: 0
        }
    })[0];
    assert.equal(active.currentMessage, '#25 first topic');
    assert.equal(active.currentPhase, 'awaiting-response');
    assert.equal(active.queue.includes('#25 first topic'), false);

    jobs.clear();
    const terminal = restoreDurableJobs({
        4323: {
            tabId: 4323,
            provider: 'chatgpt',
            conversationId: 'terminal',
            conversationType: 'existing',
            queue: ['#26 second topic'],
            currentMessage: '#25 first topic',
            isRunning: true,
            currentPhase: 'terminal',
            deliveryState: 'terminal-awaiting-bookkeeping',
            submittedUserTurnId: 'user-25',
            assistantTurnId: 'asst-25',
            terminalAckSource: 'bound-assistant-turn',
            currentCommandNumber: 1,
            completedCount: 0
        }
    })[0];
    assert.equal(terminal.currentPhase, 'terminal');
    assert.equal(terminal.currentMessage, '#25 first topic');
    completeCurrentCommand(4323, terminal, 2, { terminalAckSource: 'bound-assistant-turn' });
    assert.equal(terminal.completedCount, 1);
    assert.equal(terminal.currentMessage, null);
    assert.equal(terminal.queue[0], '#26 second topic');
    jobs.clear();
});

test('pause after confirmed submission keeps the command instead of duplicating it', () => {
    const restoreConsole = muteConsole();
    const tabId = 4324;
    const job = createJob(tabId, { queue: ['#26 second topic'], currentMessage: '#25 first topic' });
    jobs.set(tabId, job);
    pauseJob(tabId, 'The ChatGPT response was interrupted.', { failureClass: 'interrupted' });
    assert.equal(job.currentMessage, '#25 first topic');
    assert.deepEqual(job.queue, ['#26 second topic']);
    assert.equal(job.completedCount, 0);
    jobs.clear();
    restoreConsole();
});

test('durable snapshots persist delivery metadata without prompt text', () => {
    const tabId = 4325;
    const job = createJob(tabId, { currentMessage: '#25 secret prompt text' });
    jobs.set(tabId, job);
    const durable = getDurableJobsState();
    assert.equal(durable[tabId].deliveryState, 'confirmed-submission');
    assert.equal(durable[tabId].submittedUserTurnId, 'user-1');
    assert.equal(durable[tabId].commandId, job.commandId);
    assert.equal(JSON.stringify(durable[tabId].deliveryState).includes('secret prompt'), false);
    jobs.clear();
});

test('topics 25-33 create one confirmed user turn each and preserve order', async () => {
    const restoreConsole = muteConsole();
    const tabId = 4333;
    const originalRetry = { ...QUEUE_RETRY_POLICY };
    Object.assign(QUEUE_RETRY_POLICY, { backoffBaseMs: 10, backoffMaxMs: 15, sleepSliceMs: 5 });

    await withWaitPolicy({
        submissionAckTimeoutMs: 200,
        submissionAckPollMs: 10,
        checkIntervalMs: 15,
        terminalConfirmSamples: 2,
        interCommandDelayMs: 0
    }, async () => {
        const userTurns = [];
        const sendStartedAt = [];
        let current = null;

        executeScriptImpl = async (details) => {
            const text = details?.args?.[0] || '';
            if (current && current.phase !== 'terminal') {
                assert.fail(`Command ${userTurns.length + 1} started before the previous command was terminal`);
            }
            current = {
                text,
                userTurnId: `user-${userTurns.length + 1}`,
                assistantTurnId: `asst-${userTurns.length + 1}`,
                phase: 'active',
                acceptedAt: Date.now()
            };
            sendStartedAt.push(Date.now());
            userTurns.push({ turnId: current.userTurnId, fingerprint: `fp-${userTurns.length}`, matchedExpected: true });
            return [{ result: { ok: true, details: { sendButtonSelector: 'button[data-testid="send-button"]' } } }];
        };

        installTab(tabId, (message) => {
            if (message.type === 'GET_COMMAND_TURN_SNAPSHOT') {
                return {
                    ok: true,
                    snapshot: {
                        userTurns: userTurns.map(turn => ({ ...turn })),
                        latestUserTurnId: userTurns.at(-1)?.turnId || null,
                        matchedUserTurnId: userTurns.find(turn => turn.matchedExpected && turn.turnId === current?.userTurnId)?.turnId || userTurns.at(-1)?.turnId || null,
                        conversationId: 'issue-43-fixture'
                    }
                };
            }
            if (message.type === 'CHECK_GENERATION_STATE') {
                if (!current) {
                    return { state: generationState(), responseState: responseState({ phase: 'transient-idle', userTurnId: null }) };
                }
                const elapsed = Date.now() - current.acceptedAt;
                if (elapsed < 25) {
                    current.phase = 'active';
                    return {
                        state: generationState({ generating: true }),
                        responseState: responseState({ phase: 'active', userTurnId: current.userTurnId })
                    };
                }
                if (elapsed < 45) {
                    current.phase = 'transient-idle';
                    return {
                        state: generationState(),
                        responseState: responseState({ phase: 'transient-idle', userTurnId: current.userTurnId })
                    };
                }
                current.phase = 'terminal';
                return {
                    state: generationState(),
                    responseState: responseState({
                        phase: 'terminal',
                        userTurnId: current.userTurnId,
                        assistantTurnId: current.assistantTurnId,
                        hasCompletedAssistant: true,
                        source: 'bound-assistant-turn'
                    })
                };
            }
            return { ok: true };
        });

        let response = null;
        handleStartSequence({
            tabId,
            messages: FIXTURE_COMMANDS
        }, (result) => { response = result; });

        await waitUntil(() => response?.ok && jobs.has(tabId));
        await waitUntil(() => !jobs.has(tabId), 8000);

        assert.equal(userTurns.length, FIXTURE_COMMANDS.length);
        assert.equal(new Set(userTurns.map(turn => turn.turnId)).size, FIXTURE_COMMANDS.length);
        for (let index = 1; index < sendStartedAt.length; index += 1) {
            assert.ok(sendStartedAt[index] >= sendStartedAt[index - 1]);
        }
    });

    Object.assign(QUEUE_RETRY_POLICY, originalRetry);
    stopJob(tabId);
    restoreConsole();
});
