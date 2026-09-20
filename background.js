/** @type {Map<number, QueueJob>} */
const jobs = new Map();
const QUEUE_DEBUG_LOG_KEY = 'queueDebugLogs';
const QUEUE_DURABLE_STATE_KEY = 'queueDurableJobs';
const MAX_QUEUE_DEBUG_LOG_ENTRIES = 300;
/** @type {QueueSettings} */
const QUEUE_SETTINGS_DEFAULTS = {
    queueUnlimitedRetryWait: false,
    queueDeepResearchAware: true,
    queueDeliveryTimeoutRefresh: true
};
const UNLIMITED_RETRY_DELAY_MS = 15000;
/** @type {QueueRetryPolicy} */
const QUEUE_RETRY_POLICY = {
    maxAutomaticAttempts: 3,
    backoffBaseMs: 2000,
    backoffFactor: 2,
    backoffMaxMs: 30000,
    unlimitedDelayMs: UNLIMITED_RETRY_DELAY_MS,
    sleepSliceMs: 250
};
/** @type {QueueWaitPolicy} */
const QUEUE_WAIT_POLICY = {
    responseMaxWaitMs: 10 * 60 * 1000,
    deepResearchMaxWaitMs: 45 * 60 * 1000,
    deepResearchStaleMs: 5 * 60 * 1000,
    checkIntervalMs: 1000,
    submissionAckTimeoutMs: 8000,
    submissionAckPollMs: 250,
    terminalConfirmSamples: 2,
    interCommandDelayMs: 2000
};
const WAITING_COMMAND_PHASES = new Set(['waiting', 'awaiting-response', 'active-response']);
const CONFIRMED_DELIVERY_STATES = new Set([
    'confirmed-submission',
    'active-response',
    'terminal-awaiting-bookkeeping'
]);
const RETRYABLE_FAILURE_CLASSES = new Set([
    'transient',
    'generation-error',
    'retry-visible',
    'timeout',
    'stalled-research',
    'submission-unconfirmed'
]);
const QUEUE_WAKE_ALARM_NAME = 'queue-wake';
const QUEUE_WAKE_ALARM_PERIOD_MINUTES = 0.5;
const QUEUE_STATE_COALESCE_DELAY_MS = 50;
const QUEUE_LOG_COALESCE_DELAY_MS = 50;
const SCHEDULED_MESSAGES_KEY = 'scheduledMessages';
const SCHEDULED_ALARM_PREFIX = 'scheduled-msg:';
// Chrome alarms may fire late, but a scheduled message must never be delivered early.
const SCHEDULED_DUE_SKEW_MS = 0;

/** @type {Promise<any>} */
let scheduledStorageWrite = Promise.resolve();

if (typeof importScripts === 'function') {
    importScripts('utils.js', 'provider-adapter.js');
}

let providerAdapterRegistry = typeof globalThis !== 'undefined' ? globalThis.ProviderAdapterRegistry : null;
if (!providerAdapterRegistry && typeof require === 'function') {
    try {
        providerAdapterRegistry = require('./provider-adapter.js');
    } catch {}
}

function getActiveProviderAdapter(urlOrId) {
    if (typeof getProviderForUrl === 'function' && typeof urlOrId === 'string' && urlOrId.startsWith('http')) {
        return getProviderForUrl(urlOrId);
    }
    if (providerAdapterRegistry && typeof providerAdapterRegistry.getProviderForUrl === 'function' && typeof urlOrId === 'string' && urlOrId.startsWith('http')) {
        return providerAdapterRegistry.getProviderForUrl(urlOrId);
    }
    if (typeof getProvider === 'function') {
        return getProvider(urlOrId || 'chatgpt');
    }
    if (providerAdapterRegistry && typeof providerAdapterRegistry.getProvider === 'function') {
        return providerAdapterRegistry.getProvider(urlOrId || 'chatgpt');
    }
    return null;
}

async function resolveTabConversationIdentity(tabId) {
    try {
        const response = await sendTabMessage(tabId, { type: 'GET_CONVERSATION_IDENTITY' });
        if (response && response.ok && response.identity) {
            return response.identity;
        }
    } catch {
        // Tab may not have content script ready
    }

    try {
        const tab = await getTab(tabId);
        const url = tab?.url || tab?.pendingUrl;
        if (url) {
            const provider = getActiveProviderAdapter(url) || getActiveProviderAdapter('chatgpt');
            if (provider && typeof provider.getConversationIdentity === 'function') {
                return provider.getConversationIdentity(url);
            }
        }
    } catch {
        // Tab query failed
    }

    return {
        provider: 'chatgpt',
        type: 'unknown',
        conversationId: null,
        key: 'chatgpt:unknown'
    };
}

async function validateJobTargetConversation(tabId, job) {
    const currentIdentity = await resolveTabConversationIdentity(tabId);

    if (!job.provider) {
        job.provider = currentIdentity.provider || 'chatgpt';
    }

    if (currentIdentity.provider && job.provider && currentIdentity.provider !== 'unknown' && currentIdentity.provider !== job.provider) {
        return {
            ok: false,
            reason: `Provider mismatch: queue is bound to ${job.provider}, but tab is on ${currentIdentity.provider}.`,
            currentIdentity
        };
    }

    if (currentIdentity.type === 'unsupported') {
        return {
            ok: false,
            reason: `Tab navigated away from conversation to unsupported page (${currentIdentity.key || 'unsupported'}). Queue paused to prevent sending into the wrong page.`,
            currentIdentity
        };
    }

    if (job.conversationType === 'new') {
        if (currentIdentity.type === 'existing' && currentIdentity.conversationId) {
            job.conversationId = currentIdentity.conversationId;
            job.conversationType = 'existing';
            job.targetKey = currentIdentity.key;
            await updateRunningJobsStorage({ force: true });
            return { ok: true, currentIdentity, updatedBinding: true };
        }
        if (currentIdentity.type === 'new') {
            return { ok: true, currentIdentity };
        }
        return {
            ok: false,
            reason: `Conversation mismatch: expected new conversation, but tab is now on ${currentIdentity.type} (${currentIdentity.key}).`,
            currentIdentity
        };
    }

    if (job.conversationType === 'existing' && job.conversationId) {
        if (currentIdentity.type === 'existing') {
            if (currentIdentity.conversationId === job.conversationId) {
                return { ok: true, currentIdentity };
            }
            return {
                ok: false,
                reason: `Conversation mismatch: tab was navigated from conversation "${job.conversationId}" to "${currentIdentity.conversationId}". Queue paused to prevent delivering prompts into the wrong conversation.`,
                currentIdentity
            };
        }
        if (currentIdentity.type === 'new') {
            return {
                ok: false,
                reason: `Conversation mismatch: tab was navigated from conversation "${job.conversationId}" to a new conversation. Queue paused to prevent delivering prompts into the wrong conversation.`,
                currentIdentity
            };
        }
        return {
            ok: false,
            reason: `Conversation mismatch: tab was navigated away from conversation "${job.conversationId}".`,
            currentIdentity
        };
    }

    if (job.conversationType === 'unknown' || !job.conversationId) {
        if (currentIdentity.type === 'existing' || currentIdentity.type === 'new') {
            job.provider = currentIdentity.provider || 'chatgpt';
            job.conversationId = currentIdentity.conversationId || null;
            job.conversationType = currentIdentity.type;
            job.targetKey = currentIdentity.key;
            await updateRunningJobsStorage({ force: true });
            return { ok: true, currentIdentity, boundFromUnknown: true };
        }
    }

    return { ok: true, currentIdentity };
}

let queueStateWrite = Promise.resolve();
let pendingQueueState = null;
let queueStateFlushTimer = null;
let queueStateInFlightSerialized = null;
let lastPersistedQueueState = null;
let queueLogWrite = Promise.resolve();
let pendingQueueLogEntries = [];
let queueLogFlushTimer = null;
let queueLogGeneration = 0;

chrome.runtime.onMessage.addListener(
    /**
     * @param {RuntimeMessageRequest} request
     * @param {chrome.runtime.MessageSender} sender
     * @param {(response?: RuntimeMessageResponse) => void} sendResponse
     */
    (request, sender, sendResponse) => {
        if (request.action === 'startSequence') {
            handleStartSequence(request, sendResponse);
            return true;
        }

        if (request.action === 'enqueueMessage') {
            handleEnqueueMessage(request, sender, sendResponse);
            return true;
        }

        if (request.action === 'retryPausedJob') {
            handleRetryPausedJob(request, sendResponse);
            return true;
        }

        if (request.action === 'stopSequence') {
            handleStopSequence(request, sendResponse);
            return true;
        }

        if (request.action === 'stopAllSequences') {
            handleStopAllSequences(sendResponse);
            return true;
        }

        if (request.action === 'getRunningJobs') {
            sendResponse({
                ok: true,
                jobs: getRunningJobsSnapshot()
            });
            return true;
        }

        if (request.action === 'getQueueDebugLogs') {
            handleGetQueueDebugLogs(sendResponse);
            return true;
        }

        if (request.action === 'clearQueueDebugLogs') {
            handleClearQueueDebugLogs(sendResponse);
            return true;
        }

        if (request.action === 'logAutomationEvent') {
            handleLogAutomationEvent(request, sendResponse);
            return true;
        }

        if (request.action === 'scheduleMessage') {
            handleScheduleMessage(request, sendResponse);
            return true;
        }

        if (request.action === 'listScheduledMessages') {
            handleListScheduledMessages(sendResponse);
            return true;
        }

        if (request.action === 'cancelScheduledMessage') {
            handleCancelScheduledMessage(request, sendResponse);
            return true;
        }

        if (request.action === 'deleteScheduledMessage') {
            handleDeleteScheduledMessage(request, sendResponse);
            return true;
        }

        if (request.action === 'retryScheduledMessage') {
            handleRetryScheduledMessage(request, sendResponse);
            return true;
        }

        return false;
    }
);

if (chrome.browserAction && chrome.browserAction.onClicked) {
    chrome.browserAction.onClicked.addListener(() => {
        openExtensionPopupPage().catch((error) => {
            console.warn('Could not open extension page:', error);
        });
    });
}

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-optimizer') return;

    try {
        const tab = await getActiveTab();

        if (!tab || !tab.id || !isSupportedProviderUrl(tab.url)) {
            return;
        }

        const provider = getActiveProviderAdapter(tab.url);
        if (!provider?.supportsOptimizer) {
            return;
        }

        await sendTabMessage(tab.id, {
            type: 'TOGGLE_OPTIMIZER',
            source: 'keyboard'
        }).catch(() => {});
    } catch (error) {
        console.warn('Could not toggle optimizer:', error);
    }
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get(
        {
            enabled: undefined,
            windowSize: undefined,
            batchSize: undefined,
            autoScroll: undefined,
            queueUnlimitedRetryWait: undefined,
            queueDeepResearchAware: undefined,
            queueDeliveryTimeoutRefresh: undefined
        },
        (data) => {
            const defaults = {};

            if (typeof data.enabled !== 'boolean') {
                defaults.enabled = true;
            }

            if (typeof data.windowSize !== 'number') {
                defaults.windowSize = 50;
            }

            if (typeof data.batchSize !== 'number') {
                defaults.batchSize = 25;
            }

            if (typeof data.autoScroll !== 'boolean') {
                defaults.autoScroll = true;
            }

            if (typeof data.queueUnlimitedRetryWait !== 'boolean') {
                defaults.queueUnlimitedRetryWait = QUEUE_SETTINGS_DEFAULTS.queueUnlimitedRetryWait;
            }

            if (typeof data.queueDeepResearchAware !== 'boolean') {
                defaults.queueDeepResearchAware = QUEUE_SETTINGS_DEFAULTS.queueDeepResearchAware;
            }

            if (typeof data.queueDeliveryTimeoutRefresh !== 'boolean') {
                defaults.queueDeliveryTimeoutRefresh = QUEUE_SETTINGS_DEFAULTS.queueDeliveryTimeoutRefresh;
            }

            if (Object.keys(defaults).length > 0) {
                chrome.storage.sync.set(defaults);
            }
        }
    );
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (jobs.has(tabId)) {
        const job = jobs.get(tabId);
        logQueueEvent(tabId, 'warn', 'ChatGPT tab closed while queue was active.', {
            completedCount: job?.completedCount || 0,
            totalMessages: getTotalMessages(job),
            remaining: getRemainingCount(job)
        });
        jobs.delete(tabId);
        updateRunningJobsStorage({ force: true });
    }
});

if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || !alarm.name) return;

        if (alarm.name === QUEUE_WAKE_ALARM_NAME) {
            resumeDurableQueues('alarm');
            return;
        }

        if (alarm.name.startsWith(SCHEDULED_ALARM_PREFIX)) {
            const scheduledId = alarm.name.slice(SCHEDULED_ALARM_PREFIX.length);
            processDueScheduledMessages('alarm', scheduledId).catch((error) => {
                console.warn('Could not process scheduled message alarm:', error);
            });
        }
    });
}

initializeQueueDiagnostics();

function initializeQueueDiagnostics() {
    resumeDurableQueues('startup')
        .then((restoredCount) => {
            if (restoredCount > 0) {
                return;
            }

            return logLegacyStaleRunningJobs();
        })
        .catch((error) => {
            console.warn('Could not initialize queue diagnostics:', error);
        });

    recoverScheduledMessages('startup').catch((error) => {
        console.warn('Could not recover scheduled messages:', error);
    });
}

async function resumeDurableQueues(source = 'manual') {
    if (jobs.size > 0) {
        updateQueueWakeAlarm(true);

        for (const job of jobs.values()) {
            if (job.isRunning && !job.isPaused && !job.isStopped && !job.isProcessing) {
                processQueue(job.tabId);
            }
        }

        return 0;
    }

    const data = await readLocalStorage([QUEUE_DURABLE_STATE_KEY]);
    const durableJobs = data[QUEUE_DURABLE_STATE_KEY] && typeof data[QUEUE_DURABLE_STATE_KEY] === 'object'
        ? data[QUEUE_DURABLE_STATE_KEY]
        : {};
    const restoredJobs = restoreDurableJobs(durableJobs);

    if (restoredJobs.length === 0) {
        updateQueueWakeAlarm();
        return 0;
    }

    logQueueEvent('', 'warn', `Restored ${restoredJobs.length} queue${restoredJobs.length === 1 ? '' : 's'} after background worker wake.`, {
        source,
        restoredJobs: restoredJobs.map(job => ({
            tabId: job.tabId,
            status: getJobStatus(job),
            phase: job.currentPhase || '',
            completedCount: job.completedCount || 0,
            currentCommandNumber: job.currentCommandNumber || 0,
            remaining: getRemainingCount(job),
            totalMessages: getTotalMessages(job),
            lastError: job.lastError || ''
        }))
    });

    await updateRunningJobsStorage({ force: true });

    for (const job of restoredJobs) {
        if (job.isRunning && !job.isPaused && !job.isStopped) {
            processQueue(job.tabId);
        }
    }

    return restoredJobs.length;
}

/**
 * Restore persisted jobs from the QUEUE_DURABLE_STATE_KEY snapshot.
 * @param {DurableQueueSnapshot|object} durableJobs
 * @returns {QueueJob[]}
 */
function restoreDurableJobs(durableJobs) {
    /** @type {QueueJob[]} */
    const restoredJobs = [];

    for (const rawJob of Object.values(durableJobs || {})) {
        if (!rawJob || !rawJob.tabId) continue;

        const tabId = Number(rawJob.tabId);
        const queue = Array.isArray(rawJob.queue)
            ? rawJob.queue.map(message => String(message || '').trim()).filter(Boolean)
            : [];
        const currentMessage = String(rawJob.currentMessage || '').trim() || null;

        if (!currentMessage && queue.length === 0) continue;

        const provider = rawJob.provider || 'chatgpt';
        const conversationId = rawJob.conversationId || null;
        const conversationType = rawJob.conversationType || (conversationId ? 'existing' : (rawJob.targetKey === 'chatgpt:new' ? 'new' : 'unknown'));
        const targetKey = rawJob.targetKey || (conversationId ? `${provider}:c:${conversationId}` : `${provider}:${conversationType}`);

        const job = {
            tabId,
            provider,
            conversationId,
            conversationType,
            targetKey,
            queue,
            currentMessage,
            isRunning: rawJob.isRunning !== false && rawJob.isPaused !== true,
            isPaused: rawJob.isPaused === true,
            isStopped: false,
            pausedReason: rawJob.pausedReason || '',
            lastError: rawJob.lastError || '',
            runId: rawJob.runId || createRunId(),
            totalMessages: Number(rawJob.totalMessages || 0),
            completedCount: Number(rawJob.completedCount || 0),
            currentCommandNumber: Number(rawJob.currentCommandNumber || 0),
            currentPhase: rawJob.currentPhase || (rawJob.waitForIdleBeforeSend ? 'waiting-for-idle' : (currentMessage ? 'waiting' : 'queued')),
            waitForIdleBeforeSend: rawJob.waitForIdleBeforeSend === true,
            deliveryTimeoutAttempts: Number(rawJob.deliveryTimeoutAttempts || 0),
            retryAttemptCount: Number(rawJob.retryAttemptCount || 0),
            lastRetryableReason: String(rawJob.lastRetryableReason || ''),
            retryClass: String(rawJob.retryClass || ''),
            retryMode: rawJob.retryMode === 'unlimited' ? 'unlimited' : (rawJob.retryMode === 'finite' ? 'finite' : ''),
            nextRetryDelayMs: Number(rawJob.nextRetryDelayMs || 0),
            nextRetryAt: Number(rawJob.nextRetryAt || 0),
            retryExhausted: rawJob.retryExhausted === true,
            waitStartedAt: Number(rawJob.waitStartedAt || 0),
            lastResearchProgressAt: Number(rawJob.lastResearchProgressAt || 0),
            sawDeepResearch: rawJob.sawDeepResearch === true,
            sawGenerating: rawJob.sawGenerating === true,
            deliveryState: rawJob.deliveryState || '',
            commandId: rawJob.commandId || '',
            commandFingerprint: rawJob.commandFingerprint || '',
            submittedUserTurnId: rawJob.submittedUserTurnId || null,
            assistantTurnId: rawJob.assistantTurnId || null,
            submissionAckSource: rawJob.submissionAckSource || '',
            terminalAckSource: rawJob.terminalAckSource || '',
            lastResponsePhase: rawJob.lastResponsePhase || '',
            startedAt: Number(rawJob.startedAt || Date.now()),
            updatedAt: Number(rawJob.updatedAt || Date.now())
        };

        job.totalMessages = getTotalMessages(job);

        if (job.currentMessage && !job.currentCommandNumber) {
            job.currentCommandNumber = Number(job.completedCount || 0) + 1;
        }

        if (job.currentPhase === 'waiting' && isSubmissionConfirmed(job)) {
            job.currentPhase = 'awaiting-response';
            if (!job.deliveryState) {
                job.deliveryState = 'confirmed-submission';
            }
        }

        if (job.currentPhase === 'terminal' || job.deliveryState === 'terminal-awaiting-bookkeeping') {
            job.currentPhase = 'terminal';
            job.deliveryState = 'terminal-awaiting-bookkeeping';
        } else if (isSubmissionConfirmed(job) && (job.currentPhase === 'sending' || job.currentPhase === 'awaiting-submission-ack')) {
            logQueueEvent(tabId, 'info', 'Recovered a command with confirmed submission; resuming wait instead of resending.', {
                phase: job.currentPhase,
                commandNumber: job.currentCommandNumber || 0,
                totalMessages: getTotalMessages(job),
                ...collectDeliveryDiagnostics(job)
            });
            job.currentPhase = 'awaiting-response';
            job.deliveryState = job.deliveryState === 'active-response' ? 'active-response' : 'confirmed-submission';
        } else if (job.currentPhase === 'sending' || job.currentPhase === 'awaiting-submission-ack' || job.deliveryState === 'pre-click' || job.deliveryState === 'unknown-acceptance') {
            logQueueEvent(tabId, 'warn', 'Recovered a command that was not confirmed submitted; retrying it.', {
                phase: job.currentPhase,
                commandNumber: job.currentCommandNumber || 0,
                totalMessages: getTotalMessages(job),
                ...collectDeliveryDiagnostics(job)
            });
            job.queue.unshift(job.currentMessage);
            job.currentMessage = null;
            job.currentCommandNumber = 0;
            job.currentPhase = 'queued';
            resetWaitTracking(job);
            resetCommandDeliveryState(job);
        }

        jobs.set(tabId, job);
        restoredJobs.push(job);
    }

    return restoredJobs;
}

function logLegacyStaleRunningJobs() {
    return readLocalStorage(['runningJobs'])
        .then((data) => {
            const staleJobs = data.runningJobs && typeof data.runningJobs === 'object'
                ? data.runningJobs
                : {};
            const entries = Object.values(staleJobs);

            if (entries.length === 0) {
                return;
            }

            logQueueEvent('', 'error', 'Background worker restarted while queue state existed; in-memory queue was lost.', {
                staleJobCount: entries.length,
                staleJobs: entries.map(job => ({
                    tabId: job.tabId || '',
                    status: job.status || '',
                    remaining: job.remaining || 0,
                    completedCount: job.completedCount || 0,
                    totalMessages: job.totalMessages || 0,
                    currentCommandNumber: job.currentCommandNumber || 0,
                    lastError: job.lastError || ''
                }))
            });

            writeLocalStorage({
                runningJobs: {},
                [QUEUE_DURABLE_STATE_KEY]: {},
                isRunning: false
            }).catch((error) => {
                console.warn('Could not clear stale queue state:', error);
            });
        })
        .catch((error) => {
            console.warn('Could not initialize queue diagnostics:', error);
        });
}

function handleGetQueueDebugLogs(sendResponse) {
    (async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await flushQueueDebugLogs();
            await queueLogWrite;
        }
        const data = await readLocalStorage([QUEUE_DEBUG_LOG_KEY]);

        sendResponse({
            ok: true,
            logs: (Array.isArray(data[QUEUE_DEBUG_LOG_KEY]) ? data[QUEUE_DEBUG_LOG_KEY] : []).map((entry) => ({
                ...entry,
                details: sanitizeLogValue(entry?.details)
            }))
        });
    })().catch((error) => {
        sendResponse({
            ok: false,
            error: error?.message || 'Could not read queue log.'
        });
    });
}

function handleClearQueueDebugLogs(sendResponse) {
    queueLogGeneration += 1;
    pendingQueueLogEntries = [];

    if (queueLogFlushTimer !== null) {
        clearTimeout(queueLogFlushTimer);
        queueLogFlushTimer = null;
    }

    const clearGeneration = queueLogGeneration;
    queueLogWrite = queueLogWrite
        .catch(() => {})
        .then(async () => {
            if (clearGeneration !== queueLogGeneration) {
                return;
            }

            await writeLocalStorage({ [QUEUE_DEBUG_LOG_KEY]: [] });
        })
        .catch((error) => {
            console.warn('Could not clear queue debug log:', error);
            throw error;
        });

    queueLogWrite
        .then(() => {
            notifyRuntime({ action: 'queueDebugLogUpdated' });
            sendResponse({ ok: true });
        })
        .catch((error) => {
            sendResponse({
                ok: false,
                error: error?.message || 'Could not clear queue log.'
            });
        });
}

function handleLogAutomationEvent(request, sendResponse) {
    const level = ['error', 'warn', 'success', 'info'].includes(request.level)
        ? request.level
        : 'info';
    const details = request.details && typeof request.details === 'object'
        ? request.details
        : {};

    logQueueEvent(request.tabId || '', level, request.message || 'Automation event', {
        source: request.source || 'popup',
        ...details
    });

    sendResponse({ ok: true });
}

/**
 * @param {RuntimeMessageRequest} request
 * @param {(response?: RuntimeMessageResponse) => void} sendResponse
 */
function handleStartSequence(request, sendResponse) {
    (async () => {
        const tabId = request.tabId;
        const messages = Array.isArray(request.messages)
            ? request.messages.map(msg => String(msg || '').trim()).filter(Boolean)
            : [];

        if (!tabId || messages.length === 0) {
            logQueueEvent(tabId, 'warn', 'Could not start sequence: missing tab or messages.', {
                messageCount: messages.length
            });
            sendResponse({ ok: false, error: 'Missing tabId or messages.' });
            return;
        }

        const existingJob = jobs.get(tabId);

        if (existingJob && (existingJob.isRunning || existingJob.isPaused)) {
            logQueueEvent(tabId, 'warn', 'Could not start sequence: queue already exists on tab.', {
                status: getJobStatus(existingJob),
                remaining: getRemainingCount(existingJob),
                lastError: existingJob.lastError || ''
            });
            sendResponse({
                ok: false,
                error: 'A sequence is already running or paused on this tab. Use Send message next or stop/retry the existing queue.'
            });
            return;
        }

        const waitForIdleBeforeStart = request.waitForIdleBeforeStart === true;
        const identity = request.conversationIdentity || await resolveTabConversationIdentity(tabId);
        const provider = identity?.provider || 'chatgpt';
        const conversationType = identity?.type || 'unknown';
        const conversationId = identity?.conversationId || null;
        const targetKey = identity?.key || (conversationId ? `${provider}:c:${conversationId}` : `${provider}:${conversationType}`);

        jobs.set(tabId, {
            tabId,
            provider,
            conversationId,
            conversationType,
            targetKey,
            queue: [...messages],
            currentMessage: null,
            isRunning: true,
            isPaused: false,
            isStopped: false,
            pausedReason: '',
            lastError: '',
            runId: createRunId(),
            totalMessages: messages.length,
            completedCount: 0,
            currentCommandNumber: 0,
            currentPhase: waitForIdleBeforeStart ? 'waiting-for-idle' : 'queued',
            waitForIdleBeforeSend: waitForIdleBeforeStart,
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
            ...emptyDeliveryFields(),
            startedAt: Date.now(),
            updatedAt: Date.now()
        });

        logQueueEvent(tabId, 'info', `Started sequence with ${messages.length} command${messages.length === 1 ? '' : 's'}.`, {
            totalMessages: messages.length,
            firstMessagePreview: previewText(messages[0] || '', 160)
        });

        await updateRunningJobsStorage({ force: true });
        processQueue(tabId);

        sendResponse({ ok: true, tabId, waitingForIdle: waitForIdleBeforeStart });
    })().catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
    });
}

function respondWithEnqueueResult(sendResponse, result) {
    sendResponse(result);
    return result;
}

function enqueueToPausedJobResult(tabId, existingJob, message, addToEnd, source) {
    if (addToEnd) {
        existingJob.queue.push(message);
    } else if (existingJob.queue.length > 0) {
        existingJob.queue.splice(1, 0, message);
    } else {
        existingJob.queue.push(message);
    }

    existingJob.totalMessages = getTotalMessages(existingJob) + 1;
    existingJob.updatedAt = Date.now();
    logQueueEvent(tabId, 'info', 'Added command to paused queue.', {
        source,
        totalMessages: getTotalMessages(existingJob),
        remaining: getRemainingCount(existingJob),
        messagePreview: previewText(message, 160)
    });
    updateRunningJobsStorage({ force: true });

    return {
        ok: true,
        queued: true,
        paused: true,
        remaining: getRemainingCount(existingJob),
        message: 'Message added to paused queue. Click Retry to continue.'
    };
}

function enqueueToRunningJobResult(tabId, existingJob, message, addToEnd, source) {
    if (addToEnd) {
        existingJob.queue.push(message);
    } else {
        existingJob.queue.unshift(message);
    }

    existingJob.totalMessages = getTotalMessages(existingJob) + 1;
    existingJob.updatedAt = Date.now();

    logQueueEvent(tabId, 'info', 'Added command to run next in active queue.', {
        source,
        position: addToEnd ? 'end' : 'next',
        totalMessages: getTotalMessages(existingJob),
        remaining: getRemainingCount(existingJob),
        messagePreview: previewText(message, 160)
    });

    updateRunningJobsStorage({ force: true });

    return {
        ok: true,
        queued: true,
        started: false,
        remaining: getRemainingCount(existingJob),
        message: addToEnd
            ? 'Message added to the running queue.'
            : 'Message added next in the running queue.'
    };
}

async function startNewJobFromEnqueueResult(tabId, message, waitForIdleBeforeStart, source, conversationIdentity) {
    const identity = conversationIdentity || await resolveTabConversationIdentity(tabId);
    const provider = identity?.provider || 'chatgpt';
    const conversationType = identity?.type || 'unknown';
    const conversationId = identity?.conversationId || null;
    const targetKey = identity?.key || (conversationId ? `${provider}:c:${conversationId}` : `${provider}:${conversationType}`);

    jobs.set(tabId, {
        tabId,
        provider,
        conversationId,
        conversationType,
        targetKey,
        queue: [message],
        currentMessage: null,
        isRunning: true,
        isPaused: false,
        isStopped: false,
        pausedReason: '',
        lastError: '',
        runId: createRunId(),
        totalMessages: 1,
        completedCount: 0,
        currentCommandNumber: 0,
        currentPhase: waitForIdleBeforeStart ? 'waiting-for-idle' : 'queued',
        waitForIdleBeforeSend: waitForIdleBeforeStart,
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
        ...emptyDeliveryFields(),
        startedAt: Date.now(),
        updatedAt: Date.now()
    });

    logQueueEvent(
        tabId,
        'info',
        waitForIdleBeforeStart
            ? 'Started a new one-command queue that will wait for the current response.'
            : 'Started a new one-command queue.',
        {
            source,
            totalMessages: 1,
            messagePreview: previewText(message, 160)
        }
    );

    await updateRunningJobsStorage({ force: true });
    processQueue(tabId);

    return {
        ok: true,
        queued: true,
        started: true,
        remaining: 1,
        waitingForIdle: waitForIdleBeforeStart,
        message: waitForIdleBeforeStart
            ? 'Message queued to send after the current response.'
            : 'Started a new queue with this message.'
    };
}

async function enqueueMessageInternal({
    tabId,
    message,
    addToEnd = false,
    waitForIdleBeforeStart = false,
    source = 'popup',
    conversationIdentity = null
}) {
    const normalizedTabId = Number(tabId || 0);
    const normalizedMessage = String(message || '').trim();

    if (!normalizedTabId || !normalizedMessage) {
        logQueueEvent(normalizedTabId, 'warn', 'Could not enqueue command: missing tab or message.');
        return { ok: false, error: 'Missing tabId or message.' };
    }

    const existingJob = jobs.get(normalizedTabId);

    const existingJobHasIdentity = existingJob && (
        existingJob.provider ||
        existingJob.conversationId ||
        existingJob.conversationType ||
        existingJob.targetKey
    );

    if (existingJob && existingJobHasIdentity && conversationIdentity && !identitiesMatchForSchedule(
        buildScheduledConversationIdentity(existingJob),
        conversationIdentity
    )) {
        return {
            ok: false,
            error: 'The target conversation changed while the scheduled message was waiting. It was not added to another chat.'
        };
    }

    if (existingJob && existingJob.isPaused) {
        return enqueueToPausedJobResult(normalizedTabId, existingJob, normalizedMessage, addToEnd, source);
    }

    if (existingJob && existingJob.isRunning) {
        return enqueueToRunningJobResult(normalizedTabId, existingJob, normalizedMessage, addToEnd, source);
    }

    return startNewJobFromEnqueueResult(
        normalizedTabId,
        normalizedMessage,
        waitForIdleBeforeStart,
        source,
        conversationIdentity
    );
}

function enqueueToPausedJob(tabId, existingJob, message, addToEnd, source, sendResponse) {
    return respondWithEnqueueResult(
        sendResponse,
        enqueueToPausedJobResult(tabId, existingJob, message, addToEnd, source)
    );
}

function enqueueToRunningJob(tabId, existingJob, message, addToEnd, source, sendResponse) {
    return respondWithEnqueueResult(
        sendResponse,
        enqueueToRunningJobResult(tabId, existingJob, message, addToEnd, source)
    );
}

async function startNewJobFromEnqueue(tabId, message, waitForIdleBeforeStart, source, sendResponse, conversationIdentity) {
    const result = await startNewJobFromEnqueueResult(
        tabId,
        message,
        waitForIdleBeforeStart,
        source,
        conversationIdentity
    );
    return respondWithEnqueueResult(sendResponse, result);
}

function handleEnqueueMessage(request, sender, sendResponse) {
    (async () => {
        const result = await enqueueMessageInternal({
            tabId: Number(request.tabId || sender?.tab?.id || 0),
            message: request.message,
            addToEnd: request.position === 'end',
            waitForIdleBeforeStart: request.waitForIdleBeforeStart === true,
            source: request.source || 'popup',
            conversationIdentity: request.conversationIdentity || null
        });
        sendResponse(result);
    })().catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
    });
}

function handleRetryPausedJob(request, sendResponse) {
    const tabId = request.tabId;
    const job = jobs.get(tabId);

    if (!tabId || !job) {
        logQueueEvent(tabId, 'warn', 'Could not retry paused queue: no queue found.');
        sendResponse({ ok: false, error: 'No queue found for this tab.' });
        return;
    }

    if (!job.isPaused) {
        logQueueEvent(tabId, 'warn', 'Could not retry queue because it is not paused.', {
            status: getJobStatus(job),
            remaining: getRemainingCount(job)
        });
        sendResponse({ ok: false, error: 'This queue is not paused.' });
        return;
    }

    if (job.queue.length === 0 && !job.currentMessage) {
        logQueueEvent(tabId, 'warn', 'Paused queue had no commands left when retry was requested.', {
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job)
        });
        jobs.delete(tabId);
        updateRunningJobsStorage({ force: true });
        sendResponse({ ok: false, error: 'Paused queue has no messages left.' });
        return;
    }

    const resumeConfirmed = isSubmissionConfirmed(job) && !!job.currentMessage;
    job.isPaused = false;
    job.isRunning = true;
    job.isStopped = false;
    job.pausedReason = '';
    job.lastError = '';
    job.currentPhase = resumeConfirmed ? 'awaiting-response' : 'queued';
    job.updatedAt = Date.now();
    resetCommandRetryState(job);
    resetWaitTracking(job);

    logQueueEvent(tabId, 'info', 'Retrying paused queue.', {
        completedCount: job.completedCount || 0,
        totalMessages: getTotalMessages(job),
        remaining: getRemainingCount(job),
        nextMessagePreview: previewText(job.queue[0] || '', 160)
    });

    updateRunningJobsStorage({ force: true });
    processQueue(tabId);

    sendResponse({ ok: true, tabId });
}

function handleStopSequence(request, sendResponse) {
    const tabId = request.tabId;

    if (tabId && jobs.has(tabId)) {
        const job = jobs.get(tabId);
        job.isRunning = false;
        job.isPaused = false;
        job.isStopped = true;

        logQueueEvent(tabId, 'warn', 'Queue stopped manually.', {
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job),
            remaining: getRemainingCount(job),
            currentCommandNumber: job.currentCommandNumber || 0
        });

        jobs.delete(tabId);
        updateRunningJobsStorage({ force: true });

        sendResponse({ ok: true, stopped: 'selected', tabId });
        return;
    }

    sendResponse({ ok: false, error: 'No running or paused queue found for this tab.' });
}

function handleStopAllSequences(sendResponse) {
    for (const [tabId, job] of jobs.entries()) {
        job.isRunning = false;
        job.isPaused = false;
        job.isStopped = true;
        logQueueEvent(tabId, 'warn', 'Queue stopped by Stop all.', {
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job),
            remaining: getRemainingCount(job),
            currentCommandNumber: job.currentCommandNumber || 0
        });
        jobs.delete(tabId);
    }

    updateRunningJobsStorage({ force: true });
    sendResponse({ ok: true, stopped: 'all' });
}

async function processQueue(tabId) {
    const job = jobs.get(tabId);

    if (!job || job.isPaused || !job.isRunning || job.isProcessing) {
        return;
    }

    job.isProcessing = true;

    try {
        while (job.isRunning && !job.isPaused && !job.isStopped) {
            if (job.currentMessage && job.currentPhase === 'terminal') {
                completeCurrentCommand(tabId, job, getTotalMessages(job), collectDeliveryDiagnostics(job, {
                    terminalAckSource: job.terminalAckSource || 'durable-recovery'
                }));
                if (job.queue.length > 0) {
                    await sleep(Number(QUEUE_WAIT_POLICY.interCommandDelayMs) || 0);
                }
                continue;
            }

            if (job.currentMessage && WAITING_COMMAND_PHASES.has(job.currentPhase)) {
                const result = await handleProcessWaiting(tabId, job);
                if (result.action === 'return') return;
                if (result.action === 'continue') continue;
            }

            if (job.currentMessage && job.currentPhase === 'retry-wait') {
                const result = await handleProcessRetryWait(tabId, job);
                if (result.action === 'return') return;
                if (result.action === 'continue') continue;
            }

            if (job.currentMessage && isSubmissionConfirmed(job)) {
                job.currentPhase = 'awaiting-response';
                const result = await handleProcessWaiting(tabId, job);
                if (result.action === 'return') return;
                if (result.action === 'continue') continue;
            }

            if (job.currentMessage) {
                const result = handleProcessRecovered(tabId, job);
                if (result.action === 'continue') continue;
            }

            if (job.queue.length === 0) {
                break;
            }

            if (job.waitForIdleBeforeSend) {
                const validation = await validateJobTargetConversation(tabId, job);
                if (!validation.ok) {
                    logQueueEvent(tabId, 'error', validation.reason, {
                        phase: 'pre-send-validation',
                        mismatch: true
                    });
                    pauseJob(tabId, validation.reason, { phase: 'pre-send-validation', mismatch: true });
                    return;
                }
                const result = await handleProcessWaitForIdle(tabId, job);
                if (result.action === 'return') return;
                if (result.action === 'continue') continue;
            }

            const validation = await validateJobTargetConversation(tabId, job);
            if (!validation.ok) {
                logQueueEvent(tabId, 'error', validation.reason, {
                    phase: 'pre-send-validation',
                    mismatch: true
                });
                pauseJob(tabId, validation.reason, { phase: 'pre-send-validation', mismatch: true });
                return;
            }

            const result = await handleProcessSending(tabId, job);
            if (result.action === 'return') return;
            if (result.action === 'continue') continue;
        }

        if (job.isStopped) {
            jobs.delete(tabId);
            updateRunningJobsStorage({ force: true });
            return;
        }

        if (!job.isPaused && job.queue.length === 0 && !job.currentMessage) {
            logQueueEvent(tabId, 'success', 'Queue completed.', {
                completedCount: job.completedCount || 0,
                totalMessages: getTotalMessages(job)
            });
            jobs.delete(tabId);
            updateRunningJobsStorage({ force: true });
            recordCompletedRun(tabId);
        }
    } catch (error) {
        logQueueEvent(tabId, 'error', 'Unexpected automation error while processing queue.', {
            error: serializeError(error),
            commandNumber: job.currentCommandNumber || 0,
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job),
            remaining: getRemainingCount(job)
        });
        pauseJob(tabId, error?.message || 'Unexpected automation error.', {
            phase: 'unexpected',
            error: serializeError(error)
        });
    } finally {
        if (job) {
            job.isProcessing = false;
        }
    }
}

async function handleProcessWaiting(tabId, job) {
    const totalMessages = getTotalMessages(job);
    const queueSettings = await getQueueSettings();

    logQueueEvent(tabId, 'info', `Resumed waiting for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
        commandNumber: job.currentCommandNumber || 0,
        totalMessages,
        settings: queueSettings
    });

    const waitResult = await waitForTabResponse(tabId, {
        commandNumber: job.currentCommandNumber,
        totalMessages,
        queueSettings,
        commandBinding: getCommandBinding(job)
    });

    if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    if (!waitResult.ok) {
        if (waitResult.isDeliveryTimeout && queueSettings.queueDeliveryTimeoutRefresh !== false) {
            const recoveryResult = await recoverFromDeliveryTimeout(tabId, job, waitResult, totalMessages, queueSettings);
            if (recoveryResult.action === 'complete') {
                completeCurrentCommand(tabId, job, totalMessages, recoveryResult.details || {});
                if (job.queue.length > 0) {
                    await sleep(Number(QUEUE_WAIT_POLICY.interCommandDelayMs) || 0);
                }
                return { action: 'continue' };
            } else if (recoveryResult.action === 'retry') {
                return { action: 'continue' };
            } else if (recoveryResult.action === 'return') {
                return { action: 'return' };
            }
        }

        logQueueEvent(tabId, 'error', `Command ${job.currentCommandNumber}/${totalMessages} failed while waiting for ChatGPT.`, {
            commandNumber: job.currentCommandNumber,
            totalMessages,
            error: waitResult.error || 'ChatGPT response failed.',
            diagnostics: waitResult.details || {}
        });

        if (await retryCurrentCommandIfEnabled(tabId, job, 'wait', waitResult.error || 'ChatGPT response failed.', waitResult.details || {})) {
            return { action: 'continue' };
        }

        pauseJob(tabId, job.lastError || waitResult.error || 'ChatGPT response failed.', {
            phase: 'wait',
            retryClass: job.retryClass || '',
            retryAttemptCount: Number(job.retryAttemptCount || 0),
            diagnostics: waitResult.details || {}
        });
        return { action: 'return' };
    }

    completeCurrentCommand(tabId, job, totalMessages, waitResult.details || {});

    if (job.queue.length > 0) {
        await sleep(Number(QUEUE_WAIT_POLICY.interCommandDelayMs) || 0);
    }

    return { action: 'continue' };
}

function handleProcessRecovered(tabId, job) {
    logQueueEvent(tabId, 'warn', 'Recovered a command without a confirmed waiting state; retrying it before moving forward.', {
        phase: job.currentPhase || '',
        commandNumber: job.currentCommandNumber || 0,
        totalMessages: getTotalMessages(job),
        messagePreview: previewText(job.currentMessage || '', 160)
    });

    job.queue.unshift(job.currentMessage);
    job.currentMessage = null;
    job.currentCommandNumber = 0;
    job.currentPhase = 'queued';
    job.updatedAt = Date.now();
    updateRunningJobsStorage({ force: true });
    return { action: 'continue' };
}

async function handleProcessRetryWait(tabId, job) {
    const remainingMs = Math.max(0, Number(job.nextRetryAt || 0) - Date.now());
    const interrupted = await interruptibleSleep(tabId, job, remainingMs);

    if (interrupted || !jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    if (isSubmissionConfirmed(job) && job.currentMessage) {
        job.currentPhase = 'awaiting-response';
        job.deliveryState = 'confirmed-submission';
        job.nextRetryAt = 0;
        job.updatedAt = Date.now();
        resetWaitTracking(job);
        updateRunningJobsStorage({ force: true });
        return { action: 'continue' };
    }

    if (job.currentMessage) {
        job.queue.unshift(job.currentMessage);
        job.currentMessage = null;
    }

    job.currentCommandNumber = 0;
    job.currentPhase = 'queued';
    job.nextRetryAt = 0;
    job.updatedAt = Date.now();
    resetCommandDeliveryState(job);
    updateRunningJobsStorage({ force: true });
    return { action: 'continue' };
}

async function handleProcessWaitForIdle(tabId, job) {
    const totalMessages = getTotalMessages(job);
    const queueSettings = await getQueueSettings();

    job.currentPhase = 'waiting-for-idle';
    job.updatedAt = Date.now();

    logQueueEvent(tabId, 'info', 'Waiting for the current ChatGPT response before sending queued command.', {
        totalMessages,
        remaining: getRemainingCount(job),
        nextMessagePreview: previewText(job.queue[0] || '', 160),
        settings: queueSettings
    });

    updateRunningJobsStorage();

    const idleResult = await waitForTabResponse(tabId, {
        commandNumber: Number(job.completedCount || 0) + 1,
        totalMessages,
        queueSettings,
        waitForExistingGeneration: true,
        waitLabel: 'the current ChatGPT response'
    });

    if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    if (!idleResult.ok) {
        logQueueEvent(tabId, 'error', 'Failed while waiting for the current ChatGPT response to finish.', {
            error: idleResult.error || 'ChatGPT response failed.',
            diagnostics: idleResult.details || {}
        });

        pauseJob(tabId, idleResult.error || 'ChatGPT response failed.', {
            phase: 'wait-for-idle',
            diagnostics: idleResult.details || {}
        });
        return { action: 'return' };
    }

    job.waitForIdleBeforeSend = false;
    job.currentPhase = 'queued';
    job.updatedAt = Date.now();
    updateRunningJobsStorage();
    await sleep(500);
    return { action: 'continue' };
}

async function handleProcessSending(tabId, job) {
    job.currentMessage = job.queue.shift();
    job.currentCommandNumber = Number(job.completedCount || 0) + 1;
    job.lastError = '';
    job.currentPhase = 'sending';
    job.updatedAt = Date.now();
    resetWaitTracking(job);
    resetCommandDeliveryState(job);
    job.deliveryState = 'pre-click';
    job.commandId = `${job.runId || 'run'}:${job.currentCommandNumber}`;
    job.commandFingerprint = fingerprintCommandTextForJob(job.currentMessage);
    const totalMessages = getTotalMessages(job);
    const queueSettings = await getQueueSettings();

    logQueueEvent(tabId, 'info', `Sending command ${job.currentCommandNumber}/${totalMessages}.`, {
        commandNumber: job.currentCommandNumber,
        totalMessages,
        remainingBeforeSend: getRemainingCount(job),
        messagePreview: previewText(job.currentMessage || '', 160),
        settings: queueSettings,
        ...collectDeliveryDiagnostics(job)
    });

    await updateRunningJobsStorage({ force: true });

    const sendResult = await sendPromptToSpecificTab(tabId, job.currentMessage);

    if (!jobs.has(tabId) || job.isStopped) {
        return { action: 'return' };
    }

    if (!sendResult.ok) {
        logQueueEvent(tabId, 'error', `Failed to submit command ${job.currentCommandNumber}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber,
            totalMessages,
            error: sendResult.error || 'Could not send message to ChatGPT.',
            diagnostics: collectDeliveryDiagnostics(job, sendResult.details || {})
        });

        if (await retryCurrentCommandIfEnabled(tabId, job, 'send', sendResult.error || 'Could not send message to ChatGPT.', sendResult.details || {})) {
            return { action: 'continue' };
        }

        pauseJob(tabId, job.lastError || sendResult.error || 'Could not send message to ChatGPT.', {
            phase: 'send',
            retryClass: job.retryClass || '',
            retryAttemptCount: Number(job.retryAttemptCount || 0),
            diagnostics: sendResult.details || {}
        });
        return { action: 'return' };
    }

    job.currentPhase = 'awaiting-response';
    job.deliveryState = 'confirmed-submission';
    job.submittedUserTurnId = sendResult.details?.userTurnId || job.submittedUserTurnId || null;
    job.submissionAckSource = sendResult.details?.submissionAckSource || job.submissionAckSource || '';
    job.commandFingerprint = sendResult.details?.commandFingerprint || job.commandFingerprint;
    job.updatedAt = Date.now();
    await updateRunningJobsStorage({ force: true });

    logQueueEvent(tabId, 'success', `Submitted command ${job.currentCommandNumber}/${totalMessages}.`, {
        commandNumber: job.currentCommandNumber,
        totalMessages,
        diagnostics: collectDeliveryDiagnostics(job, {
            submissionAckSource: job.submissionAckSource,
            userTurnId: job.submittedUserTurnId
        })
    });

    const waitResult = await waitForTabResponse(tabId, {
        commandNumber: job.currentCommandNumber,
        totalMessages,
        queueSettings,
        commandBinding: getCommandBinding(job)
    });

    if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    if (!waitResult.ok) {
        if (waitResult.isDeliveryTimeout && queueSettings.queueDeliveryTimeoutRefresh !== false) {
            const recoveryResult = await recoverFromDeliveryTimeout(tabId, job, waitResult, totalMessages, queueSettings);
            if (recoveryResult.action === 'complete') {
                completeCurrentCommand(tabId, job, totalMessages, recoveryResult.details || {});
                if (job.queue.length > 0) {
                    await sleep(Number(QUEUE_WAIT_POLICY.interCommandDelayMs) || 0);
                }
                return { action: 'next' };
            } else if (recoveryResult.action === 'retry') {
                return { action: 'continue' };
            } else if (recoveryResult.action === 'return') {
                return { action: 'return' };
            }
        }

        logQueueEvent(tabId, 'error', `Command ${job.currentCommandNumber}/${totalMessages} failed while waiting for ChatGPT.`, {
            commandNumber: job.currentCommandNumber,
            totalMessages,
            error: waitResult.error || 'ChatGPT response failed.',
            diagnostics: waitResult.details || {}
        });

        if (await retryCurrentCommandIfEnabled(tabId, job, 'wait', waitResult.error || 'ChatGPT response failed.', waitResult.details || {})) {
            return { action: 'continue' };
        }

        pauseJob(tabId, job.lastError || waitResult.error || 'ChatGPT response failed.', {
            phase: 'wait',
            retryClass: job.retryClass || '',
            retryAttemptCount: Number(job.retryAttemptCount || 0),
            diagnostics: waitResult.details || {}
        });
        return { action: 'return' };
    }

    completeCurrentCommand(tabId, job, totalMessages, waitResult.details || {});

    if (job.queue.length > 0) {
        await sleep(Number(QUEUE_WAIT_POLICY.interCommandDelayMs) || 0);
    }

    return { action: 'next' };
}

function completeCurrentCommand(tabId, job, totalMessages, diagnostics = {}) {
    job.completedCount = Number(job.completedCount || 0) + 1;
    const terminalAckSource = diagnostics.terminalAckSource || job.terminalAckSource ||
        (diagnostics.recoveredViaBackendCompletion ? 'backend-completion' : '');

    logQueueEvent(tabId, 'success', `Completed command ${job.completedCount}/${totalMessages}.`, {
        commandNumber: job.completedCount,
        totalMessages,
        remaining: Math.max(0, job.queue.length),
        diagnostics: collectDeliveryDiagnostics(job, {
            ...diagnostics,
            terminalAckSource
        })
    });

    job.currentMessage = null;
    job.currentCommandNumber = 0;
    job.currentPhase = 'queued';
    job.deliveryTimeoutAttempts = 0;
    job.updatedAt = Date.now();
    resetCommandRetryState(job);
    resetWaitTracking(job);
    resetCommandDeliveryState(job);
    updateRunningJobsStorage({ force: true });
}

function pauseJob(tabId, reason, details = {}) {
    const job = jobs.get(tabId);
    if (!job) return;

    const failedMessage = job.currentMessage || '';
    const confirmed = isSubmissionConfirmed(job);

    if (!confirmed && job.currentMessage) {
        job.queue.unshift(job.currentMessage);
        job.currentMessage = null;
        job.currentCommandNumber = 0;
        resetCommandDeliveryState(job);
    }

    job.isRunning = false;
    job.isPaused = true;
    job.isStopped = false;
    job.pausedReason = reason || 'Queue paused because ChatGPT failed.';
    job.lastError = job.pausedReason;
    job.currentPhase = 'paused';
    job.updatedAt = Date.now();
    resetWaitTracking(job);

    logQueueEvent(tabId, 'error', 'Queue paused.', {
        reason: job.pausedReason,
        commandNumber: job.currentCommandNumber || 0,
        completedCount: job.completedCount || 0,
        totalMessages: getTotalMessages(job),
        remaining: getRemainingCount(job),
        failedMessagePreview: previewText(failedMessage, 160),
        ...collectDeliveryDiagnostics(job),
        ...details
    });

    if (!confirmed) {
        job.currentCommandNumber = 0;
    }

    updateRunningJobsStorage({ force: true });

    notifyRuntime({
        action: 'automationPaused',
        tabId,
        error: job.pausedReason
    });
}

function resetCommandRetryState(job) {
    if (!job) return;
    job.retryAttemptCount = 0;
    job.lastRetryableReason = '';
    job.retryClass = '';
    job.retryMode = '';
    job.nextRetryDelayMs = 0;
    job.nextRetryAt = 0;
    job.retryExhausted = false;
}

function resetWaitTracking(job) {
    if (!job) return;
    job.waitStartedAt = 0;
    job.lastResearchProgressAt = 0;
    job.sawDeepResearch = false;
    job.sawGenerating = false;
}

function emptyDeliveryFields() {
    return {
        deliveryState: '',
        commandId: '',
        commandFingerprint: '',
        submittedUserTurnId: null,
        assistantTurnId: null,
        submissionAckSource: '',
        terminalAckSource: '',
        lastResponsePhase: ''
    };
}

function fingerprintCommandTextForJob(text) {
    if (typeof globalThis !== 'undefined' && typeof globalThis.fingerprintCommandText === 'function') {
        return globalThis.fingerprintCommandText(text);
    }
    const provider = getActiveProviderAdapter('chatgpt');
    if (provider && typeof provider.fingerprintCommandText === 'function') {
        return provider.fingerprintCommandText(text);
    }
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i += 1) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16)}:len:${normalized.length}`;
}

function isSubmissionConfirmed(job) {
    if (!job) return false;
    if (job.submittedUserTurnId) return true;
    return CONFIRMED_DELIVERY_STATES.has(String(job.deliveryState || ''));
}

function resetCommandDeliveryState(job) {
    if (!job) return;
    const cleared = emptyDeliveryFields();
    job.deliveryState = cleared.deliveryState;
    job.commandId = cleared.commandId;
    job.commandFingerprint = cleared.commandFingerprint;
    job.submittedUserTurnId = cleared.submittedUserTurnId;
    job.assistantTurnId = cleared.assistantTurnId;
    job.submissionAckSource = cleared.submissionAckSource;
    job.terminalAckSource = cleared.terminalAckSource;
    job.lastResponsePhase = cleared.lastResponsePhase;
}

function getCommandBinding(job, context = {}) {
    if (context.commandBinding && typeof context.commandBinding === 'object') {
        return context.commandBinding;
    }
    return {
        userTurnId: job?.submittedUserTurnId || null,
        assistantTurnId: job?.assistantTurnId || null,
        conversationId: job?.conversationId || null,
        commandFingerprint: job?.commandFingerprint || '',
        commandId: job?.commandId || ''
    };
}

function collectDeliveryDiagnostics(job, extra = {}) {
    return {
        runId: job?.runId || '',
        commandId: job?.commandId || '',
        commandNumber: job?.currentCommandNumber || 0,
        deliveryState: job?.deliveryState || '',
        submissionAckSource: job?.submissionAckSource || '',
        terminalAckSource: job?.terminalAckSource || extra.terminalAckSource || '',
        userTurnId: job?.submittedUserTurnId || extra.userTurnId || null,
        assistantTurnId: job?.assistantTurnId || extra.assistantTurnId || null,
        lastResponsePhase: job?.lastResponsePhase || extra.phase || '',
        commandFingerprint: job?.commandFingerprint || '',
        ...extra
    };
}

function persistCommandDelivery(tabId, job, patch = {}) {
    if (!job) return;
    Object.assign(job, patch);
    job.updatedAt = Date.now();
    updateRunningJobsStorage({ force: true });
}

function getRetryBackoffDelayMs(attemptCount, unlimited = false) {
    if (unlimited) {
        return Math.max(1, Number(QUEUE_RETRY_POLICY.unlimitedDelayMs) || UNLIMITED_RETRY_DELAY_MS);
    }

    const exponent = Math.max(0, Number(attemptCount) || 0);
    const delay = Number(QUEUE_RETRY_POLICY.backoffBaseMs) * Math.pow(Number(QUEUE_RETRY_POLICY.backoffFactor) || 2, exponent);
    const maxDelay = Number(QUEUE_RETRY_POLICY.backoffMaxMs) || delay;
    return Math.max(1, Math.min(maxDelay, delay));
}

/**
 * @param {string} phase
 * @param {string} [reason]
 * @param {Record<string, any>} [diagnostics]
 * @returns {{ class: QueueFailureClass, retryable: boolean, reason: string }}
 */
function classifyQueueFailure(phase, reason, diagnostics = {}) {
    const details = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
    const state = details.state && typeof details.state === 'object' ? details.state : {};
    const message = String(reason || details.error || '');
    const forcedClass = String(details.failureClass || '');

    let failureClass = forcedClass;
    if (!failureClass) {
        if (details.stopped === true || /queue was stopped/i.test(message)) {
            failureClass = 'user-stop';
        } else if (details.compatibilityFailure || /compatibility failure/i.test(message)) {
            failureClass = 'compatibility';
        } else if (details.stalledResearch === true || /stalled deep research/i.test(message)) {
            failureClass = 'stalled-research';
        } else if (state.hasTryAgainButton) {
            failureClass = 'retry-visible';
        } else if (state.hasDeliveryTimedOut || /delivery time/i.test(message)) {
            failureClass = 'timeout';
        } else if (/waiting for the user/i.test(message) || state.phase === 'waiting-for-user') {
            failureClass = 'waiting-for-user';
        } else if (/response was interrupted/i.test(message) || state.phase === 'interrupted') {
            failureClass = 'interrupted';
        } else if (/not acknowledged as a new user turn/i.test(message)) {
            failureClass = 'submission-unconfirmed';
        } else if (state.hasError || /chatgpt showed an error|error or retry state/i.test(message)) {
            failureClass = 'generation-error';
        } else if (/timed out waiting/i.test(message)) {
            failureClass = 'timeout';
        } else if (/could not read|could not inspect|could not send/i.test(message)) {
            failureClass = 'transient';
        } else if (/queue was paused/i.test(message)) {
            failureClass = 'non-retryable';
        } else if (phase === 'send' || phase === 'wait') {
            failureClass = 'transient';
        } else {
            failureClass = 'non-retryable';
        }
    }

    if ((failureClass === 'generation-error' || failureClass === 'retry-visible') && state.hasTryAgainButton) {
        failureClass = 'retry-visible';
    }

    const retryable = RETRYABLE_FAILURE_CLASSES.has(failureClass);
    return {
        class: failureClass,
        retryable,
        reason: message || 'Queue command failed.'
    };
}

function getRetryExhaustionReason(job, lastReason) {
    const attempts = Number(job?.retryAttemptCount || 0);
    const reason = lastReason || job?.lastRetryableReason || job?.lastError || 'ChatGPT response failed.';
    return `Automatic retry exhausted after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${reason}`;
}

async function interruptibleSleep(tabId, job, ms) {
    const duration = Math.max(0, Number(ms) || 0);
    const deadline = Date.now() + duration;
    const sliceMs = Math.max(5, Number(QUEUE_RETRY_POLICY.sleepSliceMs) || 250);

    while (Date.now() < deadline) {
        if (!jobs.has(tabId) || !job || job.isStopped || job.isPaused || !job.isRunning) {
            return true;
        }
        await sleep(Math.min(sliceMs, deadline - Date.now()));
    }

    return !jobs.has(tabId) || !job || job.isStopped || job.isPaused || !job.isRunning;
}

async function retryCurrentCommandIfEnabled(tabId, job, phase, reason, diagnostics = {}) {
    if (!job || job.isStopped || job.isPaused || !job.isRunning) {
        return false;
    }

    if (!job.currentMessage) {
        return false;
    }

    const classification = classifyQueueFailure(phase, reason, diagnostics);
    job.retryClass = classification.class;
    job.lastRetryableReason = classification.reason;

    if (!classification.retryable) {
        job.lastError = classification.reason;
        job.updatedAt = Date.now();
        return false;
    }

    const queueSettings = await getQueueSettings();
    const unlimited = queueSettings.queueUnlimitedRetryWait === true;
    const maxAttempts = unlimited ? Number.POSITIVE_INFINITY : Number(QUEUE_RETRY_POLICY.maxAutomaticAttempts);
    const attemptCount = Number(job.retryAttemptCount || 0);

    if (attemptCount >= maxAttempts) {
        job.retryExhausted = true;
        job.retryMode = unlimited ? 'unlimited' : 'finite';
        job.lastError = getRetryExhaustionReason(job, classification.reason);
        job.updatedAt = Date.now();
        logQueueEvent(tabId, 'error', job.lastError, {
            phase,
            retryClass: classification.class,
            retryAttemptCount: attemptCount,
            retryMode: job.retryMode,
            commandNumber: job.currentCommandNumber || 0,
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job),
            diagnostics
        });
        return false;
    }

    const delayMs = getRetryBackoffDelayMs(attemptCount, unlimited);
    job.retryAttemptCount = attemptCount + 1;
    job.retryMode = unlimited ? 'unlimited' : 'finite';
    job.retryExhausted = false;
    job.nextRetryDelayMs = delayMs;
    job.nextRetryAt = Date.now() + delayMs;
    job.lastError = classification.reason;
    job.currentPhase = 'retry-wait';
    job.updatedAt = Date.now();
    resetWaitTracking(job);
    updateRunningJobsStorage({ force: true });

    logQueueEvent(tabId, 'warn', `${unlimited ? 'Unlimited' : 'Automatic'} retry ${job.retryAttemptCount}${unlimited ? '' : `/${maxAttempts}`} will retry command ${job.currentCommandNumber || '?'}/${getTotalMessages(job)}.`, {
        phase,
        reason: classification.reason,
        retryClass: classification.class,
        retryMode: job.retryMode,
        retryAttemptCount: job.retryAttemptCount,
        retryInSeconds: Math.round(delayMs / 1000),
        commandNumber: job.currentCommandNumber || 0,
        completedCount: job.completedCount || 0,
        totalMessages: getTotalMessages(job),
        remaining: getRemainingCount(job),
        diagnostics
    });

    const interrupted = await interruptibleSleep(tabId, job, delayMs);
    if (interrupted || !jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return false;
    }

    if (isSubmissionConfirmed(job) && job.currentMessage) {
        job.currentPhase = 'awaiting-response';
        job.deliveryState = 'confirmed-submission';
        job.nextRetryAt = 0;
        job.updatedAt = Date.now();
        resetWaitTracking(job);
        updateRunningJobsStorage({ force: true });
        return true;
    }

    job.queue.unshift(job.currentMessage);
    job.currentMessage = null;
    job.currentCommandNumber = 0;
    job.currentPhase = 'queued';
    job.nextRetryAt = 0;
    job.updatedAt = Date.now();
    resetCommandDeliveryState(job);
    updateRunningJobsStorage({ force: true });

    return true;
}

async function refreshChatGPTTab(tabId) {
    try {
        const response = await sendTabMessage(tabId, { type: 'RELOAD_PAGE' });
        if (response && response.ok) {
            return true;
        }
    } catch {}

    if (chrome.tabs && typeof chrome.tabs.reload === 'function') {
        try {
            await new Promise((resolve) => {
                chrome.tabs.reload(tabId, {}, () => resolve());
            });
            return true;
        } catch {}
    }

    if (chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    if (typeof window !== 'undefined' && window.location) {
                        window.location.reload();
                    }
                }
            });
            return true;
        } catch {}
    }

    return false;
}

async function waitForTabToRecover(tabId, maxWaitMs = 30000) {
    const started = Date.now();
    await sleep(1500);

    while (Date.now() - started < maxWaitMs) {
        try {
            const resp = await sendTabMessage(tabId, { type: 'CHECK_GENERATION_STATE' });
            if (resp && resp.state) {
                return true;
            }
        } catch {}

        await sleep(1000);
    }

    return false;
}

async function recoverFromDeliveryTimeout(tabId, job, waitResult, totalMessages, queueSettings) {
    if (!job || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    job.deliveryTimeoutAttempts = Number(job.deliveryTimeoutAttempts || 0) + 1;
    const attempt = job.deliveryTimeoutAttempts;
    const maxAttempts = queueSettings.queueUnlimitedRetryWait ? Number.POSITIVE_INFINITY : 3;

    if (attempt > maxAttempts) {
        logQueueEvent(tabId, 'error', `Exceeded maximum delivery timeout recovery attempts (${maxAttempts}) for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            attempts: attempt,
            maxAttempts
        });
        return { action: 'fail' };
    }

    job.currentPhase = 'recovering';
    job.updatedAt = Date.now();
    await updateRunningJobsStorage({ force: true });

    // Stage 1: In-page retry if a retry/regenerate button is currently present
    const hasTryAgain = !!waitResult?.details?.state?.hasTryAgainButton;
    if (hasTryAgain) {
        logQueueEvent(tabId, 'info', `Delivery timeout detected. Attempting in-page retry (attempt ${attempt}/${maxAttempts === Number.POSITIVE_INFINITY ? 'unlimited' : maxAttempts}) for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            attempt
        });

        try {
            const clickRes = await sendTabMessage(tabId, { type: 'CLICK_RETRY_BUTTON' });
            if (clickRes && clickRes.ok) {
                await sleep(2000);

                if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
                    return { action: 'return' };
                }

                const check = await sendTabMessage(tabId, { type: 'CHECK_GENERATION_STATE' }).catch(() => null);
                if (check?.state?.generating || check?.state?.deepResearchActive) {
                    logQueueEvent(tabId, 'info', `In-page retry resumed response for command ${job.currentCommandNumber || '?'}/${totalMessages}. Waiting for completion...`, {
                        commandNumber: job.currentCommandNumber || 0,
                        totalMessages
                    });

                    job.currentPhase = 'awaiting-response';
                    job.sawGenerating = job.sawGenerating || !!check?.state?.generating;
                    job.sawDeepResearch = job.sawDeepResearch || !!check?.state?.deepResearchActive;
                    job.updatedAt = Date.now();
                    await updateRunningJobsStorage({ force: true });

                    const retryWait = await waitForTabResponse(tabId, {
                        commandNumber: job.currentCommandNumber,
                        totalMessages,
                        queueSettings,
                        commandBinding: getCommandBinding(job)
                    });

                    if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
                        return { action: 'return' };
                    }

                    if (retryWait.ok) {
                        job.deliveryTimeoutAttempts = 0;
                        return { action: 'complete', details: retryWait.details || {} };
                    }
                }
            }
        } catch (err) {
            console.warn('In-page retry button click failed, proceeding to reload:', err);
        }
    }

    if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    // Stage 2: Refresh page to reconnect streaming connection
    logQueueEvent(tabId, 'warn', `Delivery timeout detected. Refreshing ChatGPT tab to recover stream (attempt ${attempt}/${maxAttempts === Number.POSITIVE_INFINITY ? 'unlimited' : maxAttempts}) for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
        commandNumber: job.currentCommandNumber || 0,
        totalMessages,
        attempt
    });

    const reloaded = await refreshChatGPTTab(tabId);
    if (!reloaded) {
        logQueueEvent(tabId, 'error', `Could not reload ChatGPT tab ${tabId}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages
        });
        return { action: 'fail' };
    }

    const recovered = await waitForTabToRecover(tabId, 30000);
    if (!recovered) {
        logQueueEvent(tabId, 'error', `ChatGPT tab did not become responsive within 30s after reload.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages
        });
        return { action: 'fail' };
    }

    // Allow DOM to settle after reloaded content script responds
    await sleep(2500);

    if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    const inspect = await sendTabMessage(tabId, { type: 'INSPECT_GENERATION_STATE' }).catch(() => null);
    const reloadedState = inspect?.state || {};
    const lastAssistant = inspect?.lastAssistant || null;

    // Case 0: Page reloaded and is actively generating
    if (reloadedState.generating || reloadedState.deepResearchActive) {
        logQueueEvent(tabId, 'info', `ChatGPT resumed generating after reload for command ${job.currentCommandNumber || '?'}/${totalMessages}. Waiting for completion...`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages
        });

        job.currentPhase = 'awaiting-response';
        job.sawGenerating = job.sawGenerating || !!reloadedState.generating;
        job.sawDeepResearch = job.sawDeepResearch || !!reloadedState.deepResearchActive;
        job.updatedAt = Date.now();
        await updateRunningJobsStorage({ force: true });

        const postReloadWait = await waitForTabResponse(tabId, {
            commandNumber: job.currentCommandNumber,
            totalMessages,
            queueSettings,
            commandBinding: getCommandBinding(job)
        });

        if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
            return { action: 'return' };
        }

        if (postReloadWait.ok) {
            job.deliveryTimeoutAttempts = 0;
            return { action: 'complete', details: postReloadWait.details || {} };
        }
    }

    // Case A: Completed on backend prior to or during reload
    if (lastAssistant && lastAssistant.hasCompletedText) {
        logQueueEvent(tabId, 'success', `Response completed on backend prior to reload for command ${job.currentCommandNumber || '?'}/${totalMessages}. Advancing queue.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            recoveredTurnPreview: previewText(lastAssistant.text, 140)
        });
        job.deliveryTimeoutAttempts = 0;
        return {
            action: 'complete',
            details: {
                recoveredViaBackendCompletion: true,
                terminalAckSource: 'backend-completion',
                assistantPreview: previewText(lastAssistant.text, 140)
            }
        };
    }

    // Case B: Retry / Regenerate button present on reloaded page
    if (reloadedState.hasTryAgainButton || lastAssistant?.hasRetry) {
        logQueueEvent(tabId, 'info', `Found Regenerate/Try Again button on reloaded page. Clicking for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages
        });

        try {
            const clickResult = await sendTabMessage(tabId, { type: 'CLICK_RETRY_BUTTON' });
            if (clickResult && clickResult.ok) {
                await sleep(2000);

                if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
                    return { action: 'return' };
                }

                job.currentPhase = 'awaiting-response';
                job.updatedAt = Date.now();
                await updateRunningJobsStorage({ force: true });

                const retryWait = await waitForTabResponse(tabId, {
                    commandNumber: job.currentCommandNumber,
                    totalMessages,
                    queueSettings,
                    commandBinding: getCommandBinding(job)
                });

                if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
                    return { action: 'return' };
                }

                if (retryWait.ok) {
                    job.deliveryTimeoutAttempts = 0;
                    return { action: 'complete', details: retryWait.details || {} };
                }
            }
        } catch (err) {
            console.warn('Clicking retry button after reload failed:', err);
        }
    }

    // Case C: Turn not completed and no retry button.
    if (isSubmissionConfirmed(job)) {
        logQueueEvent(tabId, 'warn', `Delivery timeout recovery kept the confirmed command without resending.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            ...collectDeliveryDiagnostics(job)
        });
        job.currentPhase = 'awaiting-response';
        job.updatedAt = Date.now();
        await updateRunningJobsStorage({ force: true });
        return { action: 'retry' };
    }

    if (job.currentMessage) {
        logQueueEvent(tabId, 'info', `Re-submitting prompt after reload for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            messagePreview: previewText(job.currentMessage, 140)
        });

        job.queue.unshift(job.currentMessage);
        job.currentMessage = null;
        job.currentCommandNumber = 0;
        job.currentPhase = 'queued';
        job.updatedAt = Date.now();
        resetCommandDeliveryState(job);
        await updateRunningJobsStorage({ force: true });

        return { action: 'retry' };
    }

    return { action: 'fail' };
}

/**
 * @param {number} tabId
 * @param {{ expectedText?: string, expectedFingerprint?: string }} [options]
 */
async function inspectTabCommandTurns(tabId, { expectedText, expectedFingerprint } = {}) {
    try {
        const response = await sendTabMessage(tabId, {
            type: 'GET_COMMAND_TURN_SNAPSHOT',
            expectedText,
            expectedFingerprint
        });
        if (response && response.snapshot) {
            return {
                ok: true,
                snapshot: response.snapshot,
                source: 'content-script'
            };
        }
        if (response) {
            return {
                ok: false,
                snapshot: { userTurns: [], assistantTurns: [], latestUserTurnId: null, matchedUserTurnId: null },
                source: 'content-script'
            };
        }
    } catch {
        // Fall through to injected inspection.
    }

    try {
        const results = await executeScript({
            target: { tabId },
            func: (expected) => {
                const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                const expectedText = normalize(expected);
                const nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-testid*="conversation-turn"], article'));
                const userTurns = [];
                nodes.forEach((node, index) => {
                    const role = node.getAttribute('data-message-author-role') || '';
                    const hasUserChild = !!node.querySelector?.('[data-message-author-role="user"]');
                    if (role !== 'user' && !hasUserChild) {
                        return;
                    }
                    const host = /** @type {HTMLElement} */ (node);
                    const text = normalize(host.innerText || host.textContent || '');
                    if (!text) {
                        return;
                    }
                    userTurns.push({
                        turnId: node.getAttribute('data-message-id') || node.getAttribute('data-testid') || `user:${index}`,
                        index,
                        fingerprint: `len:${text.length}`,
                        matchedExpected: !!expectedText && text === expectedText
                    });
                });
                return {
                    ok: true,
                    snapshot: {
                        userTurns,
                        assistantTurns: [],
                        latestUserTurnId: userTurns.length > 0 ? userTurns[userTurns.length - 1].turnId : null,
                        matchedUserTurnId: (userTurns.find(turn => turn.matchedExpected) || {}).turnId || null,
                        supportsCommandTurnAck: true
                    }
                };
            },
            args: [expectedText || '']
        });
        const result = results?.[0]?.result;
        if (result && result.ok && result.snapshot) {
            return {
                ok: true,
                snapshot: result.snapshot,
                source: 'injected-script'
            };
        }
    } catch {
        // Ignore inspect failures; caller treats missing snapshot as unconfirmed.
    }

    return {
        ok: false,
        snapshot: { userTurns: [], assistantTurns: [], latestUserTurnId: null, matchedUserTurnId: null },
        source: 'unavailable'
    };
}

/**
 * @param {number} tabId
 * @param {{ expectedText?: string, beforeSnapshot?: { userTurns?: Array<{ turnId?: string, matchedExpected?: boolean, fingerprint?: string }>, latestUserTurnId?: string|null, matchedUserTurnId?: string|null, conversationId?: string|null }, timeoutMs?: number, pollMs?: number }} [options]
 */
async function waitForSubmissionAck(tabId, { expectedText, beforeSnapshot, timeoutMs, pollMs } = {}) {
    const job = jobs.get(tabId);
    const provider = getActiveProviderAdapter(job?.provider) || getActiveProviderAdapter('chatgpt');
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : QUEUE_WAIT_POLICY.submissionAckTimeoutMs;
    const interval = Number(pollMs) > 0 ? Number(pollMs) : QUEUE_WAIT_POLICY.submissionAckPollMs;
    const startedAt = Date.now();
    const beforeIds = new Set((beforeSnapshot?.userTurns || []).map(turn => turn.turnId));
    const supportsTurnAck = provider?.supportsCommandTurnAck !== false;

    if (job) {
        persistCommandDelivery(tabId, job, {
            currentPhase: 'awaiting-submission-ack',
            deliveryState: 'unknown-acceptance'
        });
    }

    while (Date.now() - startedAt <= timeout) {
        const liveJob = jobs.get(tabId);
        if (liveJob && (liveJob.isStopped || liveJob.isPaused || !liveJob.isRunning)) {
            return {
                ok: false,
                error: liveJob.isStopped ? 'Queue was stopped.' : 'Queue was paused.',
                details: { failureClass: liveJob.isStopped ? 'user-stop' : 'non-retryable' }
            };
        }

        if (supportsTurnAck) {
            const inspected = await inspectTabCommandTurns(tabId, {
                expectedText,
                expectedFingerprint: liveJob?.commandFingerprint || fingerprintCommandTextForJob(expectedText)
            });
            const snapshot = inspected.snapshot || { userTurns: [] };
            const matched = (snapshot.userTurns || []).find(turn => turn.matchedExpected && !beforeIds.has(turn.turnId)) ||
                (snapshot.matchedUserTurnId && !beforeIds.has(snapshot.matchedUserTurnId)
                    ? (snapshot.userTurns || []).find(turn => turn.turnId === snapshot.matchedUserTurnId)
                    : null);

            if (matched) {
                if (liveJob) {
                    persistCommandDelivery(tabId, liveJob, {
                        deliveryState: 'confirmed-submission',
                        submittedUserTurnId: matched.turnId,
                        submissionAckSource: inspected.source || 'user-turn',
                        commandFingerprint: matched.fingerprint || liveJob.commandFingerprint
                    });
                }
                return {
                    ok: true,
                    details: {
                        submissionAckSource: inspected.source || 'user-turn',
                        userTurnId: matched.turnId,
                        previousUserTurnId: beforeSnapshot?.latestUserTurnId || null,
                        conversationId: snapshot.conversationId || liveJob?.conversationId || null,
                        commandFingerprint: matched.fingerprint || fingerprintCommandTextForJob(expectedText),
                        userTurnCount: (snapshot.userTurns || []).length
                    }
                };
            }
        } else {
            try {
                const response = await sendTabMessage(tabId, { type: 'CHECK_GENERATION_STATE' });
                const state = response?.state || {};
                if (state.generating || state.deepResearchActive) {
                    if (liveJob) {
                        persistCommandDelivery(tabId, liveJob, {
                            deliveryState: 'confirmed-submission',
                            submissionAckSource: 'generation-started'
                        });
                    }
                    return {
                        ok: true,
                        details: {
                            submissionAckSource: 'generation-started',
                            userTurnId: null,
                            previousUserTurnId: beforeSnapshot?.latestUserTurnId || null
                        }
                    };
                }
            } catch {
                // Keep polling until timeout.
            }
        }

        await sleep(interval);
    }

    return {
        ok: false,
        error: 'Send was not acknowledged as a new user turn.',
        details: {
            failureClass: 'submission-unconfirmed',
            supportsCommandTurnAck: supportsTurnAck
        }
    };
}

async function sendPromptToSpecificTab(tabId, text) {
    try {
        let tabUrl = '';
        try {
            const tab = await getTab(tabId);
            tabUrl = tab?.url || tab?.pendingUrl || '';
        } catch {
            tabUrl = '';
        }

        const job = jobs.get(tabId);
        const provider = getActiveProviderAdapter(tabUrl) ||
            getActiveProviderAdapter(job?.provider) ||
            getActiveProviderAdapter('chatgpt');
        const providerName = provider?.name || 'Provider';
        const compatibilityContract = provider && typeof provider.getCompatibilityContract === 'function'
            ? provider.getCompatibilityContract()
            : { provider: provider?.id || 'unknown', version: 1, selectors: {}, signals: {} };

        const beforeInspect = await inspectTabCommandTurns(tabId, {
            expectedText: text,
            expectedFingerprint: job?.commandFingerprint || fingerprintCommandTextForJob(text)
        });
        if (job) {
            persistCommandDelivery(tabId, job, {
                currentPhase: 'sending',
                deliveryState: 'pre-click'
            });
        }

        const results = await executeScript({
            target: { tabId },
            func: async (msg, contract, providerName) => {
                function sleepInPage(ms) {
                    return new Promise(resolve => {
                        setTimeout(resolve, ms);
                    });
                }

                function describeElement(element) {
                    if (!element) return null;

                    return {
                        tagName: element.tagName || '',
                        id: element.id || '',
                        testId: element.getAttribute('data-testid') || element.getAttribute('data-test-id') || '',
                        ariaLabel: element.getAttribute('aria-label') || '',
                        textLength: (element.innerText || element.textContent || element.value || '').length,
                        disabled: !!element.disabled,
                        ariaDisabled: element.getAttribute('aria-disabled') || ''
                    };
                }

                function getSelectorList(signalKey) {
                    return Array.isArray(contract?.selectors?.[signalKey])
                        ? contract.selectors[signalKey]
                        : [];
                }

                function getCandidates(signalKey) {
                    const candidates = [];
                    const seen = new Set();
                    for (const selector of getSelectorList(signalKey)) {
                        let elements = [];
                        try {
                            elements = Array.from(document.querySelectorAll(selector));
                        } catch {
                            elements = [];
                        }
                        for (const element of elements) {
                            if (!seen.has(element)) {
                                seen.add(element);
                                candidates.push({ element, selector, signalKey });
                            }
                        }
                    }
                    return candidates;
                }

                function isComposerCandidate(element, selector) {
                    const tagName = (element?.tagName || '').toLowerCase();
                    const isEditable = tagName === 'textarea' || element?.getAttribute('contenteditable') === 'true';
                    if (!isEditable || element.closest?.('#cpo-root')) return false;

                    const messageContext = contract?.signals?.messageContext || [];
                    if (messageContext.length > 0 && element.closest?.(messageContext.join(','))) {
                        return false;
                    }

                    const weakComposerSelectors = contract?.signals?.weakComposerSelectors || [];
                    if (weakComposerSelectors.includes(selector)) {
                        const composerContext = contract?.signals?.composerContext || [];
                        return composerContext.length > 0 && !!element.closest?.(composerContext.join(','));
                    }

                    return true;
                }

                function isSendActionCandidate(element, selector) {
                    const tagName = (element?.tagName || '').toLowerCase();
                    if (tagName !== 'button' && typeof element?.click !== 'function') return false;

                    const weakSendButtonSelectors = contract?.signals?.weakSendButtonSelectors || [];
                    if (!weakSendButtonSelectors.includes(selector)) return true;

                    const composerContext = contract?.signals?.composerContext || [];
                    return composerContext.length > 0 && !!element.closest?.(composerContext.join(','));
                }

                function findMatch(signalKey, predicate = null) {
                    return getCandidates(signalKey).find(match => !predicate || predicate(match.element, match.selector)) || {
                        element: null,
                        selector: '',
                        signalKey
                    };
                }

                function compatibilityFailure(signalKey, message, details = {}) {
                    return {
                        ok: false,
                        error: `${providerName || 'Provider'} compatibility failure: ${message}`,
                        details: {
                            compatibilityFailure: signalKey,
                            signalKey,
                            provider: providerName || '',
                            url: location.href,
                            title: document.title,
                            ...details
                        }
                    };
                }

                function getComposerText(element) {
                    if (!element) return '';

                    const tagName = (element.tagName || '').toLowerCase();
                    if (tagName === 'textarea') {
                        return String(element.value || '');
                    }

                    const directText = element.innerText || element.textContent || '';
                    if (directText) return String(directText);

                    // Lightweight test DOMs do not always maintain a parent's
                    // textContent after appendChild. Reading child text here
                    // also matches the browser's contenteditable text.
                    return Array.from(element.children || [])
                        .map(child => child.innerText || child.textContent || '')
                        .join('');
                }

                function normalizeComposerText(value) {
                    return String(value || '').replace(/\u200b/g, '').trim();
                }

                function setComposerText(element, value) {
                    const nextText = String(value || '');
                    const tagName = (element.tagName || '').toLowerCase();
                    element.focus();

                    if (tagName === 'textarea') {
                        element.value = nextText;
                    } else {
                        if (typeof element.replaceChildren === 'function') {
                            element.replaceChildren();
                        } else if (Array.isArray(element.children)) {
                            element.children.length = 0;
                        }
                        element.innerText = '';
                        element.textContent = '';
                        if (element.classList && typeof element.classList.remove === 'function') {
                            element.classList.remove('ql-blank');
                        }
                        if (nextText) {
                            const paragraph = document.createElement('p');
                            paragraph.innerText = nextText;
                            paragraph.textContent = nextText;
                            element.appendChild(paragraph);
                        }
                    }

                    if (typeof InputEvent === 'function') {
                        element.dispatchEvent(new InputEvent('input', {
                            bubbles: true,
                            inputType: nextText ? 'insertText' : 'deleteContentBackward',
                            data: nextText || null
                        }));
                    }
                }

                function restoreComposerIfUnchanged(element, originalText, injectedText) {
                    const currentText = getComposerText(element);
                    if (normalizeComposerText(currentText) !== normalizeComposerText(injectedText)) {
                        return {
                            restored: false,
                            draftPreserved: true,
                            currentTextLength: currentText.length
                        };
                    }

                    try {
                        setComposerText(element, originalText);
                        return {
                            restored: true,
                            draftPreserved: false,
                            currentTextLength: originalText.length
                        };
                    } catch {
                        return {
                            restored: false,
                            draftPreserved: false,
                            restoreFailed: true,
                            currentTextLength: currentText.length
                        };
                    }
                }

                const inputMatch = findMatch('composer', isComposerCandidate);
                const input = inputMatch.element;

                if (!input) {
                    return compatibilityFailure('composer', 'required composer signal was not found.', {
                        activeElement: describeElement(document.activeElement)
                    });
                }

                const originalComposerText = getComposerText(input);
                if (normalizeComposerText(originalComposerText)) {
                    return compatibilityFailure('composer', 'canonical composer contains pending user content; queued send deferred to preserve the draft.', {
                        composerSelector: inputMatch.selector,
                        composerSignal: inputMatch.signalKey,
                        composer: describeElement(input),
                        composerConflict: true,
                        deferred: true,
                        pendingTextLength: originalComposerText.length
                    });
                }

                const queuedText = String(msg || '');
                let composerWriteStarted = false;

                try {
                    composerWriteStarted = true;
                    setComposerText(input, queuedText);
                    await sleepInPage(700);

                    const currentComposerText = getComposerText(input);
                    if (normalizeComposerText(currentComposerText) !== normalizeComposerText(queuedText)) {
                        return compatibilityFailure('composer', 'canonical composer changed while the queued message was pending; send deferred to preserve the draft.', {
                            composerSelector: inputMatch.selector,
                            composerSignal: inputMatch.signalKey,
                            composer: describeElement(input),
                            composerConflict: true,
                            deferred: true,
                            pendingTextLength: currentComposerText.length,
                            draftPreserved: true
                        });
                    }

                    const sendButtonMatch = findMatch('sendButton', isSendActionCandidate);
                    const sendButton = sendButtonMatch.element;

                    if (!sendButton) {
                        const restoration = restoreComposerIfUnchanged(input, originalComposerText, queuedText);
                        return compatibilityFailure('sendButton', 'required send action signal was not found.', {
                            composerSelector: inputMatch.selector,
                            composerSignal: inputMatch.signalKey,
                            composer: describeElement(input),
                            ...restoration
                        });
                    }

                    if (sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') {
                        const restoration = restoreComposerIfUnchanged(input, originalComposerText, queuedText);
                        return compatibilityFailure('sendButton', 'send action signal is disabled.', {
                            composerSelector: inputMatch.selector,
                            composerSignal: inputMatch.signalKey,
                            sendButtonSelector: sendButtonMatch.selector,
                            sendButtonSignal: sendButtonMatch.signalKey,
                            composer: describeElement(input),
                            sendButton: describeElement(sendButton),
                            ...restoration
                        });
                    }

                    sendButton.click();

                    return {
                        ok: true,
                        details: {
                            composerSelector: inputMatch.selector,
                            composerSignal: inputMatch.signalKey,
                            sendButtonSelector: sendButtonMatch.selector,
                            sendButtonSignal: sendButtonMatch.signalKey,
                            messageLength: queuedText.length,
                            url: location.href,
                            title: document.title,
                            provider: providerName || ''
                        }
                    };
                } catch (error) {
                    const restoration = composerWriteStarted
                        ? restoreComposerIfUnchanged(input, originalComposerText, queuedText)
                        : { restored: false, draftPreserved: false };
                    return compatibilityFailure('submission', 'queued message submission failed; the composer draft was preserved when it was safe to restore.', {
                        composerSelector: inputMatch.selector,
                        composerSignal: inputMatch.signalKey,
                        composer: describeElement(input),
                        error: error?.message || 'Unknown submission error',
                        ...restoration
                    });
                }
            },
            args: [text, compatibilityContract, providerName]
        });

        const result = results?.[0]?.result;

        if (!result || !result.ok) {
            return {
                ok: false,
                error: result?.error || 'Could not send prompt.',
                details: result?.details || {
                    compatibilityFailure: 'script-result',
                    scriptResultCount: Array.isArray(results) ? results.length : 0
                }
            };
        }

        const ack = await waitForSubmissionAck(tabId, {
            expectedText: text,
            beforeSnapshot: beforeInspect.snapshot,
            timeoutMs: QUEUE_WAIT_POLICY.submissionAckTimeoutMs,
            pollMs: QUEUE_WAIT_POLICY.submissionAckPollMs
        });

        if (!ack.ok) {
            return {
                ok: false,
                error: ack.error || 'Send was not acknowledged as a new user turn.',
                details: {
                    ...(result.details || {}),
                    ...(ack.details || {}),
                    failureClass: ack.details?.failureClass || 'submission-unconfirmed',
                    clickOnly: true
                }
            };
        }

        return {
            ok: true,
            details: {
                ...(result.details || {}),
                ...(ack.details || {})
            }
        };
    } catch (error) {
        return {
            ok: false,
            error: error?.message || 'Failed to inject prompt into provider tab.',
            details: {
                error: serializeError(error)
            }
        };
    }
}

async function waitForTabResponse(tabId, context = {}) {
    const queueSettings = {
        ...QUEUE_SETTINGS_DEFAULTS,
        ...context.queueSettings
    };
    const liveJob = jobs.get(tabId);
    const now = Date.now();
    if (liveJob && !Number(liveJob.waitStartedAt || 0)) {
        liveJob.waitStartedAt = now;
        liveJob.updatedAt = now;
        updateRunningJobsStorage();
    }

    const startedAt = Number(liveJob?.waitStartedAt) || now;
    const unlimited = queueSettings.queueUnlimitedRetryWait === true;
    const ordinaryMaxWaitMs = Number(context.maxWaitMs) > 0
        ? Number(context.maxWaitMs)
        : QUEUE_WAIT_POLICY.responseMaxWaitMs;
    const deepResearchMaxWaitMs = Number(context.deepResearchMaxWaitMs) > 0
        ? Number(context.deepResearchMaxWaitMs)
        : QUEUE_WAIT_POLICY.deepResearchMaxWaitMs;
    const deepResearchStaleMs = Number(context.deepResearchStaleMs) > 0
        ? Number(context.deepResearchStaleMs)
        : QUEUE_WAIT_POLICY.deepResearchStaleMs;
    const checkIntervalMs = Number(context.checkIntervalMs) > 0
        ? Number(context.checkIntervalMs)
        : QUEUE_WAIT_POLICY.checkIntervalMs;
    let sawGenerating = liveJob?.sawGenerating === true;
    let sawDeepResearch = liveJob?.sawDeepResearch === true;
    let lastResearchPreview = '';
    let lastProgressLogAt = startedAt;
    let terminalStreak = 0;
    let idleStreak = 0;
    const waitLabel = getWaitContextLabel(context);
    const commandBinding = getCommandBinding(liveJob, context);
    const hasCommandBinding = !context.waitForExistingGeneration && !!(commandBinding.userTurnId || commandBinding.commandFingerprint);
    const requiredConfirmSamples = Math.max(1, Number(context.terminalConfirmSamples || QUEUE_WAIT_POLICY.terminalConfirmSamples) || 2);

    const persistWaitSignals = () => {
        const current = jobs.get(tabId);
        if (!current) return;
        current.sawGenerating = sawGenerating;
        current.sawDeepResearch = sawDeepResearch;
        current.updatedAt = Date.now();
        updateRunningJobsStorage();
    };

    const resolveMaxWaitMs = () => {
        if (unlimited) return Number.POSITIVE_INFINITY;
        if (queueSettings.queueDeepResearchAware && sawDeepResearch) {
            return deepResearchMaxWaitMs;
        }
        return ordinaryMaxWaitMs;
    };

    const buildWaitDetails = (extra = {}) => {
        const current = jobs.get(tabId);
        return {
            elapsedMs: Date.now() - startedAt,
            sawGenerating,
            sawDeepResearch,
            settings: queueSettings,
            waitStartedAt: startedAt,
            lastResearchProgressAt: Number(current?.lastResearchProgressAt || 0),
            ...extra
        };
    };

    return new Promise((resolveRaw) => {
        let settled = false;
        let checkInterval = null;
        const resolve = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            if (checkInterval) {
                clearInterval(checkInterval);
            }
            persistWaitSignals();
            resolveRaw(value);
        };
        const pollGeneration = () => {
            if (settled) {
                clearInterval(checkInterval);
                return;
            }

            const job = jobs.get(tabId);

            if (!job || job.isStopped) {
                resolve({
                    ok: false,
                    error: 'Queue was stopped.',
                    details: buildWaitDetails({ failureClass: 'user-stop' })
                });
                return;
            }

            if (job.isPaused || !job.isRunning) {
                resolve({
                    ok: false,
                    error: 'Queue was paused.',
                    details: buildWaitDetails({ failureClass: 'non-retryable' })
                });
                return;
            }

            const maxWaitMs = resolveMaxWaitMs();
            if (Date.now() - startedAt > maxWaitMs) {
                const researchTimeout = queueSettings.queueDeepResearchAware && sawDeepResearch;
                resolve({
                    ok: false,
                    error: researchTimeout
                        ? 'Timed out waiting for Deep Research to finish.'
                        : (hasCommandBinding
                            ? 'No terminal response was confirmed for this command.'
                            : 'Timed out waiting for ChatGPT response.'),
                    details: buildWaitDetails({
                        failureClass: 'timeout',
                        timedOut: true,
                        pendingWithoutTerminal: true
                    })
                });
                return;
            }

            if (!unlimited && queueSettings.queueDeepResearchAware && sawDeepResearch) {
                const lastProgressAt = Number(job.lastResearchProgressAt || startedAt);
                if (Date.now() - lastProgressAt > deepResearchStaleMs) {
                    resolve({
                        ok: false,
                        error: 'Deep Research stalled without progress.',
                        details: buildWaitDetails({
                            failureClass: 'stalled-research',
                            stalledResearch: true
                        })
                    });
                    return;
                }
            }

            try {
                sendTabMessage(tabId, { type: 'CHECK_GENERATION_STATE', commandBinding }).then((response) => {
                    if (settled) {
                        return;
                    }

                    const state = response?.state || {};
                    const responseState = response?.responseState || null;
                    const phase = String(responseState?.phase || '');

                    const isDeliveryTimeout = !!state.hasDeliveryTimedOut ||
                        (typeof state.matchedError === 'string' && /delivery time(?:d\s*)?out/i.test(state.matchedError)) ||
                        (typeof state.errorSnippet === 'string' && /delivery time(?:d\s*)?out/i.test(state.errorSnippet));

                    if (isDeliveryTimeout) {
                        clearInterval(checkInterval);
                        resolve({
                            ok: false,
                            isDeliveryTimeout: true,
                            error: state.matchedError || 'Message delivery timed out. Please try again.',
                            details: buildWaitDetails({
                                failureClass: 'timeout',
                                state,
                                responseState
                            })
                        });
                        return;
                    }

                    if (state.hasError || state.hasTryAgainButton || phase === 'error') {
                        clearInterval(checkInterval);
                        resolve({
                            ok: false,
                            isDeliveryTimeout: false,
                            error: 'ChatGPT showed an error or retry state.',
                            details: buildWaitDetails({
                                failureClass: state.hasTryAgainButton || responseState?.source === 'retry-visible' ? 'retry-visible' : 'generation-error',
                                state,
                                responseState
                            })
                        });
                        return;
                    }

                    if (phase === 'waiting-for-user') {
                        clearInterval(checkInterval);
                        resolve({
                            ok: false,
                            error: 'ChatGPT is waiting for the user.',
                            details: buildWaitDetails({
                                failureClass: 'waiting-for-user',
                                state,
                                responseState
                            })
                        });
                        return;
                    }

                    if (phase === 'interrupted') {
                        clearInterval(checkInterval);
                        resolve({
                            ok: false,
                            error: 'The ChatGPT response was interrupted.',
                            details: buildWaitDetails({
                                failureClass: 'interrupted',
                                state,
                                responseState
                            })
                        });
                        return;
                    }

                const deepResearchActive = queueSettings.queueDeepResearchAware && !!state.deepResearchActive;
                const researchPreview = String(state.researchStatusPreview || '');

                if (deepResearchActive && !sawDeepResearch) {
                    logQueueEvent(tabId, 'info', `Deep research activity detected for ${waitLabel}.`, {
                        commandNumber: context.commandNumber || 0,
                        totalMessages: context.totalMessages || 0,
                        elapsedMs: Date.now() - startedAt,
                        matchedResearchMarker: state.matchedResearchMarker || '',
                        researchPreviewLength: researchPreview.length
                    });
                    lastResearchPreview = researchPreview;
                    job.lastResearchProgressAt = Date.now();
                }

                if (state.generating || deepResearchActive || phase === 'active') {
                    if (!sawGenerating && (state.generating || phase === 'active')) {
                        logQueueEvent(tabId, 'info', `ChatGPT is responding for ${waitLabel}.`, {
                            commandNumber: context.commandNumber || 0,
                            totalMessages: context.totalMessages || 0,
                            elapsedMs: Date.now() - startedAt,
                            commandId: commandBinding.commandId || job.commandId || '',
                            userTurnId: responseState?.userTurnId || commandBinding.userTurnId || null,
                            responsePhase: phase || 'active'
                        });
                    }

                    sawGenerating = sawGenerating || !!state.generating || phase === 'active';
                    sawDeepResearch = sawDeepResearch || deepResearchActive;
                    job.sawGenerating = sawGenerating;
                    job.sawDeepResearch = sawDeepResearch;
                    job.deliveryState = hasCommandBinding ? 'active-response' : job.deliveryState;
                    job.lastResponsePhase = phase || 'active';
                    if (responseState?.assistantTurnId) {
                        job.assistantTurnId = responseState.assistantTurnId;
                    }
                    terminalStreak = 0;
                    idleStreak = 0;

                    if (state.generating || researchPreview !== lastResearchPreview || phase === 'active') {
                        job.lastResearchProgressAt = Date.now();
                        lastResearchPreview = researchPreview;
                    }

                    persistWaitSignals();

                    if (Date.now() - lastProgressLogAt > 30000) {
                        logQueueEvent(tabId, 'info', `Still waiting for ${waitLabel}.`, {
                            commandNumber: context.commandNumber || 0,
                            totalMessages: context.totalMessages || 0,
                            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
                            generating: !!state.generating,
                            deepResearchActive,
                            sawGenerating,
                            sawDeepResearch,
                            responsePhase: phase || 'active',
                            settings: queueSettings
                        });
                        lastProgressLogAt = Date.now();
                    }

                    return;
                }

                if (phase && phase !== job.lastResponsePhase) {
                    logQueueEvent(tabId, 'info', `Command response phase changed to ${phase}.`, {
                        commandNumber: context.commandNumber || 0,
                        commandId: commandBinding.commandId || job.commandId || '',
                        userTurnId: responseState?.userTurnId || commandBinding.userTurnId || null,
                        assistantTurnId: responseState?.assistantTurnId || null,
                        responsePhase: phase,
                        source: responseState?.source || ''
                    });
                    job.lastResponsePhase = phase;
                }

                const pageIsIdle = !state.generating && !deepResearchActive && phase !== 'active';

                if (context.waitForExistingGeneration) {
                    if (!pageIsIdle) {
                        idleStreak = 0;
                        persistWaitSignals();
                        return;
                    }
                    terminalStreak = 0;
                    idleStreak += 1;
                    persistWaitSignals();
                    const needed = (sawGenerating || sawDeepResearch) ? requiredConfirmSamples : 1;
                    if (idleStreak >= needed) {
                        resolve({
                            ok: true,
                            details: {
                                waitedForExistingGeneration: true,
                                elapsedMs: Date.now() - startedAt,
                                sawGenerating,
                                sawDeepResearch,
                                settings: queueSettings,
                                state,
                                responseState
                            }
                        });
                    }
                    return;
                }

                if (phase === 'transient-idle' || (hasCommandBinding && !phase && pageIsIdle && !sawGenerating && !sawDeepResearch)) {
                    terminalStreak = 0;
                    idleStreak = 0;
                    job.lastResponsePhase = phase || 'transient-idle';
                    persistWaitSignals();
                    return;
                }

                const boundTerminal = hasCommandBinding && phase === 'terminal' && (
                    !commandBinding.userTurnId ||
                    !responseState?.userTurnId ||
                    responseState.userTurnId === commandBinding.userTurnId
                );

                if (boundTerminal) {
                    idleStreak = 0;
                    terminalStreak += 1;
                    job.lastResponsePhase = 'terminal';
                    job.assistantTurnId = responseState?.assistantTurnId || job.assistantTurnId || null;
                    job.terminalAckSource = responseState?.source || 'bound-assistant-turn';
                    persistWaitSignals();
                    if (terminalStreak >= requiredConfirmSamples) {
                        job.currentPhase = 'terminal';
                        job.deliveryState = 'terminal-awaiting-bookkeeping';
                        resolve({
                            ok: true,
                            details: buildWaitDetails({
                                terminalAckSource: job.terminalAckSource,
                                userTurnId: responseState?.userTurnId || commandBinding.userTurnId || null,
                                assistantTurnId: job.assistantTurnId,
                                responsePhase: 'terminal',
                                state,
                                responseState
                            })
                        });
                    }
                    return;
                }

                if (!hasCommandBinding && (sawGenerating || sawDeepResearch) && pageIsIdle) {
                    terminalStreak = 0;
                    idleStreak += 1;
                    persistWaitSignals();
                    if (idleStreak >= requiredConfirmSamples) {
                        resolve({
                            ok: true,
                            details: buildWaitDetails({
                                terminalAckSource: 'idle-after-generation',
                                state,
                                responseState
                            })
                        });
                    }
                    return;
                }

                idleStreak = 0;
                terminalStreak = 0;

                if (queueSettings.queueUnlimitedRetryWait && Date.now() - lastProgressLogAt > 30000) {
                    logQueueEvent(tabId, 'info', `Unlimited wait mode is still waiting for ${waitLabel}.`, {
                        commandNumber: context.commandNumber || 0,
                        totalMessages: context.totalMessages || 0,
                        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
                        generating: !!state.generating,
                        deepResearchActive,
                        sawGenerating,
                        sawDeepResearch,
                        responsePhase: phase || 'pending',
                        settings: queueSettings
                    });
                    lastProgressLogAt = Date.now();
                }
                }).catch((executionError) => {
                    if (settled) {
                        return;
                    }
                    clearInterval(checkInterval);
                    resolve({
                        ok: false,
                        error: executionError.message || 'Could not read ChatGPT tab.',
                        details: buildWaitDetails({
                            failureClass: 'transient',
                            error: serializeError(executionError)
                        })
                    });
                });
            } catch (error) {
                clearInterval(checkInterval);
                resolve({
                    ok: false,
                    error: error?.message || 'Could not inspect ChatGPT response state.',
                    details: buildWaitDetails({
                        failureClass: 'transient',
                        error: serializeError(error)
                    })
                });
            }
        };
        checkInterval = setInterval(pollGeneration, checkIntervalMs);
        if (!context.waitForExistingGeneration) {
            pollGeneration();
        }
    });
}

function getWaitContextLabel(context = {}) {
    if (context.waitForExistingGeneration) {
        return context.waitLabel || 'the current ChatGPT response';
    }

    return `command ${context.commandNumber || '?'}/${context.totalMessages || '?'}`;
}

/**
 * @returns {Record<string, RunningJobSnapshot>}
 */
function getRunningJobsSnapshot() {
    /** @type {Record<string, RunningJobSnapshot>} */
    const snapshot = {};

    for (const [tabId, job] of jobs.entries()) {
        const provider = job.provider || 'chatgpt';
        const conversationId = job.conversationId || null;
        const conversationType = job.conversationType || (conversationId ? 'existing' : 'unknown');
        const targetKey = job.targetKey || (conversationId ? `${provider}:c:${conversationId}` : `${provider}:${conversationType}`);

        snapshot[tabId] = {
            tabId: job.tabId,
            provider,
            conversationId,
            conversationType,
            targetKey,
            remaining: getRemainingCount(job),
            pending: Array.isArray(job.queue) ? job.queue.length : 0,
            isRunning: job.isRunning,
            isPaused: job.isPaused,
            isStopped: job.isStopped,
            status: getJobStatus(job),
            pausedReason: job.pausedReason || '',
            lastError: job.lastError || '',
            hasCurrentMessage: !!job.currentMessage,
            currentMessageLength: String(job.currentMessage || '').length,
            nextMessageLength: String((Array.isArray(job.queue) ? job.queue[0] : '') || '').length,
            runId: job.runId || '',
            totalMessages: getTotalMessages(job),
            completedCount: job.completedCount || 0,
            currentCommandNumber: job.currentCommandNumber || 0,
            currentPhase: job.currentPhase || '',
            waitForIdleBeforeSend: job.waitForIdleBeforeSend === true,
            deliveryTimeoutAttempts: Number(job.deliveryTimeoutAttempts || 0),
            retryAttemptCount: Number(job.retryAttemptCount || 0),
            lastRetryableReason: job.lastRetryableReason || '',
            retryClass: job.retryClass || '',
            retryMode: job.retryMode || '',
            nextRetryDelayMs: Number(job.nextRetryDelayMs || 0),
            nextRetryAt: Number(job.nextRetryAt || 0),
            retryExhausted: job.retryExhausted === true,
            waitStartedAt: Number(job.waitStartedAt || 0),
            lastResearchProgressAt: Number(job.lastResearchProgressAt || 0),
            sawDeepResearch: job.sawDeepResearch === true,
            sawGenerating: job.sawGenerating === true,
            deliveryState: job.deliveryState || '',
            commandId: job.commandId || '',
            commandFingerprint: job.commandFingerprint || '',
            submittedUserTurnId: job.submittedUserTurnId || null,
            assistantTurnId: job.assistantTurnId || null,
            submissionAckSource: job.submissionAckSource || '',
            terminalAckSource: job.terminalAckSource || '',
            lastResponsePhase: job.lastResponsePhase || '',
            startedAt: job.startedAt,
            updatedAt: job.updatedAt
        };
    }

    return snapshot;
}

function getRemainingCount(job) {
    const queued = Array.isArray(job?.queue) ? job.queue.length : 0;
    return queued + (job?.currentMessage ? 1 : 0);
}

function getTotalMessages(job) {
    if (!job) return 0;

    return Math.max(
        Number(job.totalMessages || 0),
        Number(job.completedCount || 0) + getRemainingCount(job)
    );
}

function getJobStatus(job) {
    if (job.isPaused) return 'paused';
    if (job.isRunning) return 'running';
    if (job.isStopped) return 'stopped';
    return 'idle';
}

function updateRunningJobsStorage(options = {}) {
    const snapshot = getRunningJobsSnapshot();
    const durableJobs = getDurableJobsState();
    const hasJobs = Object.keys(snapshot).length > 0;
    const items = {
        runningJobs: snapshot,
        queueDurableJobs: durableJobs,
        isRunning: hasJobs
    };
    const serialized = JSON.stringify(items);

    updateQueueWakeAlarm(hasJobs);

    if (pendingQueueState?.serialized === serialized) {
        return queueStateWrite;
    }

    if (serialized === queueStateInFlightSerialized) {
        pendingQueueState = null;
        if (queueStateFlushTimer !== null) {
            clearTimeout(queueStateFlushTimer);
            queueStateFlushTimer = null;
        }
        return queueStateWrite;
    }

    if (serialized === lastPersistedQueueState && queueStateInFlightSerialized === null) {
        pendingQueueState = null;
        if (queueStateFlushTimer !== null) {
            clearTimeout(queueStateFlushTimer);
            queueStateFlushTimer = null;
        }
        return queueStateWrite;
    }

    pendingQueueState = { items, serialized };

    if (options.force === true) {
        return flushQueueState();
    }

    if (queueStateFlushTimer === null) {
        queueStateFlushTimer = setTimeout(() => {
            queueStateFlushTimer = null;
            flushQueueState();
        }, QUEUE_STATE_COALESCE_DELAY_MS);
    }

    return queueStateWrite;
}

function flushQueueState() {
    if (queueStateFlushTimer !== null) {
        clearTimeout(queueStateFlushTimer);
        queueStateFlushTimer = null;
    }

    if (!pendingQueueState) {
        return queueStateWrite;
    }

    const nextState = pendingQueueState;
    pendingQueueState = null;
    queueStateInFlightSerialized = nextState.serialized;
    queueStateWrite = queueStateWrite
        .catch(() => {})
        .then(async () => {
            if (nextState.serialized === lastPersistedQueueState) {
                return;
            }

            await writeLocalStorage(nextState.items);
            lastPersistedQueueState = nextState.serialized;
        })
        .catch((error) => {
            console.warn('Could not persist queue state:', error);
        })
        .finally(() => {
            if (queueStateInFlightSerialized === nextState.serialized) {
                queueStateInFlightSerialized = null;
            }
        });

    return queueStateWrite;
}

function getDurableJobsState() {
    /** @type {DurableQueueSnapshot} */
    const state = {};

    for (const [tabId, job] of jobs.entries()) {
        const provider = job.provider || 'chatgpt';
        const conversationId = job.conversationId || null;
        const conversationType = job.conversationType || (conversationId ? 'existing' : 'unknown');
        const targetKey = job.targetKey || (conversationId ? `${provider}:c:${conversationId}` : `${provider}:${conversationType}`);

        state[tabId] = {
            tabId: job.tabId,
            provider,
            conversationId,
            conversationType,
            targetKey,
            queue: Array.isArray(job.queue) ? [...job.queue] : [],
            currentMessage: job.currentMessage || '',
            isRunning: !!job.isRunning,
            isPaused: !!job.isPaused,
            isStopped: !!job.isStopped,
            pausedReason: job.pausedReason || '',
            lastError: job.lastError || '',
            runId: job.runId || '',
            totalMessages: getTotalMessages(job),
            completedCount: Number(job.completedCount || 0),
            currentCommandNumber: Number(job.currentCommandNumber || 0),
            currentPhase: job.currentPhase || 'queued',
            waitForIdleBeforeSend: job.waitForIdleBeforeSend === true,
            deliveryTimeoutAttempts: Number(job.deliveryTimeoutAttempts || 0),
            retryAttemptCount: Number(job.retryAttemptCount || 0),
            lastRetryableReason: job.lastRetryableReason || '',
            retryClass: job.retryClass || '',
            retryMode: job.retryMode || '',
            nextRetryDelayMs: Number(job.nextRetryDelayMs || 0),
            nextRetryAt: Number(job.nextRetryAt || 0),
            retryExhausted: job.retryExhausted === true,
            waitStartedAt: Number(job.waitStartedAt || 0),
            lastResearchProgressAt: Number(job.lastResearchProgressAt || 0),
            sawDeepResearch: job.sawDeepResearch === true,
            sawGenerating: job.sawGenerating === true,
            deliveryState: job.deliveryState || '',
            commandId: job.commandId || '',
            commandFingerprint: job.commandFingerprint || '',
            submittedUserTurnId: job.submittedUserTurnId || null,
            assistantTurnId: job.assistantTurnId || null,
            submissionAckSource: job.submissionAckSource || '',
            terminalAckSource: job.terminalAckSource || '',
            lastResponsePhase: job.lastResponsePhase || '',
            startedAt: job.startedAt,
            updatedAt: job.updatedAt
        };
    }

    return state;
}

function updateQueueWakeAlarm(hasJobs = jobs.size > 0) {
    if (!chrome.alarms) return;

    if (hasJobs) {
        chrome.alarms.create(QUEUE_WAKE_ALARM_NAME, {
            periodInMinutes: QUEUE_WAKE_ALARM_PERIOD_MINUTES
        });
        return;
    }

    chrome.alarms.clear(QUEUE_WAKE_ALARM_NAME);
}

function recordCompletedRun(tabId) {
    chrome.storage.local.get(['successCount'], function (data) {
        const newCount = Number(data.successCount || 0) + 1;

        chrome.storage.local.set(
            {
                successCount: newCount
            },
            () => {
                notifyRuntime({
                    action: 'automationFinished',
                    tabId,
                    successCount: newCount
                });
            }
        );
    });
}

function notifyRuntime(message) {
    try {
        chrome.runtime.sendMessage(message, () => {
            void chrome.runtime.lastError;
        });
    } catch {
        // Popup may be closed. Ignore.
    }
}

function logQueueEvent(tabId, level, message, details = {}) {
    const entry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        timestamp: new Date().toISOString(),
        tabId: tabId || '',
        level: level || 'info',
        message: message || 'Queue event',
        details: sanitizeLogValue(details)
    };

    const consoleMessage = `[ChatGPT Queue] ${entry.message}`;

    if (entry.level === 'error') {
        console.error(consoleMessage, entry.details);
    } else if (entry.level === 'warn') {
        console.warn(consoleMessage, entry.details);
    } else {
        console.log(consoleMessage, entry.details);
    }

    pendingQueueLogEntries.push(entry);

    if (queueLogFlushTimer === null) {
        queueLogFlushTimer = setTimeout(() => {
            queueLogFlushTimer = null;
            flushQueueDebugLogs();
        }, QUEUE_LOG_COALESCE_DELAY_MS);
    }

    return entry;
}

function flushQueueDebugLogs() {
    if (queueLogFlushTimer !== null) {
        clearTimeout(queueLogFlushTimer);
        queueLogFlushTimer = null;
    }

    if (pendingQueueLogEntries.length === 0) {
        return queueLogWrite;
    }

    const entries = pendingQueueLogEntries;
    pendingQueueLogEntries = [];
    const generation = queueLogGeneration;

    queueLogWrite = queueLogWrite
        .catch(() => {})
        .then(async () => {
            if (generation !== queueLogGeneration) {
                return;
            }

            const data = await readLocalStorage([QUEUE_DEBUG_LOG_KEY]);
            if (generation !== queueLogGeneration) {
                return;
            }

            const logs = Array.isArray(data[QUEUE_DEBUG_LOG_KEY]) ? data[QUEUE_DEBUG_LOG_KEY] : [];
            const nextLogs = [...logs, ...entries]
                .map((entry) => ({
                    ...entry,
                    details: sanitizeLogValue(entry?.details)
                }))
                .slice(-MAX_QUEUE_DEBUG_LOG_ENTRIES);

            await writeLocalStorage({ [QUEUE_DEBUG_LOG_KEY]: nextLogs });

            for (const entry of entries) {
                notifyRuntime({
                    action: 'queueDebugLogUpdated',
                    entry
                });
            }
        })
        .catch((error) => {
            console.warn('Could not write queue debug log:', error);
        });

    return queueLogWrite;
}

function readLocalStorage(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (data) => {
            const lastError = chrome.runtime.lastError;

            if (lastError) {
                reject(new Error(lastError.message || 'Storage read failed.'));
                return;
            }

            resolve(data || {});
        });
    });
}

function writeLocalStorage(items) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
            const lastError = chrome.runtime.lastError;

            if (lastError) {
                reject(new Error(lastError.message || 'Storage write failed.'));
                return;
            }

            resolve();
        });
    });
}

async function getQueueSettings() {
    try {
        const data = await readSyncStorage(QUEUE_SETTINGS_DEFAULTS);

        /** @type {QueueSettings} */
        const settings = {
            queueUnlimitedRetryWait: data.queueUnlimitedRetryWait === true,
            queueDeepResearchAware: data.queueDeepResearchAware !== false,
            queueDeliveryTimeoutRefresh: data.queueDeliveryTimeoutRefresh !== false
        };
        return settings;
    } catch (error) {
        console.warn('Could not read queue settings, using defaults:', error);
        return { ...QUEUE_SETTINGS_DEFAULTS };
    }
}

function readSyncStorage(defaults) {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get(defaults, (data) => {
            const lastError = chrome.runtime.lastError;

            if (lastError) {
                reject(new Error(lastError.message || 'Sync storage read failed.'));
                return;
            }

            resolve(data || {});
        });
    });
}

function getTab(tabId) {
    return extensionApiPromise(
        (done) => chrome.tabs.get(tabId, done),
        () => chrome.tabs.get(tabId)
    );
}

function queryTabs(queryInfo) {
    return extensionApiPromise(
        (done) => chrome.tabs.query(queryInfo, done),
        () => chrome.tabs.query(queryInfo)
    ).then((tabs) => Array.isArray(tabs) ? tabs : []);
}

async function getActiveTab() {
    const queries = [
        { active: true, currentWindow: true },
        { active: true, lastFocusedWindow: true },
        { active: true }
    ];

    for (const queryInfo of queries) {
        try {
            const tabs = await queryTabs(queryInfo);

            if (tabs[0]) {
                return tabs[0];
            }
        } catch {
            // Try the next active-tab query shape.
        }
    }

    return null;
}

function sendTabMessage(tabId, message) {
    return extensionApiPromise(
        (done) => chrome.tabs.sendMessage(tabId, message, done),
        () => chrome.tabs.sendMessage(tabId, message)
    );
}

function createTab(createProperties) {
    return extensionApiPromise(
        (done) => chrome.tabs.create(createProperties, done),
        () => chrome.tabs.create(createProperties)
    );
}

async function openExtensionPopupPage() {
    await createTab({
        url: chrome.runtime.getURL('popup.html'),
        active: true
    });
}

function executeScript(details, callback) {
    const promise = extensionApiPromise(
        (done) => {
            if (chrome.scripting && chrome.scripting.executeScript) {
                return chrome.scripting.executeScript(details, done);
            }

            if (chrome.tabs && chrome.tabs.executeScript) {
                const tabId = details?.target?.tabId;
                const legacyDetails = {};

                if (Array.isArray(details.files) && details.files[0]) {
                    legacyDetails.file = details.files[0];
                } else if (details.func) {
                    legacyDetails.code = `(${details.func}).apply(null, ${JSON.stringify(details.args || [])});`;
                } else {
                    throw new Error('No script file or function was provided.');
                }

                return chrome.tabs.executeScript(tabId, legacyDetails, done);
            }

            throw new Error('Script injection is not available in this browser.');
        },
        () => {
            if (!chrome.scripting || !chrome.scripting.executeScript) {
                throw new Error('Script injection is not available in this browser.');
            }

            return chrome.scripting.executeScript(details);
        }
    );

    if (typeof callback === 'function') {
        promise.then(
            (results) => callback(results, null),
            (error) => callback(null, error)
        );
        return undefined;
    }

    return promise;
}

function isSensitiveLogKey(key) {
    const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized) {
        return false;
    }
    if (
        normalized === 'currentmessage' ||
        normalized === 'text' ||
        normalized === 'prompt' ||
        normalized === 'composertext' ||
        normalized === 'lastqueuedtext' ||
        normalized === 'errorsnippet' ||
        normalized === 'researchstatuspreview' ||
        normalized === 'recoveredturnpreview' ||
        normalized === 'assistantpreview'
    ) {
        return true;
    }
    return normalized.includes('preview') || normalized.includes('snippet');
}

function redactSensitiveLogValue(value) {
    if (typeof value === 'string') {
        return {
            redacted: true,
            length: value.length
        };
    }
    if (Array.isArray(value)) {
        return {
            redacted: true,
            length: value.length
        };
    }
    return {
        redacted: true
    };
}

function describeLoggedMessage(text) {
    return {
        redacted: true,
        messageLength: String(text || '').length
    };
}

function sanitizeLogValue(value, depth = 0, key = '') {
    if (value === null || value === undefined) {
        return value;
    }

    if (key && isSensitiveLogKey(key)) {
        if (value && typeof value === 'object' && value.redacted === true) {
            return value;
        }
        return redactSensitiveLogValue(value);
    }

    if (value instanceof Error) {
        return serializeError(value);
    }

    if (typeof value === 'string') {
        return value.length > 700 ? `${value.slice(0, 697)}...` : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (Array.isArray(value)) {
        if (depth >= 2) {
            return `[${value.length} items]`;
        }

        return value.slice(0, 12).map(item => sanitizeLogValue(item, depth + 1));
    }

    if (typeof value === 'object') {
        if (depth >= 3) {
            return '[object]';
        }

        const clean = {};
        const entries = Object.entries(value).slice(0, 30);

        for (const [entryKey, item] of entries) {
            if (typeof item === 'function' || item === undefined) continue;
            clean[entryKey] = sanitizeLogValue(item, depth + 1, entryKey);
        }

        return clean;
    }

    return String(value);
}

function serializeError(error) {
    if (!error) {
        return {};
    }

    return {
        name: error.name || 'Error',
        message: error.message || String(error),
        stack: error.stack ? previewText(error.stack, 700) : ''
    };
}

function createRunId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function previewText(text, maxLength = 70) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();

    if (clean.length <= maxLength) {
        return clean;
    }

    return clean.slice(0, maxLength - 1) + '…';
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function scheduledAlarmName(id) {
    return `${SCHEDULED_ALARM_PREFIX}${String(id || '')}`;
}

function sortScheduledMessages(items) {
    return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
        const dueDiff = Number(a?.dueTs || 0) - Number(b?.dueTs || 0);
        if (dueDiff !== 0) return dueDiff;
        return Number(a?.createdAt || 0) - Number(b?.createdAt || 0);
    });
}

async function readScheduledMessages() {
    const data = await readLocalStorage([SCHEDULED_MESSAGES_KEY]);
    const items = data[SCHEDULED_MESSAGES_KEY];
    return sortScheduledMessages(Array.isArray(items) ? items : []);
}

async function writeScheduledMessages(items) {
    await writeLocalStorage({
        [SCHEDULED_MESSAGES_KEY]: sortScheduledMessages(items)
    });
}

function clearScheduledAlarm(id) {
    if (!chrome.alarms || typeof chrome.alarms.clear !== 'function') return;
    chrome.alarms.clear(scheduledAlarmName(id));
}

/**
 * @template T
 * @param {() => T|Promise<T>} operation
 * @returns {Promise<T>}
 */
function withScheduledStorageLock(operation) {
    const next = scheduledStorageWrite
        .catch(() => {})
        .then(operation);

    scheduledStorageWrite = next.catch(() => {});
    return next;
}

function createScheduledAlarm(item) {
    if (!chrome.alarms || typeof chrome.alarms.create !== 'function' || !item?.id) return;
    const when = Math.max(Number(item.dueTs) || Date.now(), Date.now());
    chrome.alarms.create(scheduledAlarmName(item.id), { when });
}

async function persistScheduledItem(nextItem) {
    return withScheduledStorageLock(async () => {
        const items = await readScheduledMessages();
        const index = items.findIndex((item) => item.id === nextItem.id);
        if (index >= 0) {
            items[index] = nextItem;
        } else {
            items.push(nextItem);
        }
        await writeScheduledMessages(items);
        notifyRuntime({
            action: 'scheduledMessagesUpdated',
            item: nextItem
        });
        return nextItem;
    });
}

function buildScheduledConversationIdentity(item) {
    return {
        provider: item.provider || 'chatgpt',
        type: item.conversationType || 'unknown',
        conversationId: item.conversationId || null,
        key: item.targetKey || `${item.provider || 'chatgpt'}:${item.conversationType || 'unknown'}`
    };
}

function identitiesMatchForSchedule(stored, current) {
    if (!stored || !current) return false;

    const storedType = stored.conversationType || stored.type || 'unknown';
    const currentType = current.conversationType || current.type || 'unknown';
    const storedKey = stored.targetKey || stored.key || '';
    const currentKey = current.targetKey || current.key || '';

    if (stored.provider && current.provider && current.provider !== 'unknown' && stored.provider !== current.provider) {
        return false;
    }

    if (currentType === 'unsupported' || storedType === 'unsupported') {
        return false;
    }

    if (storedType === 'existing' && stored.conversationId) {
        return currentType === 'existing' && current.conversationId === stored.conversationId;
    }

    if (storedType === 'new') {
        return currentType === 'new' || currentType === 'existing';
    }

    if (storedType === 'unknown' || currentType === 'unknown') {
        return false;
    }

    if (storedKey && currentKey) {
        return storedKey === currentKey;
    }

    return false;
}

async function createScheduledMessage({ text, dueTs, tabId, conversationIdentity = null }) {
    const message = String(text || '').trim();
    const normalizedTabId = Number(tabId || 0);
    const normalizedDueTs = Number(dueTs);

    if (!message) {
        return { ok: false, error: 'Message text is required.' };
    }

    if (!normalizedTabId) {
        return { ok: false, error: 'A supported target tab is required.' };
    }

    if (!Number.isFinite(normalizedDueTs) || normalizedDueTs <= 0) {
        return { ok: false, error: 'A valid due date/time is required.' };
    }

    let tab;
    try {
        tab = await getTab(normalizedTabId);
    } catch {
        return { ok: false, error: 'Selected target tab no longer exists.' };
    }

    const tabUrl = tab?.url || tab?.pendingUrl || '';
    if (!tab || !isSupportedProviderUrl(tabUrl)) {
        return { ok: false, error: 'Select a ChatGPT, Gemini, or Claude tab before scheduling.' };
    }

    const currentIdentity = await resolveTabConversationIdentity(normalizedTabId);
    const currentConversationType = currentIdentity?.type || currentIdentity?.conversationType;
    if (!currentIdentity || !['existing', 'new'].includes(currentConversationType)) {
        return {
            ok: false,
            error: 'Could not confirm the selected conversation. Reload the target tab and try again; no other chat was selected.'
        };
    }

    if (
        conversationIdentity &&
        !identitiesMatchForSchedule(conversationIdentity, currentIdentity)
    ) {
        return {
            ok: false,
            error: 'The selected conversation changed before scheduling. Choose the target again; no other chat was selected.'
        };
    }

    const identity = conversationIdentity || currentIdentity;
    const provider = identity?.provider || 'chatgpt';
    const conversationType = identity?.type || identity?.conversationType || 'unknown';
    const conversationId = identity?.conversationId || null;
    const targetKey = identity?.key || (conversationId ? `${provider}:c:${conversationId}` : `${provider}:${conversationType}`);
    const now = Date.now();

    const item = {
        id: createRunId(),
        text: message,
        dueTs: normalizedDueTs,
        tabId: normalizedTabId,
        provider,
        conversationId,
        conversationType,
        targetKey,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        failureReason: ''
    };

    await persistScheduledItem(item);
    createScheduledAlarm(item);

    logQueueEvent(normalizedTabId, 'info', 'Scheduled message created.', {
        scheduledId: item.id,
        dueTs: item.dueTs,
        targetKey: item.targetKey,
        messagePreview: previewText(item.text, 160)
    });

    return { ok: true, item };
}

async function cancelScheduledMessage(id) {
    const scheduledId = String(id || '');
    return withScheduledStorageLock(async () => {
        const items = await readScheduledMessages();
        const item = items.find((entry) => entry.id === scheduledId);

        if (!item) {
            return { ok: false, error: 'Scheduled message not found.' };
        }

        if (item.status === 'completed') {
            return { ok: false, error: 'Completed scheduled messages cannot be cancelled.' };
        }

        if (item.status === 'firing') {
            return { ok: false, error: 'Scheduled message delivery is already in progress.' };
        }

        item.status = 'cancelled';
        item.updatedAt = Date.now();
        item.failureReason = '';
        clearScheduledAlarm(item.id);
        await writeScheduledMessages(items);
        notifyRuntime({ action: 'scheduledMessagesUpdated', item });

        return { ok: true, item };
    });
}

async function deleteScheduledMessage(id) {
    const scheduledId = String(id || '');
    return withScheduledStorageLock(async () => {
        const items = await readScheduledMessages();
        const item = items.find((entry) => entry.id === scheduledId);

        if (!item) {
            return { ok: false, error: 'Scheduled message not found.' };
        }

        if (item.status === 'firing') {
            return { ok: false, error: 'Scheduled message delivery is already in progress.' };
        }

        const nextItems = items.filter((entry) => entry.id !== scheduledId);
        clearScheduledAlarm(scheduledId);
        await writeScheduledMessages(nextItems);
        notifyRuntime({ action: 'scheduledMessagesUpdated', deletedId: scheduledId });

        return { ok: true, deletedId: scheduledId };
    });
}

async function retryScheduledMessage(id, dueTs = null) {
    const scheduledId = String(id || '');
    const result = await withScheduledStorageLock(async () => {
        const items = await readScheduledMessages();
        const item = items.find((entry) => entry.id === scheduledId);

        if (!item) {
            return { ok: false, error: 'Scheduled message not found.' };
        }

        if (item.status === 'completed') {
            return { ok: false, error: 'Completed scheduled messages cannot be retried.' };
        }

        if (item.status === 'firing') {
            return { ok: false, error: 'Scheduled message delivery is already in progress.' };
        }

        const nextDueTs = dueTs == null ? Date.now() : Number(dueTs);
        if (!Number.isFinite(nextDueTs) || nextDueTs <= 0) {
            return { ok: false, error: 'A valid due date/time is required to retry.' };
        }

        item.status = 'pending';
        item.dueTs = nextDueTs;
        item.failureReason = '';
        item.updatedAt = Date.now();
        await writeScheduledMessages(items);
        createScheduledAlarm(item);
        notifyRuntime({ action: 'scheduledMessagesUpdated', item });
        return { ok: true, item };
    });

    if (result.ok && result.item.dueTs <= Date.now() + SCHEDULED_DUE_SKEW_MS) {
        await processDueScheduledMessages('retry', result.item.id);
    }

    return result;
}

async function markScheduledFailed(item, reason) {
    item.status = 'failed';
    item.failureReason = String(reason || 'Scheduled delivery failed.');
    item.updatedAt = Date.now();
    clearScheduledAlarm(item.id);
    await persistScheduledItem(item);
    logQueueEvent(item.tabId, 'error', item.failureReason, {
        scheduledId: item.id,
        targetKey: item.targetKey,
        status: item.status
    });
    return item;
}

async function markScheduledCompleted(item, enqueueResult = {}) {
    item.status = 'completed';
    item.failureReason = '';
    item.updatedAt = Date.now();
    item.completedAt = item.updatedAt;
    item.enqueueResult = {
        queued: enqueueResult.queued === true,
        started: enqueueResult.started === true,
        paused: enqueueResult.paused === true,
        waitingForIdle: enqueueResult.waitingForIdle === true,
        remaining: enqueueResult.remaining
    };
    clearScheduledAlarm(item.id);
    await persistScheduledItem(item);
    logQueueEvent(item.tabId, 'info', 'Scheduled message handed to queue.', {
        scheduledId: item.id,
        targetKey: item.targetKey,
        enqueueResult: item.enqueueResult
    });
    return item;
}

async function claimScheduledMessageForFire(id, now = Date.now()) {
    return withScheduledStorageLock(async () => {
        const items = await readScheduledMessages();
        const item = items.find((entry) => entry.id === id);

        if (!item) {
            return null;
        }

        if (item.status !== 'pending') {
            return null;
        }

        if (Number(item.dueTs) > now + SCHEDULED_DUE_SKEW_MS) {
            return null;
        }

        item.status = 'firing';
        item.updatedAt = now;
        item.fireAttemptedAt = now;
        await writeScheduledMessages(items);
        return { ...item };
    });
}

async function validateScheduledTarget(item) {
    const tabId = Number(item.tabId || 0);
    if (!tabId) {
        return { ok: false, reason: 'Scheduled item is missing a target tab.' };
    }

    if (!['existing', 'new'].includes(item.conversationType) || !item.provider) {
        return {
            ok: false,
            reason: 'Scheduled message has no confirmed conversation identity. It was not sent to another chat.'
        };
    }

    let tab;
    try {
        tab = await getTab(tabId);
    } catch {
        return { ok: false, reason: 'Target tab no longer exists. Scheduled message was not sent to another chat.' };
    }

    const tabUrl = tab?.url || tab?.pendingUrl || '';
    if (!tab || !isSupportedProviderUrl(tabUrl)) {
        return {
            ok: false,
            reason: 'Target tab is no longer a supported provider page. Scheduled message was not sent to another chat.'
        };
    }

    const currentIdentity = await resolveTabConversationIdentity(tabId);
    if (!identitiesMatchForSchedule(buildScheduledConversationIdentity(item), currentIdentity)) {
        return {
            ok: false,
            reason: `Conversation mismatch: expected "${item.targetKey}", found "${currentIdentity.key}". Scheduled message was not sent to another chat.`,
            currentIdentity
        };
    }

    return { ok: true, tab, currentIdentity };
}

async function fireScheduledMessage(item) {
    const validation = await validateScheduledTarget(item);
    if (!validation.ok) {
        return markScheduledFailed(item, validation.reason);
    }

    const enqueueResult = await enqueueMessageInternal({
        tabId: item.tabId,
        message: item.text,
        addToEnd: true,
        waitForIdleBeforeStart: true,
        source: 'scheduled',
        conversationIdentity: buildScheduledConversationIdentity(item)
    });

    if (!enqueueResult?.ok) {
        return markScheduledFailed(item, enqueueResult?.error || 'Failed to enqueue scheduled message.');
    }

    return markScheduledCompleted(item, enqueueResult);
}

async function processDueScheduledMessages(source = 'manual', onlyId = null, now = Date.now()) {
    const items = await readScheduledMessages();
    const selectedItem = onlyId ? items.find((item) => item.id === onlyId) : null;

    if (
        selectedItem &&
        selectedItem.status === 'pending' &&
        Number(selectedItem.dueTs) > now + SCHEDULED_DUE_SKEW_MS
    ) {
        // A one-shot alarm can be delivered early by a test/browser shim. Keep the
        // item pending and replace the consumed alarm instead of sending early.
        createScheduledAlarm(selectedItem);
        return [];
    }

    const dueItems = items.filter((item) => {
        if (onlyId && item.id !== onlyId) return false;
        if (item.status !== 'pending') return false;
        return Number(item.dueTs) <= now + SCHEDULED_DUE_SKEW_MS;
    });

    const fired = [];

    for (const dueItem of dueItems) {
        const claimed = await claimScheduledMessageForFire(dueItem.id, now);
        if (!claimed) {
            continue;
        }

        const result = await fireScheduledMessage(claimed);
        fired.push(result);
    }

    if (dueItems.length === 0 && onlyId) {
        // Duplicate/idempotent alarm for a non-pending item: no-op.
        return [];
    }

    if (source && fired.length > 0) {
        logQueueEvent('', 'info', `Processed ${fired.length} due scheduled message${fired.length === 1 ? '' : 's'}.`, {
            source,
            scheduledIds: fired.map((item) => item.id)
        });
    }

    return fired;
}

async function recoverScheduledMessages(source = 'startup') {
    const items = await readScheduledMessages();
    let changed = false;

    for (const item of items) {
        if (item.status === 'firing') {
            item.status = 'failed';
            item.failureReason = 'Delivery interrupted by background restart. Retry only if the message is not already queued.';
            item.updatedAt = Date.now();
            clearScheduledAlarm(item.id);
            changed = true;
        }
    }

    if (changed) {
        await writeScheduledMessages(items);
    }

    for (const item of items) {
        if (item.status === 'pending') {
            createScheduledAlarm(item);
        }
    }

    return processDueScheduledMessages(source);
}

function handleScheduleMessage(request, sendResponse) {
    createScheduledMessage({
        text: request.message || request.text,
        dueTs: request.dueTs,
        tabId: request.tabId,
        conversationIdentity: request.conversationIdentity || null
    })
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
}

function handleListScheduledMessages(sendResponse) {
    readScheduledMessages()
        .then((items) => sendResponse({ ok: true, items }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), items: [] }));
}

function handleCancelScheduledMessage(request, sendResponse) {
    cancelScheduledMessage(request.id || request.scheduledId)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
}

function handleDeleteScheduledMessage(request, sendResponse) {
    deleteScheduledMessage(request.id || request.scheduledId)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
}

function handleRetryScheduledMessage(request, sendResponse) {
    retryScheduledMessage(request.id || request.scheduledId, request.dueTs)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        sanitizeLogValue,
        isSensitiveLogKey,
        describeLoggedMessage,
        serializeError,
        previewText,
        getActiveProviderAdapter,
        resolveTabConversationIdentity,
        validateJobTargetConversation,
        restoreDurableJobs,
        getDurableJobsState,
        getRunningJobsSnapshot,
        updateRunningJobsStorage,
        flushQueueState,
        flushQueueDebugLogs,
        logQueueEvent,
        handleGetQueueDebugLogs,
        handleClearQueueDebugLogs,
        resumeDurableQueues,
        handleStartSequence,
        handleEnqueueMessage,
        enqueueMessageInternal,
        pauseJob,
        recoverFromDeliveryTimeout,
        sendPromptToSpecificTab,
        inspectTabCommandTurns,
        waitForSubmissionAck,
        isSubmissionConfirmed,
        refreshChatGPTTab,
        waitForTabToRecover,
        waitForTabResponse,
        retryCurrentCommandIfEnabled,
        classifyQueueFailure,
        getRetryBackoffDelayMs,
        handleRetryPausedJob,
        completeCurrentCommand,
        QUEUE_SETTINGS_DEFAULTS,
        QUEUE_RETRY_POLICY,
        QUEUE_WAIT_POLICY,
        UNLIMITED_RETRY_DELAY_MS,
        MAX_QUEUE_DEBUG_LOG_ENTRIES,
        jobs,
        SCHEDULED_MESSAGES_KEY,
        SCHEDULED_ALARM_PREFIX,
        scheduledAlarmName,
        readScheduledMessages,
        writeScheduledMessages,
        createScheduledMessage,
        cancelScheduledMessage,
        deleteScheduledMessage,
        retryScheduledMessage,
        processDueScheduledMessages,
        recoverScheduledMessages,
        claimScheduledMessageForFire,
        fireScheduledMessage,
        identitiesMatchForSchedule,
        sortScheduledMessages
    };
}
