document.addEventListener('DOMContentLoaded', function () {
    const queueToolTab = document.getElementById('queue-tool-tab');
    const optimizerToolTab = document.getElementById('optimizer-tool-tab');
    const settingsToolTab = document.getElementById('settings-tool-tab');
    const queueToolPanel = document.getElementById('queue-tool-panel');
    const optimizerToolPanel = document.getElementById('optimizer-tool-panel');
    const settingsToolPanel = document.getElementById('settings-tool-panel');

    const messageList = document.getElementById('messages-list');
    const newMessageInput = document.getElementById('new-message');
    const queueMessageInput = document.getElementById('queue-message');
    const addMessageButton = document.getElementById('add-message');
    const sendMessagesButton = document.getElementById('send-messages');
    const enqueueMessageButton = document.getElementById('enqueue-message');
    const stopAutomationButton = document.getElementById('stop-automation');
    const statusIndicator = document.getElementById('status-indicator');
    const clearMessagesButton = document.getElementById('clear-messages');
    const saveSequenceButton = document.getElementById('save-sequence');
    const sequenceDropdown = document.getElementById('sequence-dropdown');
    const makeSequencePanel = document.getElementById('make-sequence-panel');
    const deleteSequenceButton = document.getElementById('delete-sequence');
    const copyPromptButton = document.getElementById('copy-sequence-prompt');
    const importPromptButton = document.getElementById('import-prompt-output');
    const messagesToGoFooter = document.getElementById('messages-to-go-footer');

    const targetTabSelect = document.getElementById('target-tab-select');
    const refreshTargetTabsButton = document.getElementById('refresh-target-tabs');

    const runningInstancesList = document.getElementById('running-instances-list');
    const refreshInstancesButton = document.getElementById('refresh-instances');
    const stopAllInstancesButton = document.getElementById('stop-all-instances');
    const queueLogList = document.getElementById('queue-log-list');
    const refreshQueueLogButton = document.getElementById('refresh-queue-log');
    const copyQueueLogButton = document.getElementById('copy-queue-log');
    const clearQueueLogButton = document.getElementById('clear-queue-log');
    const queueDeepResearchAware = document.getElementById('queue-deep-research-aware');
    const queueUnlimitedRetryWait = document.getElementById('queue-unlimited-retry-wait');

    const optimizerStatus = document.getElementById('optimizer-status');
    const optimizerWindowSize = document.getElementById('optimizer-window-size');
    const optimizerBatchSize = document.getElementById('optimizer-batch-size');
    const optimizerAutoScroll = document.getElementById('optimizer-auto-scroll');
    const optimizerToggle = document.getElementById('optimizer-toggle');
    const optimizerStats = document.getElementById('optimizer-stats');

    if (
        !messageList ||
        !newMessageInput ||
        !queueMessageInput ||
        !addMessageButton ||
        !sendMessagesButton ||
        !enqueueMessageButton ||
        !stopAutomationButton ||
        !statusIndicator ||
        !clearMessagesButton ||
        !saveSequenceButton ||
        !sequenceDropdown ||
        !deleteSequenceButton
    ) {
        return;
    }

    let messages = [];
    let savedSequences = {};
    let optimizerAutoSaveTimer = null;
    let lastOptimizerLogSignature = '';
    let lastOptimizerLogAt = 0;

    const EDIT_SEQUENCE_VALUE = '__edit_selected_sequence__';
    let selectedSequenceName = '';
    let editingSequenceName = '';
    const CHATGPT_URL_PATTERNS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
    const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

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

    function tabsQuery(queryInfo) {
        return extensionApiPromise(
            (done) => chrome.tabs.query(queryInfo, done),
            () => chrome.tabs.query(queryInfo)
        ).then((tabs) => Array.isArray(tabs) ? tabs : []);
    }

    function tabsGet(tabId) {
        return extensionApiPromise(
            (done) => chrome.tabs.get(tabId, done),
            () => chrome.tabs.get(tabId)
        );
    }

    function executeScript(details) {
        return extensionApiPromise(
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
    }

    function insertCSS(details) {
        return extensionApiPromise(
            (done) => {
                if (chrome.scripting && chrome.scripting.insertCSS) {
                    return chrome.scripting.insertCSS(details, done);
                }

                if (chrome.tabs && chrome.tabs.insertCSS) {
                    const tabId = details?.target?.tabId;
                    const legacyDetails = {};

                    if (Array.isArray(details.files) && details.files[0]) {
                        legacyDetails.file = details.files[0];
                    } else {
                        throw new Error('No CSS file was provided.');
                    }

                    return chrome.tabs.insertCSS(tabId, legacyDetails, done);
                }

                throw new Error('CSS injection is not available in this browser.');
            },
            () => {
                if (!chrome.scripting || !chrome.scripting.insertCSS) {
                    throw new Error('CSS injection is not available in this browser.');
                }

                return chrome.scripting.insertCSS(details);
            }
        );
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getTabUrl(tab) {
        return tab?.url || tab?.pendingUrl || '';
    }

    function dedupeTabs(tabs) {
        const byId = new Map();

        (Array.isArray(tabs) ? tabs : []).forEach((tab) => {
            if (tab && tab.id && !byId.has(tab.id)) {
                byId.set(tab.id, tab);
            }
        });

        return Array.from(byId.values());
    }

    async function getActiveTab() {
        const queries = [
            { active: true, currentWindow: true },
            { active: true, lastFocusedWindow: true },
            { active: true }
        ];

        for (const queryInfo of queries) {
            try {
                const tabs = await tabsQuery(queryInfo);

                if (tabs[0]) {
                    return tabs[0];
                }
            } catch {
                // Try the next active-tab query shape.
            }
        }

        return null;
    }

    async function getAllChatGPTTabs() {
        const collected = [];

        try {
            collected.push(...await tabsQuery({ url: CHATGPT_URL_PATTERNS }));
        } catch {
            for (const pattern of CHATGPT_URL_PATTERNS) {
                try {
                    collected.push(...await tabsQuery({ url: pattern }));
                } catch {
                    // Fall back to the unfiltered scan below.
                }
            }
        }

        try {
            const allTabs = await tabsQuery({});
            collected.push(...allTabs.filter(tab => isChatGPTUrl(getTabUrl(tab))));
        } catch {
            // URL-filtered tab queries above are enough when all-tabs scanning is unavailable.
        }

        return dedupeTabs(collected)
            .filter(tab => isChatGPTUrl(getTabUrl(tab)))
            .toSorted((a, b) => {
                if (!!a.active !== !!b.active) {
                    return a.active ? -1 : 1;
                }

                return cleanTabTitle(a.title || '').localeCompare(cleanTabTitle(b.title || ''));
            });
    }

    chrome.storage.local.get(['messages', 'sequences'], function (data) {
        if (Array.isArray(data.messages)) {
            messages = data.messages;
        }

        if (data.sequences && typeof data.sequences === 'object' && !Array.isArray(data.sequences)) {
            savedSequences = data.sequences;
        }

        updateSequenceDropdown(false);
        updateMessagesList();
        refreshTargetTabs();
        refreshRunningJobsStatus();
        refreshQueueLog();
    });

    loadOptimizerSettings();
    loadQueueSettings();

    if (optimizerWindowSize) {
        optimizerWindowSize.addEventListener('input', scheduleOptimizerAutoSave);
        optimizerWindowSize.addEventListener('change', scheduleOptimizerAutoSave);
    }

    if (optimizerBatchSize) {
        optimizerBatchSize.addEventListener('input', scheduleOptimizerAutoSave);
        optimizerBatchSize.addEventListener('change', scheduleOptimizerAutoSave);
    }

    if (optimizerAutoScroll) {
        optimizerAutoScroll.addEventListener('change', scheduleOptimizerAutoSave);
    }

    if (queueDeepResearchAware) {
        queueDeepResearchAware.addEventListener('change', saveQueueSettings);
    }

    if (queueUnlimitedRetryWait) {
        queueUnlimitedRetryWait.addEventListener('change', saveQueueSettings);
    }

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'automationFinished') {
            refreshRunningJobsStatus();
            refreshQueueLog();
            showTempStatus(`Automation finished${request.tabId ? ` on tab ${request.tabId}` : ''}.`);
        }

        if (request.action === 'automationPaused') {
            refreshRunningJobsStatus();
            refreshQueueLog();
            showTempStatus(`Queue paused: ${request.error || 'ChatGPT failed.'}`);
        }

        if (request.action === 'queueDebugLogUpdated') {
            refreshQueueLog();
        }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;

        if (changes.runningJobs || changes.isRunning) {
            refreshRunningJobsStatus();
        }

        if (changes.queueDebugLogs) {
            renderQueueLog(Array.isArray(changes.queueDebugLogs.newValue) ? changes.queueDebugLogs.newValue : []);
        }
    });

    if (
        queueToolTab &&
        optimizerToolTab &&
        settingsToolTab &&
        queueToolPanel &&
        optimizerToolPanel &&
        settingsToolPanel
    ) {
        queueToolTab.addEventListener('click', function () {
            activateToolPanel(queueToolTab, queueToolPanel);
        });

        optimizerToolTab.addEventListener('click', async function () {
            activateToolPanel(optimizerToolTab, optimizerToolPanel);
            await refreshOptimizerStatus();
        });

        settingsToolTab.addEventListener('click', function () {
            activateToolPanel(settingsToolTab, settingsToolPanel);
            refreshQueueLog();
        });
    }

    function activateToolPanel(activeTab, activePanel) {
        [queueToolTab, optimizerToolTab, settingsToolTab].forEach((tab) => {
            if (tab) {
                tab.classList.toggle('active', tab === activeTab);
            }
        });

        [queueToolPanel, optimizerToolPanel, settingsToolPanel].forEach((panel) => {
            if (panel) {
                panel.classList.toggle('active', panel === activePanel);
            }
        });
    }

    async function refreshTargetTabs() {
        if (!targetTabSelect) return;

        const previousValue = targetTabSelect.value || 'current';

        targetTabSelect.textContent = '';

        const currentOption = document.createElement('option');
        currentOption.value = 'current';
        currentOption.textContent = 'Current ChatGPT tab';
        targetTabSelect.appendChild(currentOption);

        const activeTab = await getActiveTab();
        const chatgptTabs = await getAllChatGPTTabs();

        chatgptTabs.forEach(tab => {
            if (!tab.id) return;

            const option = document.createElement('option');
            option.value = String(tab.id);
            option.textContent = cleanTabTitle(tab.title || 'ChatGPT');
            targetTabSelect.appendChild(option);
        });

        const optionValues = Array.from(targetTabSelect.options).map(opt => opt.value);

        if (previousValue !== 'current' && optionValues.includes(previousValue)) {
            targetTabSelect.value = previousValue;
            return;
        }

        if (activeTab && isChatGPTUrl(getTabUrl(activeTab))) {
            targetTabSelect.value = 'current';
            return;
        }

        if (chatgptTabs.length > 0 && chatgptTabs[0].id) {
            targetTabSelect.value = String(chatgptTabs[0].id);
            return;
        }

        targetTabSelect.value = 'current';
    }

    function cleanTabTitle(title) {
        return String(title || 'ChatGPT')
            .replace(/^ChatGPT\s*[-–]\s*/i, '')
            .replace(/\s*[-–]\s*ChatGPT$/i, '')
            .trim() || 'ChatGPT';
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

    if (refreshTargetTabsButton) {
        refreshTargetTabsButton.addEventListener('click', async function () {
            await refreshTargetTabs();
            await refreshRunningJobsStatus();

            if (optimizerToolPanel && optimizerToolPanel.classList.contains('active')) {
                await refreshOptimizerStatus();
            }
        });
    }

    async function getSelectedTargetTab() {
        let tab = null;

        if (targetTabSelect && targetTabSelect.value && targetTabSelect.value !== 'current') {
            const selectedTabId = Number(targetTabSelect.value);

            try {
                tab = await tabsGet(selectedTabId);
            } catch {
                alert('Selected ChatGPT tab no longer exists. Refresh the tab list.');
                await refreshTargetTabs();
                return null;
            }
        } else {
            tab = await getActiveTab();

            if (!tab || !isChatGPTUrl(getTabUrl(tab))) {
                const chatgptTabs = await getAllChatGPTTabs();

                if (chatgptTabs.length === 0) {
                    alert('No ChatGPT tab is open. Open chatgpt.com, then try again.');
                    return null;
                }

                tab = chatgptTabs[0];

                if (targetTabSelect && tab.id) {
                    await refreshTargetTabs();
                    targetTabSelect.value = String(tab.id);
                }
            }
        }

        if (!tab || !tab.id) {
            alert('Could not find the selected tab.');
            return null;
        }

        if (!isChatGPTUrl(getTabUrl(tab))) {
            alert('Select a ChatGPT tab before starting or adding to the queue.');
            return null;
        }

        return tab;
    }

    async function getOptimizerTargetTab() {
        let tab = null;

        if (targetTabSelect && targetTabSelect.value && targetTabSelect.value !== 'current') {
            try {
                tab = await tabsGet(Number(targetTabSelect.value));
            } catch {
                return null;
            }
        } else {
            tab = await getActiveTab();

            if (!tab || !isChatGPTUrl(getTabUrl(tab))) {
                const chatgptTabs = await getAllChatGPTTabs();
                tab = chatgptTabs[0] || null;
            }
        }

        if (!tab || !tab.id || !isChatGPTUrl(getTabUrl(tab))) {
            return null;
        }

        return tab;
    }

    function getRunningJobs() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'getRunningJobs' }, function (response) {
                if (chrome.runtime.lastError) {
                    resolve({});
                    return;
                }

                resolve(response?.jobs || {});
            });
        });
    }

    function getVariablesFromTextList(textList) {
        const regex = /{{(.*?)}}/g;
        const vars = new Set();

        textList.forEach(text => {
            let match;
            regex.lastIndex = 0;

            while ((match = regex.exec(text)) !== null) {
                if (match[1].trim()) {
                    vars.add(match[1].trim());
                }
            }
        });

        return Array.from(vars);
    }

    function resolveVariablesForTextList(textList) {
        const uniqueVars = getVariablesFromTextList(textList);
        let resolved = [...textList];

        if (uniqueVars.length === 0) {
            return resolved;
        }

        const values = {};

        for (const v of uniqueVars) {
            const input = prompt(`Enter value for {{${v}}}:`);
            if (input === null) return null;
            values[v] = input;
        }

        resolved = resolved.map(text => {
            let temp = text;

            for (const [k, v] of Object.entries(values)) {
                temp = temp.split(`{{${k}}}`).join(v);
            }

            return temp;
        });

        return resolved;
    }

    function refreshVarDropdown() {
        // Variable dropdown removed.
        // Placeholder support still works for manually typed or imported {{variables}}.
    }

    newMessageInput.addEventListener('input', refreshVarDropdown);
    queueMessageInput.addEventListener('input', refreshVarDropdown);

    sendMessagesButton.addEventListener('click', async function () {
        const tab = await getSelectedTargetTab();
        if (!tab) return;

        const runningJobs = await getRunningJobs();
        const selectedJob = runningJobs[String(tab.id)];

        if (selectedJob) {
            chrome.runtime.sendMessage({
                action: 'stopSequence',
                tabId: tab.id
            }, function (response) {
                if (chrome.runtime.lastError) {
                    alert(chrome.runtime.lastError.message || 'Could not stop sequence.');
                    return;
                }

                if (response && response.ok) {
                    showTempStatus(`Stopped sequence on "${cleanTabTitle(tab.title)}".`);
                    refreshRunningJobsStatus();
                } else {
                    alert(response?.error || 'Could not stop sequence.');
                }
            });

            return;
        }

        if (messages.length === 0) {
            alert('No sequence messages to send. Open "Make a sequence" and add messages first.');
            return;
        }

        const resolvedMessages = resolveVariablesForTextList(messages);
        if (!resolvedMessages) return;

        chrome.runtime.sendMessage({
            action: 'startSequence',
            messages: resolvedMessages,
            tabId: tab.id
        }, function (response) {
            if (chrome.runtime.lastError) {
                alert(chrome.runtime.lastError.message || 'Could not start sequence.');
                return;
            }

            if (response && response.ok) {
                showTempStatus(`Started sequence on "${cleanTabTitle(tab.title)}".`);
                refreshRunningJobsStatus();
            } else {
                alert(response?.error || 'Could not start sequence.');
            }
        });
    });

    enqueueMessageButton.addEventListener('click', async function () {
        const rawMessage = queueMessageInput.value.trim();

        if (!rawMessage) {
            alert('Type a message in the "Send message next" box.');
            return;
        }

        const tab = await getSelectedTargetTab();
        if (!tab) return;

        const resolvedList = resolveVariablesForTextList([rawMessage]);
        if (!resolvedList) return;

        const resolvedMessage = resolvedList[0];

        chrome.runtime.sendMessage({
            action: 'enqueueMessage',
            tabId: tab.id,
            message: resolvedMessage
        }, function (response) {
            if (chrome.runtime.lastError) {
                alert(chrome.runtime.lastError.message || 'Could not add message to queue.');
                return;
            }

            if (response && response.ok) {
                queueMessageInput.value = '';
                refreshVarDropdown();
                refreshRunningJobsStatus();

                if (response.started) {
                    showTempStatus(`Sent message on "${cleanTabTitle(tab.title)}".`);
                } else if (response.paused) {
                    showTempStatus(`Added message to paused queue for "${cleanTabTitle(tab.title)}".`);
                } else {
                    showTempStatus(`Message will send next on "${cleanTabTitle(tab.title)}".`);
                }
            } else {
                alert(response?.error || 'Could not add message to queue.');
            }
        });
    });

    stopAutomationButton.addEventListener('click', async function () {
        const tab = await getSelectedTargetTab();

        chrome.runtime.sendMessage({ action: 'getRunningJobs' }, function (response) {
            if (chrome.runtime.lastError) {
                alert(chrome.runtime.lastError.message || 'Could not read running jobs.');
                return;
            }

            const runningJobs = response?.jobs || {};
            const selectedTabId = tab?.id ? String(tab.id) : '';
            const hasSelectedTabJob = selectedTabId && runningJobs[selectedTabId];

            if (hasSelectedTabJob) {
                chrome.runtime.sendMessage({
                    action: 'stopSequence',
                    tabId: tab.id
                }, function () {
                    showTempStatus(`Stop requested for "${cleanTabTitle(tab.title)}".`);
                    refreshRunningJobsStatus();
                });

                return;
            }

            chrome.runtime.sendMessage({ action: 'stopAllSequences' }, function () {
                showTempStatus('Stop requested for all running queues.');
                refreshRunningJobsStatus();
            });
        });
    });

    if (refreshInstancesButton) {
        refreshInstancesButton.addEventListener('click', refreshRunningJobsStatus);
    }

    if (stopAllInstancesButton) {
        stopAllInstancesButton.addEventListener('click', function () {
            chrome.runtime.sendMessage({ action: 'stopAllSequences' }, function () {
                showTempStatus('Stop requested for all running queues.');
                refreshRunningJobsStatus();
            });
        });
    }

    if (refreshQueueLogButton) {
        refreshQueueLogButton.addEventListener('click', refreshQueueLog);
    }

    if (copyQueueLogButton) {
        copyQueueLogButton.addEventListener('click', async function () {
            try {
                const logs = await getQueueLogEntries();
                const text = logs.length > 0 ? formatQueueLogForCopy(logs) : 'No automation logs yet.';

                await copyTextToClipboard(text);
                showTempStatus('Queue log copied.');
            } catch {
                alert('Could not copy queue log.');
            }
        });
    }

    if (clearQueueLogButton) {
        clearQueueLogButton.addEventListener('click', function () {
            chrome.runtime.sendMessage({ action: 'clearQueueDebugLogs' }, function (response) {
                if (chrome.runtime.lastError) {
                    alert(chrome.runtime.lastError.message || 'Could not clear queue log.');
                    return;
                }

                if (!response || !response.ok) {
                    alert(response?.error || 'Could not clear queue log.');
                    return;
                }

                renderQueueLog([]);
                showTempStatus('Queue log cleared.');
            });
        });
    }

    addMessageButton.addEventListener('click', function () {
        const message = newMessageInput.value.trim();

        if (message) {
            messages.push(message);
            newMessageInput.value = '';
            saveMessages();
            updateMessagesList();
            refreshVarDropdown();
        }
    });

    function updateMessagesList() {
        messageList.textContent = '';

        messages.forEach((msg, index) => {
            const div = document.createElement('div');
            div.className = 'message-item';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'space-between';
            div.style.gap = '6px';
            div.style.marginBottom = '6px';

            const text = document.createElement('span');
            text.textContent = `${index + 1}: ${msg}`;
            text.style.flex = '1';
            text.style.overflowWrap = 'anywhere';

            const controls = document.createElement('div');
            controls.style.display = 'flex';
            controls.style.gap = '4px';

            const editButton = document.createElement('button');
            editButton.textContent = 'Edit';
            editButton.style.width = 'auto';
            editButton.style.padding = '4px 6px';
            editButton.style.fontSize = '10px';

            editButton.addEventListener('click', function () {
                const updated = prompt('Edit message:', msg);

                if (updated === null) return;

                if (!updated.trim()) {
                    alert('Message cannot be empty.');
                    return;
                }

                messages[index] = updated.trim();
                saveMessages();
                updateMessagesList();
            });

            const removeButton = document.createElement('button');
            removeButton.textContent = '×';
            removeButton.style.width = 'auto';
            removeButton.style.padding = '4px 7px';
            removeButton.style.fontSize = '12px';
            removeButton.style.background = 'var(--danger)';
            removeButton.style.color = '#ffffff';

            removeButton.addEventListener('click', function () {
                messages.splice(index, 1);
                saveMessages();
                updateMessagesList();
            });

            controls.appendChild(editButton);
            controls.appendChild(removeButton);

            div.appendChild(text);
            div.appendChild(controls);
            messageList.appendChild(div);
        });
    }

    function setSequenceEditMode(sequenceName) {
        editingSequenceName = sequenceName || '';

        if (editingSequenceName) {
            saveSequenceButton.textContent = 'Save Changes';

            if (makeSequencePanel) {
                makeSequencePanel.open = true;
            }
        } else {
            saveSequenceButton.textContent = 'Save Sequence';
        }
    }

    function updateSequenceDropdown(shouldLoadFirstSequence = true, newSeqName) {
        const names = Object.keys(savedSequences);

        sequenceDropdown.textContent = '';

        if (names.length === 0) {
            const opt = document.createElement('option');
            opt.disabled = true;
            opt.selected = true;
            opt.textContent = 'Save a sequence first';
            sequenceDropdown.appendChild(opt);

            selectedSequenceName = '';
            setSequenceEditMode('');
            return;
        }

        names.forEach(seq => {
            const opt = document.createElement('option');
            opt.value = seq;
            opt.textContent = seq;
            sequenceDropdown.appendChild(opt);
        });

        const separator = document.createElement('option');
        separator.disabled = true;
        separator.textContent = '────────────';
        sequenceDropdown.appendChild(separator);

        const editOpt = document.createElement('option');
        editOpt.value = EDIT_SEQUENCE_VALUE;
        editOpt.textContent = 'Edit selected sequence...';
        sequenceDropdown.appendChild(editOpt);

        if (newSeqName && savedSequences[newSeqName]) {
            selectedSequenceName = newSeqName;
            sequenceDropdown.value = newSeqName;
            messages = [...savedSequences[newSeqName]];
            saveMessages();
            updateMessagesList();
            setSequenceEditMode('');
            return;
        }

        if (shouldLoadFirstSequence) {
            selectedSequenceName = names[0];
            sequenceDropdown.value = names[0];
            messages = [...savedSequences[names[0]]];
            saveMessages();
            updateMessagesList();
            setSequenceEditMode('');
            return;
        }

        const keepName =
            selectedSequenceName && savedSequences[selectedSequenceName]
                ? selectedSequenceName
                : names[0];

        selectedSequenceName = keepName;
        sequenceDropdown.value = keepName;
    }

    clearMessagesButton.addEventListener('click', function () {
        messages = [];
        saveMessages();
        updateMessagesList();
        refreshVarDropdown();
    });

    saveSequenceButton.addEventListener('click', function () {
        if (editingSequenceName && savedSequences[editingSequenceName]) {
            const editedName = editingSequenceName;

            savedSequences[editedName] = [...messages];

            chrome.storage.local.set({ sequences: savedSequences }, () => {
                selectedSequenceName = editedName;
                setSequenceEditMode('');
                updateSequenceDropdown(false, editedName);
            });

            return;
        }

        const name = prompt('Enter a name for this sequence:');

        if (name && name.trim()) {
            const cleanName = name.trim();

            savedSequences[cleanName] = [...messages];

            chrome.storage.local.set({ sequences: savedSequences }, () => {
                selectedSequenceName = cleanName;
                setSequenceEditMode('');
                updateSequenceDropdown(true, cleanName);
            });
        }
    });

    sequenceDropdown.addEventListener('change', function () {
        const selectedValue = this.value;

        if (selectedValue === EDIT_SEQUENCE_VALUE) {
            const targetName =
                selectedSequenceName && savedSequences[selectedSequenceName]
                    ? selectedSequenceName
                    : Object.keys(savedSequences)[0];

            if (!targetName || !savedSequences[targetName]) {
                return;
            }

            selectedSequenceName = targetName;
            sequenceDropdown.value = targetName;

            messages = [...savedSequences[targetName]];
            saveMessages();
            updateMessagesList();
            refreshVarDropdown();
            setSequenceEditMode(targetName);

            if (newMessageInput) {
                newMessageInput.focus();
            }

            return;
        }

        if (selectedValue && savedSequences[selectedValue]) {
            selectedSequenceName = selectedValue;
            messages = [...savedSequences[selectedValue]];
            saveMessages();
            updateMessagesList();
            refreshVarDropdown();
            setSequenceEditMode('');
        }
    });

    deleteSequenceButton.addEventListener('click', function () {
        const name =
            sequenceDropdown.value === EDIT_SEQUENCE_VALUE
                ? selectedSequenceName
                : sequenceDropdown.value;

        if (name && savedSequences[name]) {
            delete savedSequences[name];

            chrome.storage.local.set({ sequences: savedSequences }, () => {
                messages = [];
                selectedSequenceName = '';
                saveMessages();
                updateMessagesList();
                updateSequenceDropdown(false);
                refreshVarDropdown();
                setSequenceEditMode('');
            });
        }
    });

    function saveMessages() {
        chrome.storage.local.set({ messages: messages });
    }

    function setSendSequenceButtonMode(isStopping) {
        if (isStopping) {
            sendMessagesButton.textContent = 'Stop Sequence';
            sendMessagesButton.style.background = 'var(--danger)';
            sendMessagesButton.style.color = '#ffffff';
        } else {
            sendMessagesButton.textContent = 'Send Sequence';
            sendMessagesButton.style.background = 'var(--accent-2)';
            sendMessagesButton.style.color = 'var(--accent-2-text)';
        }
    }

    function showTempStatus(msg) {
        const prevChildren = Array.from(statusIndicator.childNodes).map(node => node.cloneNode(true));
        const prevDisplay = statusIndicator.style.display;
        const prevBg = statusIndicator.style.background;
        const prevColor = statusIndicator.style.color;

        statusIndicator.textContent = msg;
        statusIndicator.style.display = 'block';
        statusIndicator.style.background = 'var(--status-bg)';
        statusIndicator.style.color = 'var(--status-text)';

        setTimeout(() => {
            statusIndicator.replaceChildren(...prevChildren.map(node => node.cloneNode(true)));
            statusIndicator.style.background = prevBg;
            statusIndicator.style.color = prevColor;
            statusIndicator.style.display = prevDisplay;

            refreshRunningJobsStatus();
        }, 2000);
    }

    function refreshQueueLog() {
        if (!queueLogList) return;

        getQueueLogEntries()
            .then(renderQueueLog)
            .catch(() => {
                renderQueueLog([]);
            });
    }

    function getQueueLogEntries() {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'getQueueDebugLogs' }, function (response) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || 'Could not read queue log.'));
                    return;
                }

                if (!response || !response.ok) {
                    reject(new Error(response?.error || 'Could not read queue log.'));
                    return;
                }

                resolve(Array.isArray(response.logs) ? response.logs : []);
            });
        });
    }

    function logOptimizerEvent(level, message, details = {}, dedupeMs = 30000) {
        const signature = [
            level,
            message,
            details.action || '',
            details.error || '',
            details.tabId || ''
        ].join('|');
        const now = Date.now();

        if (signature === lastOptimizerLogSignature && now - lastOptimizerLogAt < dedupeMs) {
            return;
        }

        lastOptimizerLogSignature = signature;
        lastOptimizerLogAt = now;

        chrome.runtime.sendMessage({
            action: 'logAutomationEvent',
            source: 'optimizer',
            level,
            tabId: details.tabId || '',
            message,
            details
        }, () => {
            void chrome.runtime.lastError;
        });
    }

    function renderQueueLog(logs) {
        if (!queueLogList) return;

        queueLogList.textContent = '';

        const recentLogs = (Array.isArray(logs) ? logs : [])
            .slice(-30)
            .toReversed();

        if (recentLogs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'queue-log-empty';
            empty.textContent = 'No automation logs yet';
            queueLogList.appendChild(empty);
            return;
        }

        recentLogs.forEach((log) => {
            const entry = document.createElement('div');
            const level = ['error', 'warn', 'success', 'info'].includes(log.level) ? log.level : 'info';
            entry.className = `queue-log-entry ${level}`;

            const meta = document.createElement('div');
            meta.className = 'queue-log-meta';
            const source = log.details?.source ? ` | ${String(log.details.source).toUpperCase()}` : '';
            meta.textContent = `${formatLogTime(log.timestamp)} | ${level.toUpperCase()}${source}${log.tabId ? ` | Tab ${log.tabId}` : ''}`;

            const message = document.createElement('div');
            message.className = 'queue-log-message';
            message.textContent = log.message || 'Queue event';

            entry.appendChild(meta);
            entry.appendChild(message);

            const detailsText = formatLogDetails(log.details);

            if (detailsText) {
                const details = document.createElement('div');
                details.className = 'queue-log-details';
                details.textContent = detailsText;
                entry.appendChild(details);
            }

            queueLogList.appendChild(entry);
        });
    }

    function formatQueueLogForCopy(logs) {
        return (Array.isArray(logs) ? logs : [])
            .map((log) => {
                const source = log.details?.source ? ` source=${log.details.source}` : '';
                const parts = [
                    `[${log.timestamp || 'unknown time'}] ${String(log.level || 'info').toUpperCase()}${source}${log.tabId ? ` tab=${log.tabId}` : ''}`,
                    log.message || 'Queue event'
                ];
                const detailsText = formatLogDetails(log.details);

                if (detailsText) {
                    parts.push(detailsText);
                }

                return parts.join('\n');
            })
            .join('\n\n');
    }

    function formatLogTime(timestamp) {
        const date = new Date(timestamp);

        if (Number.isNaN(date.getTime())) {
            return 'Unknown time';
        }

        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function formatLogDetails(details) {
        if (!details || typeof details !== 'object') {
            return '';
        }

        try {
            const text = JSON.stringify(details, null, 2);
            return text.length > 1200 ? `${text.slice(0, 1197)}...` : text;
        } catch {
            return '';
        }
    }

    function updateMessagesToGoFooter(runningJobs) {
        if (!messagesToGoFooter) return;

        const totalRemaining = Object.values(runningJobs || {}).reduce((sum, job) => {
            return sum + Number(job.remaining || 0);
        }, 0);

        messagesToGoFooter.textContent = `${totalRemaining} message${totalRemaining === 1 ? '' : 's'} to go...`;
    }

    async function refreshRunningJobsStatus() {
        chrome.runtime.sendMessage({ action: 'getRunningJobs' }, async function (response) {
            if (chrome.runtime.lastError) {
                stopAutomationButton.style.display = 'none';
                statusIndicator.style.display = 'none';
                setSendSequenceButtonMode(false);
                updateMessagesToGoFooter({});
                await renderRunningInstances({});
                return;
            }

            const runningJobs = response?.jobs || {};
            const runningCount = Object.keys(runningJobs).length;

            updateMessagesToGoFooter(runningJobs);
            await renderRunningInstances(runningJobs);

            if (runningCount === 0) {
                stopAutomationButton.style.display = 'none';
                statusIndicator.style.display = 'none';
                setStatusIndicatorContent('Automation running...');
                setSendSequenceButtonMode(false);
                return;
            }

            const selectedTabId = await getSelectedTabIdForStatus();
            const selectedTabJob = selectedTabId ? runningJobs[selectedTabId] : null;

            stopAutomationButton.style.display = 'none';

            if (selectedTabJob) {
                setSendSequenceButtonMode(true);

                if (selectedTabJob.isPaused) {
                    setStatusIndicatorContent(`Paused. Remaining: ${selectedTabJob.remaining}`);
                    statusIndicator.style.background = 'var(--disabled-bg)';
                    statusIndicator.style.color = 'var(--disabled-text)';
                } else {
                    setStatusIndicatorContent(`Running. Remaining: ${selectedTabJob.remaining}`);
                    statusIndicator.style.background = 'var(--status-bg)';
                    statusIndicator.style.color = 'var(--status-text)';
                }
            } else {
                setSendSequenceButtonMode(false);
                setStatusIndicatorContent(`Running on ${runningCount} tab${runningCount === 1 ? '' : 's'}`);
                statusIndicator.style.background = 'var(--status-bg)';
                statusIndicator.style.color = 'var(--status-text)';
            }

            statusIndicator.style.display = 'block';
        });
    }

    function setStatusIndicatorContent(text) {
        statusIndicator.replaceChildren();
        statusIndicator.appendChild(document.createTextNode(text || ''));
    }

    async function getSelectedTabIdForStatus() {
        if (targetTabSelect && targetTabSelect.value && targetTabSelect.value !== 'current') {
            return targetTabSelect.value;
        }

        try {
            const tab = await getActiveTab();
            return tab?.id ? String(tab.id) : '';
        } catch {
            return '';
        }
    }

    async function getTabTitleMap() {
        const titleMap = {};

        try {
            const tabs = await getAllChatGPTTabs();

            tabs.forEach(tab => {
                if (tab.id) {
                    titleMap[String(tab.id)] = cleanTabTitle(tab.title || 'ChatGPT');
                }
            });
        } catch {
            // Ignore title lookup errors.
        }

        return titleMap;
    }

    async function renderRunningInstances(runningJobs) {
        if (!runningInstancesList) return;

        const entries = Object.entries(runningJobs || {});
        const titleMap = await getTabTitleMap();

        runningInstancesList.textContent = '';

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'instance-empty';
            empty.textContent = 'No running instances';
            runningInstancesList.appendChild(empty);

            if (stopAllInstancesButton) {
                stopAllInstancesButton.style.display = 'none';
            }

            return;
        }

        entries.forEach(([tabId, job]) => {
            const row = document.createElement('div');
            row.className = 'instance-row';

            const info = document.createElement('div');
            info.className = 'instance-info';

            const tabTitle = titleMap[tabId] || 'ChatGPT';
            const status = job.isPaused ? 'Paused' : 'Running';
            const totalMessages = Number(job.totalMessages || 0);
            const completedCount = Number(job.completedCount || 0);
            const progress = totalMessages > 0 ? ` | Done: ${completedCount}/${totalMessages}` : '';
            const nextPreview = job.nextMessagePreview ? ` | Next: ${job.nextMessagePreview}` : '';
            const errorPreview = job.lastError ? ` | Error: ${job.lastError}` : '';

            info.textContent = `${tabTitle} | ${status}${progress} | Remaining: ${job.remaining}${nextPreview}${errorPreview}`;

            const controls = document.createElement('div');
            controls.style.display = 'flex';
            controls.style.gap = '4px';
            controls.style.alignItems = 'center';

            if (job.isPaused) {
                const retryButton = document.createElement('button');
                retryButton.className = 'instance-stop-btn';
                retryButton.textContent = 'Retry';
                retryButton.style.background = 'var(--accent-2)';
                retryButton.style.color = 'var(--accent-2-text)';

                retryButton.addEventListener('click', function () {
                    chrome.runtime.sendMessage({
                        action: 'retryPausedJob',
                        tabId: Number(tabId)
                    }, function (response) {
                        if (response && response.ok) {
                            showTempStatus(`Retry requested for "${tabTitle}".`);
                        } else {
                            alert(response?.error || 'Could not retry paused queue.');
                        }

                        refreshRunningJobsStatus();
                    });
                });

                controls.appendChild(retryButton);
            }

            const stopButton = document.createElement('button');
            stopButton.className = 'instance-stop-btn';
            stopButton.textContent = 'Stop';

            stopButton.addEventListener('click', function () {
                chrome.runtime.sendMessage({
                    action: 'stopSequence',
                    tabId: Number(tabId)
                }, function () {
                    showTempStatus(`Stop requested for "${tabTitle}".`);
                    refreshRunningJobsStatus();
                });
            });

            controls.appendChild(stopButton);

            row.appendChild(info);
            row.appendChild(controls);
            runningInstancesList.appendChild(row);
        });

        if (stopAllInstancesButton) {
            stopAllInstancesButton.style.display = 'block';
        }
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();

        const copied = document.execCommand('copy');
        ta.remove();

        if (!copied) {
            throw new Error('Copy failed');
        }
    }

    async function readTextFromClipboard() {
        if (navigator.clipboard && navigator.clipboard.readText) {
            return await navigator.clipboard.readText();
        }

        return '';
    }

    if (copyPromptButton) {
        copyPromptButton.addEventListener('click', async function () {
            const promptText =
`Create a message sequence for a ChatGPT automation extension.

Return only a valid JSON object inside one plain text code block.
Do not include explanations before or after the code block.
Do not include markdown except the single code block.
Use {{variable_name}} when the sequence needs a placeholder the user can fill in later.

The JSON object must use this exact shape:
{
  "name": "Short sequence name",
  "messages": ["First message", "Second message", "Third message"]
}

Example output:
\`\`\`text
{
  "name": "Chapter editing",
  "messages": ["Do chapter 1.", "Do chapter 2.", "Do chapter 3."]
}
\`\`\`

The sequence should do the following: `;

            try {
                await copyTextToClipboard(promptText);
                showTempStatus('Prompt copied to clipboard.');
            } catch {
                alert('Copy failed. Please try again.');
            }
        });
    }

    function cleanImportedText(text) {
        let cleaned = String(text || '').trim();

        cleaned = cleaned.replace(/^```(?:json|text|js|javascript)?\s*/i, '');
        cleaned = cleaned.replace(/\s*```$/i, '');

        return cleaned.trim();
    }

    function parseImportedSequence(rawText) {
        const text = cleanImportedText(rawText);

        if (!text) return null;

        try {
            const parsed = JSON.parse(text);

            if (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed) &&
                typeof parsed.name === 'string' &&
                Array.isArray(parsed.messages) &&
                parsed.messages.every(item => typeof item === 'string')
            ) {
                return {
                    name: parsed.name.trim() || 'Imported sequence',
                    messages: parsed.messages.map(item => item.trim()).filter(Boolean)
                };
            }

            if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
                return {
                    name: '',
                    messages: parsed.map(item => item.trim()).filter(Boolean)
                };
            }

            if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object')) {
                const importedMessages = parsed
                    .map(item => item.message || item.text || item.prompt || '')
                    .map(item => String(item).trim())
                    .filter(Boolean);

                return {
                    name: '',
                    messages: importedMessages
                };
            }
        } catch {
            // Fall back to line parsing below.
        }

        const lines = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => line.replace(/^[-*•\d.)\s]+/, '').trim())
            .filter(Boolean);

        if (lines.length === 0) return null;

        return {
            name: '',
            messages: lines
        };
    }

    function getUniqueSequenceName(baseName) {
        const cleanBaseName = String(baseName || '').trim() || 'Imported sequence';

        if (!savedSequences[cleanBaseName]) {
            return cleanBaseName;
        }

        let counter = 2;
        let candidate = `${cleanBaseName} ${counter}`;

        while (savedSequences[candidate]) {
            counter++;
            candidate = `${cleanBaseName} ${counter}`;
        }

        return candidate;
    }

    if (importPromptButton) {
        importPromptButton.addEventListener('click', async function () {
            let importedText = '';

            try {
                importedText = await readTextFromClipboard();
            } catch {
                importedText = '';
            }

            if (!importedText || !importedText.trim()) {
                importedText = prompt('Clipboard was empty or unavailable. Paste ChatGPT output here:');

                if (importedText === null) return;
            }

            const importedSequence = parseImportedSequence(importedText);

            if (!importedSequence || importedSequence.messages.length === 0) {
                alert('Import failed. Clipboard must contain a JSON object with name/messages, a JSON array of strings, or one message per line.');
                return;
            }

            let sequenceName = importedSequence.name;

            if (!sequenceName) {
                sequenceName = prompt('Enter a name for this imported sequence:', 'Imported sequence');

                if (sequenceName === null) return;
            }

            const finalName = getUniqueSequenceName(sequenceName);

            messages = importedSequence.messages;
            savedSequences[finalName] = [...messages];

            chrome.storage.local.set(
                {
                    messages: messages,
                    sequences: savedSequences
                },
                () => {
                    updateSequenceDropdown(true, finalName);
                    updateMessagesList();
                    refreshVarDropdown();
                    showTempStatus(`Imported "${finalName}" as a saved sequence.`);
                }
            );
        });
    }

    function loadQueueSettings() {
        if (!queueDeepResearchAware || !queueUnlimitedRetryWait) {
            return;
        }

        chrome.storage.sync.get(
            {
                queueDeepResearchAware: true,
                queueUnlimitedRetryWait: false
            },
            function (config) {
                queueDeepResearchAware.checked = config.queueDeepResearchAware !== false;
                queueUnlimitedRetryWait.checked = config.queueUnlimitedRetryWait === true;
            }
        );
    }

    async function saveQueueSettings() {
        if (!queueDeepResearchAware || !queueUnlimitedRetryWait) {
            return;
        }

        await setSyncStorage({
            queueDeepResearchAware: queueDeepResearchAware.checked,
            queueUnlimitedRetryWait: queueUnlimitedRetryWait.checked
        });

        showTempStatus('Queue settings saved.');
    }

    async function loadOptimizerSettings() {
        if (
            !optimizerStatus ||
            !optimizerWindowSize ||
            !optimizerBatchSize ||
            !optimizerAutoScroll ||
            !optimizerToggle ||
            !optimizerStats
        ) {
            return;
        }

        chrome.storage.sync.get(
            {
                enabled: true,
                windowSize: 50,
                batchSize: 25,
                autoScroll: true
            },
            async function (config) {
                optimizerWindowSize.value = config.windowSize;
                optimizerBatchSize.value = config.batchSize;
                optimizerAutoScroll.checked = config.autoScroll;

                await refreshOptimizerStatus();
            }
        );
    }

    function setOptimizerStatus(text, stateClass) {
        if (!optimizerStatus) return;

        optimizerStatus.textContent = text;
        optimizerStatus.className = 'optimizer-status';

        if (stateClass) {
            optimizerStatus.classList.add(stateClass);
        }
    }

    function setSyncStorage(items) {
        return new Promise((resolve) => {
            chrome.storage.sync.set(items, resolve);
        });
    }

    async function scheduleOptimizerAutoSave() {
        clearTimeout(optimizerAutoSaveTimer);

        optimizerAutoSaveTimer = setTimeout(async function () {
            if (!optimizerWindowSize || !optimizerBatchSize || !optimizerAutoScroll) return;

            const newConfig = {
                windowSize: parseInt(optimizerWindowSize.value, 10),
                batchSize: parseInt(optimizerBatchSize.value, 10),
                autoScroll: optimizerAutoScroll.checked
            };

            if (!Number.isFinite(newConfig.windowSize)) {
                newConfig.windowSize = 50;
            }

            if (!Number.isFinite(newConfig.batchSize)) {
                newConfig.batchSize = 25;
            }

            await setSyncStorage(newConfig);

            const tab = await getOptimizerTargetTab();

            if (!tab) {
                setOptimizerStatus('Settings saved. No ChatGPT tab selected/open.', 'disabled');
                logOptimizerEvent('warn', 'Optimizer settings saved, but no ChatGPT tab is selected or open.', {
                    action: 'UPDATE_CONFIG',
                    config: newConfig
                });
                return;
            }

            try {
                await ensureOptimizerContentScript(tab.id);

                await sendOptimizerMessage(tab.id, {
                    type: 'UPDATE_CONFIG',
                    config: newConfig
                });

                await refreshOptimizerStatus();
            } catch (error) {
                setOptimizerStatus('Settings saved. Optimizer not loaded on selected tab.', 'disabled');
                logOptimizerEvent('error', 'Optimizer config update failed.', {
                    action: 'UPDATE_CONFIG',
                    tabId: tab.id,
                    tabTitle: cleanTabTitle(tab.title),
                    tabUrl: tab.url || '',
                    error: error.message || String(error),
                    config: newConfig
                });
            }
        }, 500);
    }

    async function sendOptimizerMessage(tabId, message) {
        return extensionApiPromise(
            (done) => chrome.tabs.sendMessage(tabId, message, done),
            () => chrome.tabs.sendMessage(tabId, message)
        );
    }

    async function ensureOptimizerContentScript(tabId) {
        try {
            return await sendOptimizerMessage(tabId, { type: 'GET_STATUS' });
        } catch {
            try {
                await insertCSS({
                    target: { tabId },
                    files: ['styles.css']
                }).catch(() => {});

                await executeScript({
                    target: { tabId },
                    files: ['content.js']
                });

                await sleep(250);
            } catch (injectError) {
                throw new Error(`Could not inject optimizer into this ChatGPT tab: ${injectError.message || String(injectError)}`, { cause: injectError });
            }
        }

        try {
            return await sendOptimizerMessage(tabId, { type: 'GET_STATUS' });
        } catch (error) {
            throw new Error(`Optimizer is still unavailable after injection: ${error.message || String(error)}`, { cause: error });
        }
    }

    async function refreshOptimizerStatus() {
        if (
            !optimizerStatus ||
            !optimizerToggle ||
            !optimizerStats
        ) {
            return;
        }

        const tab = await getOptimizerTargetTab();

        if (!tab) {
            setOptimizerStatus('No ChatGPT tab selected/open', 'disabled');
            optimizerToggle.textContent = 'Enable';
            optimizerStats.style.display = 'none';
            logOptimizerEvent('warn', 'Optimizer status check skipped because no ChatGPT tab is selected or open.', {
                action: 'GET_STATUS'
            });
            return;
        }

        try {
            const response = await ensureOptimizerContentScript(tab.id);

            if (response && response.enabled) {
                setOptimizerStatus('Optimizer Active', 'enabled');
                optimizerToggle.textContent = 'Disable';

                renderOptimizerStats(tab, response);

                optimizerStats.style.display = 'block';
            } else {
                setOptimizerStatus('Optimizer Disabled', 'disabled');
                optimizerToggle.textContent = 'Enable';
                optimizerStats.style.display = 'none';
            }
        } catch (error) {
            setOptimizerStatus(`Optimizer not loaded: ${error.message}`, 'disabled');
            optimizerToggle.textContent = 'Enable';
            optimizerStats.style.display = 'none';
            logOptimizerEvent('error', `Optimizer not loaded: ${error.message}`, {
                action: 'GET_STATUS',
                tabId: tab.id,
                tabTitle: cleanTabTitle(tab.title),
                tabUrl: tab.url || '',
                error: error.message || String(error)
            });
        }
    }

    function renderOptimizerStats(tab, response) {
        optimizerStats.replaceChildren();

        const label = document.createElement('strong');
        label.textContent = 'Stats:';

        const lines = [
            `Target: ${cleanTabTitle(tab.title)}`,
            `Total messages: ${response.messageCount}`,
            `Hidden: ${response.hiddenCount}`,
            `Visible: ${response.visibleCount}`,
            `Container: ${response.debugInfo?.containerFound ? 'Found' : 'Missing'}`,
            `Initialized: ${response.debugInfo?.initialized ? 'Yes' : 'No'}`
        ];

        optimizerStats.appendChild(label);

        lines.forEach((line) => {
            optimizerStats.appendChild(document.createElement('br'));
            optimizerStats.appendChild(document.createTextNode(line));
        });
    }

    if (optimizerToggle) {
        optimizerToggle.addEventListener('click', async function () {
            const tab = await getOptimizerTargetTab();

            if (!tab) {
                setOptimizerStatus('No ChatGPT tab selected/open', 'disabled');
                logOptimizerEvent('warn', 'Optimizer toggle skipped because no ChatGPT tab is selected or open.', {
                    action: 'TOGGLE_OPTIMIZER'
                });
                return;
            }

            try {
                await ensureOptimizerContentScript(tab.id);

                const response = await sendOptimizerMessage(tab.id, {
                    type: 'TOGGLE_OPTIMIZER'
                });

                if (response && response.enabled) {
                    setOptimizerStatus('Optimizer Active', 'enabled');
                    optimizerToggle.textContent = 'Disable';
                } else {
                    setOptimizerStatus('Optimizer Disabled', 'disabled');
                    optimizerToggle.textContent = 'Enable';

                    if (optimizerStats) {
                        optimizerStats.style.display = 'none';
                    }
                }

                await refreshOptimizerStatus();
            } catch (error) {
                setOptimizerStatus(`Error: ${error.message}`, 'disabled');
                logOptimizerEvent('error', `Optimizer toggle failed: ${error.message}`, {
                    action: 'TOGGLE_OPTIMIZER',
                    tabId: tab.id,
                    tabTitle: cleanTabTitle(tab.title),
                    tabUrl: tab.url || '',
                    error: error.message || String(error)
                });
                console.error('Optimizer toggle failed:', error);
            }
        });
    }

    if (targetTabSelect) {
        targetTabSelect.addEventListener('change', function () {
            refreshRunningJobsStatus();

            if (optimizerToolPanel && optimizerToolPanel.classList.contains('active')) {
                refreshOptimizerStatus();
            }
        });
    }

    setInterval(function () {
        refreshTargetTabs();
        refreshRunningJobsStatus();

        if (optimizerToolPanel && optimizerToolPanel.classList.contains('active')) {
            refreshOptimizerStatus();
        }
    }, 3000);
});
