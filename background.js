const jobs = new Map();
const QUEUE_DEBUG_LOG_KEY = 'queueDebugLogs';
const QUEUE_DURABLE_STATE_KEY = 'queueDurableJobs';
const MAX_QUEUE_DEBUG_LOG_ENTRIES = 300;
const QUEUE_SETTINGS_DEFAULTS = {
    queueUnlimitedRetryWait: false,
    queueDeepResearchAware: true
};
const UNLIMITED_RETRY_DELAY_MS = 15000;
const QUEUE_WAKE_ALARM_NAME = 'queue-wake';
const QUEUE_WAKE_ALARM_PERIOD_MINUTES = 0.5;
const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

let queueLogWrite = Promise.resolve();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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

    return false;
});

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

        if (!tab || !tab.id || !isChatGPTUrl(tab.url)) {
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
            queueDeepResearchAware: undefined
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
        updateRunningJobsStorage();
    }
});

if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== QUEUE_WAKE_ALARM_NAME) return;

        resumeDurableQueues('alarm');
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

    updateRunningJobsStorage();

    for (const job of restoredJobs) {
        if (job.isRunning && !job.isPaused && !job.isStopped) {
            processQueue(job.tabId);
        }
    }

    return restoredJobs.length;
}

function restoreDurableJobs(durableJobs) {
    const restoredJobs = [];

    for (const rawJob of Object.values(durableJobs || {})) {
        if (!rawJob || !rawJob.tabId) continue;

        const tabId = Number(rawJob.tabId);
        const queue = Array.isArray(rawJob.queue)
            ? rawJob.queue.map(message => String(message || '').trim()).filter(Boolean)
            : [];
        const currentMessage = String(rawJob.currentMessage || '').trim() || null;

        if (!currentMessage && queue.length === 0) continue;

        const job = {
            tabId,
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
            startedAt: Number(rawJob.startedAt || Date.now()),
            updatedAt: Number(rawJob.updatedAt || Date.now())
        };

        job.totalMessages = getTotalMessages(job);

        if (job.currentMessage && !job.currentCommandNumber) {
            job.currentCommandNumber = Number(job.completedCount || 0) + 1;
        }

        if (job.currentPhase === 'sending' || job.currentPhase === 'retry-wait') {
            logQueueEvent(tabId, 'warn', 'Recovered a command that was not confirmed submitted; retrying it.', {
                phase: job.currentPhase,
                commandNumber: job.currentCommandNumber || 0,
                totalMessages: getTotalMessages(job),
                messagePreview: previewText(job.currentMessage || '', 160)
            });
            job.queue.unshift(job.currentMessage);
            job.currentMessage = null;
            job.currentCommandNumber = 0;
            job.currentPhase = 'queued';
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
    readLocalStorage([QUEUE_DEBUG_LOG_KEY])
        .then((data) => {
            sendResponse({
                ok: true,
                logs: Array.isArray(data[QUEUE_DEBUG_LOG_KEY]) ? data[QUEUE_DEBUG_LOG_KEY] : []
            });
        })
        .catch((error) => {
            sendResponse({
                ok: false,
                error: error?.message || 'Could not read queue log.'
            });
        });
}

function handleClearQueueDebugLogs(sendResponse) {
    queueLogWrite = queueLogWrite
        .catch(() => {})
        .then(() => writeLocalStorage({ [QUEUE_DEBUG_LOG_KEY]: [] }));

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

function handleStartSequence(request, sendResponse) {
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

    jobs.set(tabId, {
        tabId,
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
        currentPhase: 'queued',
        startedAt: Date.now(),
        updatedAt: Date.now()
    });

    logQueueEvent(tabId, 'info', `Started sequence with ${messages.length} command${messages.length === 1 ? '' : 's'}.`, {
        totalMessages: messages.length,
        firstMessagePreview: previewText(messages[0] || '', 160)
    });

    updateRunningJobsStorage();
    processQueue(tabId);

    sendResponse({ ok: true, tabId });
}

function handleEnqueueMessage(request, sender, sendResponse) {
    const tabId = Number(request.tabId || sender?.tab?.id || 0);
    const message = String(request.message || '').trim();
    const addToEnd = request.position === 'end';
    const waitForIdleBeforeStart = request.waitForIdleBeforeStart === true;
    const source = request.source || 'popup';

    if (!tabId || !message) {
        logQueueEvent(tabId, 'warn', 'Could not enqueue command: missing tab or message.');
        sendResponse({ ok: false, error: 'Missing tabId or message.' });
        return;
    }

    const existingJob = jobs.get(tabId);

    if (existingJob && existingJob.isPaused) {
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
        updateRunningJobsStorage();

        sendResponse({
            ok: true,
            queued: true,
            paused: true,
            remaining: getRemainingCount(existingJob),
            message: 'Message added to paused queue. Click Retry to continue.'
        });
        return;
    }

    if (existingJob && existingJob.isRunning) {
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

        updateRunningJobsStorage();

        sendResponse({
            ok: true,
            queued: true,
            started: false,
            remaining: getRemainingCount(existingJob),
            message: addToEnd
                ? 'Message added to the running queue.'
                : 'Message added next in the running queue.'
        });
        return;
    }

    jobs.set(tabId, {
        tabId,
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

    updateRunningJobsStorage();
    processQueue(tabId);

    sendResponse({
        ok: true,
        queued: true,
        started: true,
        remaining: 1,
        waitingForIdle: waitForIdleBeforeStart,
        message: waitForIdleBeforeStart
            ? 'Message queued to send after the current response.'
            : 'Started a new queue with this message.'
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

    if (job.queue.length === 0) {
        logQueueEvent(tabId, 'warn', 'Paused queue had no commands left when retry was requested.', {
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job)
        });
        jobs.delete(tabId);
        updateRunningJobsStorage();
        sendResponse({ ok: false, error: 'Paused queue has no messages left.' });
        return;
    }

    job.isPaused = false;
    job.isRunning = true;
    job.isStopped = false;
    job.pausedReason = '';
    job.lastError = '';
    job.currentPhase = 'queued';
    job.updatedAt = Date.now();

    logQueueEvent(tabId, 'info', 'Retrying paused queue.', {
        completedCount: job.completedCount || 0,
        totalMessages: getTotalMessages(job),
        remaining: getRemainingCount(job),
        nextMessagePreview: previewText(job.queue[0] || '', 160)
    });

    updateRunningJobsStorage();
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
        updateRunningJobsStorage();

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

    updateRunningJobsStorage();
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
            if (job.currentMessage && job.currentPhase === 'waiting') {
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
                    queueSettings
                });

                if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
                    return;
                }

                if (!waitResult.ok) {
                    logQueueEvent(tabId, 'error', `Command ${job.currentCommandNumber}/${totalMessages} failed while waiting for ChatGPT.`, {
                        commandNumber: job.currentCommandNumber,
                        totalMessages,
                        error: waitResult.error || 'ChatGPT response failed.',
                        diagnostics: waitResult.details || {}
                    });

                    if (await retryCurrentCommandIfEnabled(tabId, job, 'wait', waitResult.error || 'ChatGPT response failed.', waitResult.details || {})) {
                        continue;
                    }

                    pauseJob(tabId, waitResult.error || 'ChatGPT response failed.', {
                        phase: 'wait',
                        diagnostics: waitResult.details || {}
                    });
                    return;
                }

                completeCurrentCommand(tabId, job, totalMessages, waitResult.details || {});

                if (job.queue.length > 0) {
                    await sleep(2000);
                }

                continue;
            }

            if (job.currentMessage) {
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
                updateRunningJobsStorage();
                continue;
            }

            if (job.queue.length === 0) {
                break;
            }

            if (job.waitForIdleBeforeSend) {
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
                    return;
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
                    return;
                }

                job.waitForIdleBeforeSend = false;
                job.currentPhase = 'queued';
                job.updatedAt = Date.now();
                updateRunningJobsStorage();
                await sleep(500);
                continue;
            }

            job.currentMessage = job.queue.shift();
            job.currentCommandNumber = Number(job.completedCount || 0) + 1;
            job.lastError = '';
            job.currentPhase = 'sending';
            job.updatedAt = Date.now();
            const totalMessages = getTotalMessages(job);
            const queueSettings = await getQueueSettings();

            logQueueEvent(tabId, 'info', `Sending command ${job.currentCommandNumber}/${totalMessages}.`, {
                commandNumber: job.currentCommandNumber,
                totalMessages,
                remainingBeforeSend: getRemainingCount(job),
                messagePreview: previewText(job.currentMessage || '', 160),
                settings: queueSettings
            });

            updateRunningJobsStorage();

            const sendResult = await sendPromptToSpecificTab(tabId, job.currentMessage);

            if (!jobs.has(tabId) || job.isStopped) {
                return;
            }

            if (!sendResult.ok) {
                logQueueEvent(tabId, 'error', `Failed to submit command ${job.currentCommandNumber}/${totalMessages}.`, {
                    commandNumber: job.currentCommandNumber,
                    totalMessages,
                    error: sendResult.error || 'Could not send message to ChatGPT.',
                    diagnostics: sendResult.details || {}
                });

                if (await retryCurrentCommandIfEnabled(tabId, job, 'send', sendResult.error || 'Could not send message to ChatGPT.', sendResult.details || {})) {
                    continue;
                }

                pauseJob(tabId, sendResult.error || 'Could not send message to ChatGPT.', {
                    phase: 'send',
                    diagnostics: sendResult.details || {}
                });
                return;
            }

            job.currentPhase = 'waiting';
            job.updatedAt = Date.now();
            updateRunningJobsStorage();

            logQueueEvent(tabId, 'success', `Submitted command ${job.currentCommandNumber}/${totalMessages}.`, {
                commandNumber: job.currentCommandNumber,
                totalMessages,
                diagnostics: sendResult.details || {}
            });

            const waitResult = await waitForTabResponse(tabId, {
                commandNumber: job.currentCommandNumber,
                totalMessages,
                queueSettings
            });

            if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
                return;
            }

            if (!waitResult.ok) {
                logQueueEvent(tabId, 'error', `Command ${job.currentCommandNumber}/${totalMessages} failed while waiting for ChatGPT.`, {
                    commandNumber: job.currentCommandNumber,
                    totalMessages,
                    error: waitResult.error || 'ChatGPT response failed.',
                    diagnostics: waitResult.details || {}
                });

                if (await retryCurrentCommandIfEnabled(tabId, job, 'wait', waitResult.error || 'ChatGPT response failed.', waitResult.details || {})) {
                    continue;
                }

                pauseJob(tabId, waitResult.error || 'ChatGPT response failed.', {
                    phase: 'wait',
                    diagnostics: waitResult.details || {}
                });
                return;
            }

            completeCurrentCommand(tabId, job, totalMessages, waitResult.details || {});

            if (job.queue.length > 0) {
                await sleep(2000);
            }
        }

        if (job.isStopped) {
            jobs.delete(tabId);
            updateRunningJobsStorage();
            return;
        }

        if (!job.isPaused && job.queue.length === 0 && !job.currentMessage) {
            logQueueEvent(tabId, 'success', 'Queue completed.', {
                completedCount: job.completedCount || 0,
                totalMessages: getTotalMessages(job)
            });
            jobs.delete(tabId);
            updateRunningJobsStorage();
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

function completeCurrentCommand(tabId, job, totalMessages, diagnostics = {}) {
    job.completedCount = Number(job.completedCount || 0) + 1;

    logQueueEvent(tabId, 'success', `Completed command ${job.completedCount}/${totalMessages}.`, {
        commandNumber: job.completedCount,
        totalMessages,
        remaining: Math.max(0, job.queue.length),
        diagnostics
    });

    job.currentMessage = null;
    job.currentCommandNumber = 0;
    job.currentPhase = 'queued';
    job.updatedAt = Date.now();
    updateRunningJobsStorage();
}

function pauseJob(tabId, reason, details = {}) {
    const job = jobs.get(tabId);
    if (!job) return;

    const failedMessage = job.currentMessage || '';

    if (job.currentMessage) {
        job.queue.unshift(job.currentMessage);
        job.currentMessage = null;
    }

    job.isRunning = false;
    job.isPaused = true;
    job.isStopped = false;
    job.pausedReason = reason || 'Queue paused because ChatGPT failed.';
    job.lastError = job.pausedReason;
    job.currentPhase = 'paused';
    job.updatedAt = Date.now();

    logQueueEvent(tabId, 'error', 'Queue paused.', {
        reason: job.pausedReason,
        commandNumber: job.currentCommandNumber || 0,
        completedCount: job.completedCount || 0,
        totalMessages: getTotalMessages(job),
        remaining: getRemainingCount(job),
        failedMessagePreview: previewText(failedMessage, 160),
        ...details
    });

    job.currentCommandNumber = 0;

    updateRunningJobsStorage();

    notifyRuntime({
        action: 'automationPaused',
        tabId,
        error: job.pausedReason
    });
}

async function retryCurrentCommandIfEnabled(tabId, job, phase, reason, diagnostics = {}) {
    if (!job || job.isStopped || job.isPaused || !job.isRunning) {
        return false;
    }

    const queueSettings = await getQueueSettings();

    if (!queueSettings.queueUnlimitedRetryWait) {
        return false;
    }

    if (!job.currentMessage) {
        return false;
    }

    job.lastError = reason || 'Queue command failed.';
    job.currentPhase = 'retry-wait';
    job.updatedAt = Date.now();
    updateRunningJobsStorage();

    logQueueEvent(tabId, 'warn', `Unlimited retry mode will retry command ${job.currentCommandNumber || '?'}/${getTotalMessages(job)}.`, {
        phase,
        reason: job.lastError,
        retryInSeconds: Math.round(UNLIMITED_RETRY_DELAY_MS / 1000),
        commandNumber: job.currentCommandNumber || 0,
        completedCount: job.completedCount || 0,
        totalMessages: getTotalMessages(job),
        remaining: getRemainingCount(job),
        diagnostics
    });

    await sleep(UNLIMITED_RETRY_DELAY_MS);

    if (!jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return false;
    }

    job.queue.unshift(job.currentMessage);
    job.currentMessage = null;
    job.currentCommandNumber = 0;
    job.currentPhase = 'queued';
    job.updatedAt = Date.now();
    updateRunningJobsStorage();

    return true;
}

async function sendPromptToSpecificTab(tabId, text) {
    try {
        const results = await executeScript({
            target: { tabId },
            func: async (msg) => {
                function sleepInPage(ms) {
                    return new Promise(resolve => setTimeout(resolve, ms));
                }

                function describeElement(element) {
                    if (!element) return null;

                    return {
                        tagName: element.tagName || '',
                        id: element.id || '',
                        testId: element.getAttribute('data-testid') || '',
                        ariaLabel: element.getAttribute('aria-label') || '',
                        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
                        disabled: !!element.disabled,
                        ariaDisabled: element.getAttribute('aria-disabled') || ''
                    };
                }

                function findFirstSelector(selectors) {
                    for (const selector of selectors) {
                        const element = document.querySelector(selector);

                        if (element) {
                            return {
                                selector,
                                element
                            };
                        }
                    }

                    return {
                        selector: '',
                        element: null
                    };
                }

                const inputMatch = findFirstSelector([
                    'div[contenteditable="true"]',
                    '[contenteditable="true"]'
                ]);

                const input = inputMatch.element;

                if (!input) {
                    return {
                        ok: false,
                        error: 'ChatGPT input box was not found.',
                        details: {
                            contentEditableCount: document.querySelectorAll('[contenteditable="true"]').length,
                            activeElement: describeElement(document.activeElement),
                            url: location.href,
                            title: document.title
                        }
                    };
                }

                input.focus();
                input.innerHTML = '';

                const paragraph = document.createElement('p');
                paragraph.innerText = msg;
                input.appendChild(paragraph);

                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: msg
                }));

                await sleepInPage(700);

                const sendButtonMatch = findFirstSelector([
                    'button[data-testid="send-button"]',
                    'button[aria-label="Send prompt"]',
                    'button[type="submit"]'
                ]);

                const sendButton = sendButtonMatch.element;

                if (!sendButton) {
                    return {
                        ok: false,
                        error: 'Send button was not found.',
                        details: {
                            inputSelector: inputMatch.selector,
                            inputTextLength: (input.innerText || input.textContent || '').length,
                            buttonCount: document.querySelectorAll('button').length,
                            activeElement: describeElement(document.activeElement),
                            url: location.href,
                            title: document.title
                        }
                    };
                }

                if (sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') {
                    return {
                        ok: false,
                        error: 'Send button is disabled.',
                        details: {
                            inputSelector: inputMatch.selector,
                            sendButtonSelector: sendButtonMatch.selector,
                            inputTextLength: (input.innerText || input.textContent || '').length,
                            sendButton: describeElement(sendButton),
                            url: location.href,
                            title: document.title
                        }
                    };
                }

                sendButton.click();

                return {
                    ok: true,
                    details: {
                        inputSelector: inputMatch.selector,
                        sendButtonSelector: sendButtonMatch.selector,
                        messageLength: String(msg || '').length,
                        url: location.href,
                        title: document.title
                    }
                };
            },
            args: [text]
        });

        const result = results?.[0]?.result;

        if (!result || !result.ok) {
            return {
                ok: false,
                error: result?.error || 'Could not send prompt.',
                details: result?.details || {
                    scriptResultCount: Array.isArray(results) ? results.length : 0
                }
            };
        }

        return {
            ok: true,
            details: result.details || {}
        };
    } catch (error) {
        return {
            ok: false,
            error: error?.message || 'Failed to inject prompt into ChatGPT tab.',
            details: {
                error: serializeError(error)
            }
        };
    }
}

async function waitForTabResponse(tabId, context = {}) {
    const startedAt = Date.now();
    const queueSettings = {
        ...QUEUE_SETTINGS_DEFAULTS,
        ...context.queueSettings
    };
    const maxWaitMs = queueSettings.queueUnlimitedRetryWait
        ? Number.POSITIVE_INFINITY
        : 10 * 60 * 1000;
    let sawGenerating = false;
    let sawDeepResearch = false;
    let lastProgressLogAt = startedAt;
    const waitLabel = getWaitContextLabel(context);

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
            resolveRaw(value);
        };
        checkInterval = setInterval(() => {
            if (settled) {
                clearInterval(checkInterval);
                return;
            }

            const job = jobs.get(tabId);

            if (!job || job.isStopped) {
                resolve({
                    ok: false,
                    error: 'Queue was stopped.',
                    details: {
                        elapsedMs: Date.now() - startedAt,
                        sawGenerating,
                        sawDeepResearch,
                        settings: queueSettings
                    }
                });
                return;
            }

            if (job.isPaused || !job.isRunning) {
                clearInterval(checkInterval);
                resolve({
                    ok: false,
                    error: 'Queue was paused.',
                    details: {
                        elapsedMs: Date.now() - startedAt,
                        sawGenerating,
                        sawDeepResearch,
                        settings: queueSettings
                    }
                });
                return;
            }

            if (Date.now() - startedAt > maxWaitMs && !(queueSettings.queueDeepResearchAware && sawDeepResearch)) {
                clearInterval(checkInterval);
                resolve({
                    ok: false,
                    error: 'Timed out waiting for ChatGPT response.',
                    details: {
                        elapsedMs: Date.now() - startedAt,
                        sawGenerating,
                        sawDeepResearch,
                        settings: queueSettings
                    }
                });
                return;
            }

            try {
                executeScript({
                    target: { tabId },
                    func: () => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const stopButton =
                            document.querySelector('button[data-testid="stop-button"]') ||
                            document.querySelector('[aria-label="Stop generating"]') ||
                            document.querySelector('button[aria-label="Stop streaming"]') ||
                            buttons.find(button => {
                                const label = (
                                    button.getAttribute('aria-label') ||
                                    button.innerText ||
                                    button.textContent ||
                                    ''
                                ).toLowerCase();

                                return (
                                    label.includes('stop generating') ||
                                    label.includes('stop streaming') ||
                                    label.includes('stop response') ||
                                    label.includes('interrupt')
                                );
                            });

                        const resultStreaming =
                            document.querySelector('.result-streaming') ||
                            document.querySelector('[data-testid*="conversation-turn"] .result-streaming') ||
                            document.querySelector('[data-message-streaming="true"]') ||
                            document.querySelector('[data-testid*="streaming"]');

                        const bodyText = document.body ? document.body.innerText : '';
                        const pageText = bodyText.toLowerCase();
                        const errorMarkers = [
                            'something went wrong',
                            'there was an error',
                            'error generating a response',
                            'network error',
                            'failed to generate',
                            'try again later'
                        ];
                        const matchedError = errorMarkers.find(marker => pageText.includes(marker)) || '';
                        const matchedErrorIndex = matchedError ? pageText.indexOf(matchedError) : -1;
                        const errorSnippet = matchedErrorIndex >= 0
                            ? bodyText
                                .slice(Math.max(0, matchedErrorIndex - 120), matchedErrorIndex + 260)
                                .replace(/\s+/g, ' ')
                                .trim()
                            : '';

                        const hasKnownError = !!matchedError;
                        const hasTryAgainButton = buttons.some(btn => {
                            const text = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase().trim();
                            return text === 'retry' || text === 'try again';
                        });

                        const statusText = Array.from(document.querySelectorAll(
                            '[role="status"], [aria-live], [data-testid*="status"], [data-testid*="progress"], [data-testid*="research"]'
                        ))
                            .map(node => node.innerText || node.textContent || '')
                            .join(' ')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .slice(0, 1200);
                        const researchText = `${statusText} ${buttons.map(btn => btn.innerText || btn.getAttribute('aria-label') || '').join(' ')}`.toLowerCase();
                        const researchProgressMarkers = [
                            'deep research',
                            'researching',
                            'searching the web',
                            'searching sources',
                            'reading sources',
                            'analyzing sources',
                            'gathering sources',
                            'checking sources',
                            'synthesizing',
                            'creating report',
                            'writing report'
                        ];
                        const matchedResearchMarker =
                            researchProgressMarkers.find(marker => researchText.includes(marker)) ||
                            researchProgressMarkers.find(marker => pageText.includes(marker)) ||
                            '';
                        const deepResearchActive = !!matchedResearchMarker && !!(stopButton || resultStreaming);

                        return {
                            generating: !!(stopButton || resultStreaming),
                            deepResearchActive,
                            matchedResearchMarker,
                            researchStatusPreview: statusText,
                            hasError: !!hasKnownError,
                            hasTryAgainButton: !!hasTryAgainButton,
                            errorSnippet,
                            matchedError,
                            url: location.href,
                            title: document.title
                        };
                }
                }, (results, executionError) => {
                if (settled) {
                    return;
                }
                if (executionError) {
                    clearInterval(checkInterval);
                    resolve({
                        ok: false,
                        error: executionError.message || 'Could not read ChatGPT tab.',
                        details: {
                            elapsedMs: Date.now() - startedAt,
                            sawGenerating,
                            sawDeepResearch,
                            settings: queueSettings,
                            error: serializeError(executionError)
                        }
                    });
                    return;
                }

                const state = results?.[0]?.result || {};

                if (state.hasError || state.hasTryAgainButton) {
                    clearInterval(checkInterval);
                    resolve({
                        ok: false,
                        error: 'ChatGPT showed an error or retry state.',
                        details: {
                            elapsedMs: Date.now() - startedAt,
                            sawGenerating,
                            sawDeepResearch,
                            settings: queueSettings,
                            state
                        }
                    });
                    return;
                }

                const deepResearchActive = queueSettings.queueDeepResearchAware && !!state.deepResearchActive;

                if (deepResearchActive && !sawDeepResearch) {
                    logQueueEvent(tabId, 'info', `Deep research activity detected for ${waitLabel}.`, {
                        commandNumber: context.commandNumber || 0,
                        totalMessages: context.totalMessages || 0,
                        elapsedMs: Date.now() - startedAt,
                        matchedResearchMarker: state.matchedResearchMarker || '',
                        researchStatusPreview: state.researchStatusPreview || ''
                    });
                }

                if (state.generating || deepResearchActive) {
                    if (!sawGenerating) {
                        logQueueEvent(tabId, 'info', `ChatGPT is responding for ${waitLabel}.`, {
                            commandNumber: context.commandNumber || 0,
                            totalMessages: context.totalMessages || 0,
                            elapsedMs: Date.now() - startedAt,
                            state
                        });
                    }

                    sawGenerating = sawGenerating || !!state.generating;
                    sawDeepResearch = sawDeepResearch || deepResearchActive;

                    if (Date.now() - lastProgressLogAt > 30000) {
                        logQueueEvent(tabId, 'info', `Still waiting for ${waitLabel}.`, {
                            commandNumber: context.commandNumber || 0,
                            totalMessages: context.totalMessages || 0,
                            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
                            generating: !!state.generating,
                            deepResearchActive,
                            sawGenerating,
                            sawDeepResearch,
                            settings: queueSettings
                        });
                        lastProgressLogAt = Date.now();
                    }

                    return;
                }

                if (context.waitForExistingGeneration) {
                    clearInterval(checkInterval);
                    setTimeout(() => {
                        resolve({
                            ok: true,
                            details: {
                                waitedForExistingGeneration: true,
                                elapsedMs: Date.now() - startedAt,
                                sawGenerating,
                                sawDeepResearch,
                                settings: queueSettings,
                                state
                            }
                        });
                    }, sawGenerating || sawDeepResearch ? 800 : 0);
                    return;
                }

                if (sawGenerating || sawDeepResearch) {
                    clearInterval(checkInterval);
                    setTimeout(() => {
                        resolve({
                            ok: true,
                            details: {
                                elapsedMs: Date.now() - startedAt,
                                sawGenerating,
                                sawDeepResearch,
                                settings: queueSettings,
                                state
                            }
                        });
                    }, 800);
                    return;
                }

                if (!queueSettings.queueUnlimitedRetryWait && Date.now() - startedAt > 5000) {
                    clearInterval(checkInterval);
                    logQueueEvent(tabId, 'warn', `No generating indicator after ${waitLabel}; assuming it completed.`, {
                        commandNumber: context.commandNumber || 0,
                        totalMessages: context.totalMessages || 0,
                        elapsedMs: Date.now() - startedAt,
                        settings: queueSettings,
                        state
                    });
                    resolve({
                        ok: true,
                        details: {
                            assumedCompleteWithoutGeneratingIndicator: true,
                            elapsedMs: Date.now() - startedAt,
                            sawGenerating,
                            sawDeepResearch,
                            settings: queueSettings,
                            state
                        }
                    });
                    return;
                }

                if (queueSettings.queueUnlimitedRetryWait && Date.now() - lastProgressLogAt > 30000) {
                    logQueueEvent(tabId, 'info', `Unlimited wait mode is still waiting for ${waitLabel}.`, {
                        commandNumber: context.commandNumber || 0,
                        totalMessages: context.totalMessages || 0,
                        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
                        generating: !!state.generating,
                        deepResearchActive,
                        sawGenerating,
                        sawDeepResearch,
                        settings: queueSettings
                    });
                    lastProgressLogAt = Date.now();
                }
                });
            } catch (error) {
                clearInterval(checkInterval);
                resolve({
                    ok: false,
                    error: error?.message || 'Could not inspect ChatGPT response state.',
                    details: {
                        elapsedMs: Date.now() - startedAt,
                        sawGenerating,
                        sawDeepResearch,
                        settings: queueSettings,
                        error: serializeError(error)
                    }
                });
            }
        }, 1000);
    });
}

function getWaitContextLabel(context = {}) {
    if (context.waitForExistingGeneration) {
        return context.waitLabel || 'the current ChatGPT response';
    }

    return `command ${context.commandNumber || '?'}/${context.totalMessages || '?'}`;
}

function getRunningJobsSnapshot() {
    const snapshot = {};

    for (const [tabId, job] of jobs.entries()) {
        snapshot[tabId] = {
            tabId: job.tabId,
            remaining: getRemainingCount(job),
            pending: job.queue.length,
            isRunning: job.isRunning,
            isPaused: job.isPaused,
            isStopped: job.isStopped,
            status: getJobStatus(job),
            pausedReason: job.pausedReason || '',
            lastError: job.lastError || '',
            currentMessage: job.currentMessage || '',
            currentMessagePreview: previewText(job.currentMessage || ''),
            nextMessagePreview: previewText(job.queue[0] || ''),
            runId: job.runId || '',
            totalMessages: getTotalMessages(job),
            completedCount: job.completedCount || 0,
            currentCommandNumber: job.currentCommandNumber || 0,
            currentPhase: job.currentPhase || '',
            waitForIdleBeforeSend: job.waitForIdleBeforeSend === true,
            startedAt: job.startedAt,
            updatedAt: job.updatedAt
        };
    }

    return snapshot;
}

function getRemainingCount(job) {
    return job.queue.length + (job.currentMessage ? 1 : 0);
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

function updateRunningJobsStorage() {
    const snapshot = getRunningJobsSnapshot();
    const durableJobs = getDurableJobsState();
    const hasJobs = Object.keys(snapshot).length > 0;

    chrome.storage.local.set({
        runningJobs: snapshot,
        queueDurableJobs: durableJobs,
        isRunning: hasJobs
    });

    updateQueueWakeAlarm(hasJobs);
}

function getDurableJobsState() {
    const state = {};

    for (const [tabId, job] of jobs.entries()) {
        state[tabId] = {
            tabId: job.tabId,
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
        const newCount = (data.successCount || 0) + 1;

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

    queueLogWrite = queueLogWrite
        .catch(() => {})
        .then(async () => {
            const data = await readLocalStorage([QUEUE_DEBUG_LOG_KEY]);
            const logs = Array.isArray(data[QUEUE_DEBUG_LOG_KEY]) ? data[QUEUE_DEBUG_LOG_KEY] : [];
            const nextLogs = [...logs, entry].slice(-MAX_QUEUE_DEBUG_LOG_ENTRIES);

            await writeLocalStorage({ [QUEUE_DEBUG_LOG_KEY]: nextLogs });

            notifyRuntime({
                action: 'queueDebugLogUpdated',
                entry
            });
        })
        .catch((error) => {
            console.warn('Could not write queue debug log:', error);
        });

    return entry;
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

        return {
            queueUnlimitedRetryWait: data.queueUnlimitedRetryWait === true,
            queueDeepResearchAware: data.queueDeepResearchAware !== false
        };
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

function extensionApiPromise(callWithCallback, callWithoutCallback) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const settleResolve = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const settleReject = (error) => {
            if (settled) return;
            settled = true;
            reject(error instanceof Error ? error : new Error(String(error || 'Extension API call failed.')));
        };

        const finishFromCallback = (value) => {
            if (settled) return;

            const lastError = chrome.runtime.lastError;

            if (lastError) {
                settleReject(new Error(lastError.message || 'Extension API call failed.'));
                return;
            }

            settleResolve(value);
        };

        let maybePromise;

        try {
            maybePromise = callWithCallback(finishFromCallback);
        } catch (callbackError) {
            if (!callWithoutCallback) {
                settleReject(callbackError);
                return;
            }

            try {
                maybePromise = callWithoutCallback();
            } catch (promiseError) {
                settleReject(promiseError);
                return;
            }
        }

        if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(settleResolve, settleReject);
        }
    });
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

function sanitizeLogValue(value, depth = 0) {
    if (value === null || value === undefined) {
        return value;
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

        for (const [key, item] of entries) {
            if (typeof item === 'function' || item === undefined) continue;
            clean[key] = sanitizeLogValue(item, depth + 1);
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

function isChatGPTUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }

    try {
        const parsed = new URL(url);

        return parsed.protocol === 'https:' && CHATGPT_HOSTS.has(parsed.hostname.toLowerCase());
    } catch {
        return false;
    }
}

function previewText(text, maxLength = 70) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();

    if (clean.length <= maxLength) {
        return clean;
    }

    return clean.slice(0, maxLength - 1) + '…';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isChatGPTUrl
    };
}
