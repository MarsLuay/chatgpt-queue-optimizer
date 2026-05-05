const jobs = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'startSequence') {
        handleStartSequence(request, sendResponse);
        return true;
    }

    if (request.action === 'enqueueMessage') {
        handleEnqueueMessage(request, sendResponse);
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

    return false;
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-optimizer') return;

    try {
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        if (!tab || !tab.id || !isChatGPTUrl(tab.url)) {
            return;
        }

        chrome.tabs.sendMessage(
            tab.id,
            {
                type: 'TOGGLE_OPTIMIZER',
                source: 'keyboard'
            },
            () => {
                // Ignore if content script is not ready.
                void chrome.runtime.lastError;
            }
        );
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
            autoScroll: undefined
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

            if (Object.keys(defaults).length > 0) {
                chrome.storage.sync.set(defaults);
            }
        }
    );
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (jobs.has(tabId)) {
        jobs.delete(tabId);
        updateRunningJobsStorage();
    }
});

function handleStartSequence(request, sendResponse) {
    const tabId = request.tabId;
    const messages = Array.isArray(request.messages)
        ? request.messages.map(msg => String(msg || '').trim()).filter(Boolean)
        : [];

    if (!tabId || messages.length === 0) {
        sendResponse({ ok: false, error: 'Missing tabId or messages.' });
        return;
    }

    const existingJob = jobs.get(tabId);

    if (existingJob && (existingJob.isRunning || existingJob.isPaused)) {
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
        startedAt: Date.now(),
        updatedAt: Date.now()
    });

    updateRunningJobsStorage();
    processQueue(tabId);

    sendResponse({ ok: true, tabId });
}

function handleEnqueueMessage(request, sendResponse) {
    const tabId = request.tabId;
    const message = String(request.message || '').trim();

    if (!tabId || !message) {
        sendResponse({ ok: false, error: 'Missing tabId or message.' });
        return;
    }

    const existingJob = jobs.get(tabId);

    if (existingJob && existingJob.isPaused) {
        if (existingJob.queue.length > 0) {
            existingJob.queue.splice(1, 0, message);
        } else {
            existingJob.queue.push(message);
        }

        existingJob.updatedAt = Date.now();
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
        existingJob.queue.unshift(message);
        existingJob.updatedAt = Date.now();

        updateRunningJobsStorage();

        sendResponse({
            ok: true,
            queued: true,
            started: false,
            remaining: getRemainingCount(existingJob),
            message: 'Message added next in the running queue.'
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
        startedAt: Date.now(),
        updatedAt: Date.now()
    });

    updateRunningJobsStorage();
    processQueue(tabId);

    sendResponse({
        ok: true,
        queued: true,
        started: true,
        remaining: 1,
        message: 'Started a new queue with this message.'
    });
}

function handleRetryPausedJob(request, sendResponse) {
    const tabId = request.tabId;
    const job = jobs.get(tabId);

    if (!tabId || !job) {
        sendResponse({ ok: false, error: 'No queue found for this tab.' });
        return;
    }

    if (!job.isPaused) {
        sendResponse({ ok: false, error: 'This queue is not paused.' });
        return;
    }

    if (job.queue.length === 0) {
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
    job.updatedAt = Date.now();

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
        jobs.delete(tabId);
    }

    updateRunningJobsStorage();
    sendResponse({ ok: true, stopped: 'all' });
}

async function processQueue(tabId) {
    const job = jobs.get(tabId);

    if (!job || job.isPaused || !job.isRunning) {
        return;
    }

    try {
        while (job.queue.length > 0 && job.isRunning && !job.isPaused && !job.isStopped) {
            job.currentMessage = job.queue.shift();
            job.updatedAt = Date.now();
            updateRunningJobsStorage();

            const sendResult = await sendPromptToSpecificTab(tabId, job.currentMessage);

            if (!sendResult.ok) {
                pauseJob(tabId, sendResult.error || 'Could not send message to ChatGPT.');
                return;
            }

            const waitResult = await waitForTabResponse(tabId);

            if (!waitResult.ok) {
                pauseJob(tabId, waitResult.error || 'ChatGPT response failed.');
                return;
            }

            job.currentMessage = null;
            job.updatedAt = Date.now();
            updateRunningJobsStorage();

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
            jobs.delete(tabId);
            updateRunningJobsStorage();
            recordCompletedRun(tabId);
        }
    } catch (error) {
        pauseJob(tabId, error?.message || 'Unexpected automation error.');
    }
}

function pauseJob(tabId, reason) {
    const job = jobs.get(tabId);
    if (!job) return;

    if (job.currentMessage) {
        job.queue.unshift(job.currentMessage);
        job.currentMessage = null;
    }

    job.isRunning = false;
    job.isPaused = true;
    job.isStopped = false;
    job.pausedReason = reason || 'Queue paused because ChatGPT failed.';
    job.lastError = job.pausedReason;
    job.updatedAt = Date.now();

    updateRunningJobsStorage();

    notifyRuntime({
        action: 'automationPaused',
        tabId,
        error: job.pausedReason
    });
}

async function sendPromptToSpecificTab(tabId, text) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (msg) => {
                function sleepInPage(ms) {
                    return new Promise(resolve => setTimeout(resolve, ms));
                }

                const input =
                    document.querySelector('div[contenteditable="true"]') ||
                    document.querySelector('[contenteditable="true"]');

                if (!input) {
                    return {
                        ok: false,
                        error: 'ChatGPT input box was not found.'
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

                const sendButton =
                    document.querySelector('button[data-testid="send-button"]') ||
                    document.querySelector('button[aria-label="Send prompt"]') ||
                    document.querySelector('button[type="submit"]');

                if (!sendButton) {
                    return {
                        ok: false,
                        error: 'Send button was not found.'
                    };
                }

                if (sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') {
                    return {
                        ok: false,
                        error: 'Send button is disabled.'
                    };
                }

                sendButton.click();

                return {
                    ok: true
                };
            },
            args: [text]
        });

        const result = results?.[0]?.result;

        if (!result || !result.ok) {
            return {
                ok: false,
                error: result?.error || 'Could not send prompt.'
            };
        }

        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            error: error?.message || 'Failed to inject prompt into ChatGPT tab.'
        };
    }
}

async function waitForTabResponse(tabId) {
    const startedAt = Date.now();
    const maxWaitMs = 10 * 60 * 1000;
    let sawGenerating = false;

    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            const job = jobs.get(tabId);

            if (!job || job.isStopped) {
                clearInterval(checkInterval);
                resolve({ ok: false, error: 'Queue was stopped.' });
                return;
            }

            if (job.isPaused || !job.isRunning) {
                clearInterval(checkInterval);
                resolve({ ok: false, error: 'Queue was paused.' });
                return;
            }

            if (Date.now() - startedAt > maxWaitMs) {
                clearInterval(checkInterval);
                resolve({ ok: false, error: 'Timed out waiting for ChatGPT response.' });
                return;
            }

            chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const stopButton =
                        document.querySelector('button[data-testid="stop-button"]') ||
                        document.querySelector('[aria-label="Stop generating"]') ||
                        document.querySelector('button[aria-label="Stop streaming"]');

                    const resultStreaming =
                        document.querySelector('.result-streaming') ||
                        document.querySelector('[data-testid*="conversation-turn"] .result-streaming');

                    const pageText = document.body ? document.body.innerText.toLowerCase() : '';

                    const hasKnownError =
                        pageText.includes('something went wrong') ||
                        pageText.includes('there was an error') ||
                        pageText.includes('error generating a response') ||
                        pageText.includes('network error') ||
                        pageText.includes('failed to generate') ||
                        pageText.includes('try again later');

                    const hasTryAgainButton =
                        Array.from(document.querySelectorAll('button')).some(btn => {
                            const text = (btn.innerText || btn.getAttribute('aria-label') || '').toLowerCase().trim();
                            return text === 'retry' || text === 'try again';
                        });

                    return {
                        generating: !!(stopButton || resultStreaming),
                        hasError: !!hasKnownError,
                        hasTryAgainButton: !!hasTryAgainButton
                    };
                }
            }, (results) => {
                if (chrome.runtime.lastError) {
                    clearInterval(checkInterval);
                    resolve({
                        ok: false,
                        error: chrome.runtime.lastError.message || 'Could not read ChatGPT tab.'
                    });
                    return;
                }

                const state = results?.[0]?.result || {};

                if (state.hasError || state.hasTryAgainButton) {
                    clearInterval(checkInterval);
                    resolve({
                        ok: false,
                        error: 'ChatGPT showed an error or retry state.'
                    });
                    return;
                }

                if (state.generating) {
                    sawGenerating = true;
                    return;
                }

                if (sawGenerating) {
                    clearInterval(checkInterval);
                    setTimeout(() => {
                        resolve({ ok: true });
                    }, 800);
                    return;
                }

                if (Date.now() - startedAt > 5000) {
                    clearInterval(checkInterval);
                    resolve({ ok: true });
                }
            });
        }, 1000);
    });
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
            startedAt: job.startedAt,
            updatedAt: job.updatedAt
        };
    }

    return snapshot;
}

function getRemainingCount(job) {
    return job.queue.length + (job.currentMessage ? 1 : 0);
}

function getJobStatus(job) {
    if (job.isPaused) return 'paused';
    if (job.isRunning) return 'running';
    if (job.isStopped) return 'stopped';
    return 'idle';
}

function updateRunningJobsStorage() {
    const snapshot = getRunningJobsSnapshot();

    chrome.storage.local.set({
        runningJobs: snapshot,
        isRunning: Object.keys(snapshot).length > 0
    });
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
    } catch (error) {
        // Popup may be closed. Ignore.
    }
}

function isChatGPTUrl(url) {
    return typeof url === 'string' &&
        (url.startsWith('https://chatgpt.com/') || url.startsWith('https://chat.openai.com/'));
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