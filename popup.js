document.addEventListener('DOMContentLoaded', function () {
    const queueToolTab = document.getElementById('queue-tool-tab');
    const optimizerToolTab = document.getElementById('optimizer-tool-tab');
    const queueToolPanel = document.getElementById('queue-tool-panel');
    const optimizerToolPanel = document.getElementById('optimizer-tool-panel');

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

    const EDIT_SEQUENCE_VALUE = '__edit_selected_sequence__';
    let selectedSequenceName = '';
    let editingSequenceName = '';

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
    });

    loadOptimizerSettings();

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

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'automationFinished') {
            refreshRunningJobsStatus();
            showTempStatus(`Automation finished${request.tabId ? ` on tab ${request.tabId}` : ''}.`);
        }

        if (request.action === 'automationPaused') {
            refreshRunningJobsStatus();
            showTempStatus(`Queue paused: ${request.error || 'ChatGPT failed.'}`);
        }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;

        if (changes.runningJobs || changes.isRunning) {
            refreshRunningJobsStatus();
        }
    });

    if (queueToolTab && optimizerToolTab && queueToolPanel && optimizerToolPanel) {
        queueToolTab.addEventListener('click', function () {
            queueToolTab.classList.add('active');
            optimizerToolTab.classList.remove('active');
            queueToolPanel.classList.add('active');
            optimizerToolPanel.classList.remove('active');
        });

        optimizerToolTab.addEventListener('click', async function () {
            optimizerToolTab.classList.add('active');
            queueToolTab.classList.remove('active');
            optimizerToolPanel.classList.add('active');
            queueToolPanel.classList.remove('active');

            await refreshOptimizerStatus();
        });
    }

    async function refreshTargetTabs() {
        if (!targetTabSelect) return;

        const previousValue = targetTabSelect.value || 'current';

        targetTabSelect.innerHTML = '';

        const currentOption = document.createElement('option');
        currentOption.value = 'current';
        currentOption.textContent = 'Current ChatGPT tab';
        targetTabSelect.appendChild(currentOption);

        let activeTab = null;
        let chatgptTabs = [];

        try {
            const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
            activeTab = activeTabs[0] || null;
        } catch (error) {
            activeTab = null;
        }

        try {
            const tabs1 = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
            const tabs2 = await chrome.tabs.query({ url: 'https://chat.openai.com/*' });
            chatgptTabs = [...tabs1, ...tabs2];
        } catch (error) {
            chatgptTabs = [];
        }

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

        if (activeTab && activeTab.url && isChatGPTUrl(activeTab.url)) {
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
        return typeof url === 'string' &&
            (url.startsWith('https://chatgpt.com/') || url.startsWith('https://chat.openai.com/'));
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
                tab = await chrome.tabs.get(selectedTabId);
            } catch (error) {
                alert('Selected ChatGPT tab no longer exists. Refresh the tab list.');
                await refreshTargetTabs();
                return null;
            }
        } else {
            const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tab = activeTabs[0] || null;

            if (!tab || !tab.url || !isChatGPTUrl(tab.url)) {
                const tabs1 = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
                const tabs2 = await chrome.tabs.query({ url: 'https://chat.openai.com/*' });
                const chatgptTabs = [...tabs1, ...tabs2];

                if (chatgptTabs.length === 0) {
                    alert('No ChatGPT tab is open. Open chatgpt.com, then try again.');
                    return null;
                }

                alert('You are not on a ChatGPT tab. Select a ChatGPT tab from the dropdown, then try again.');
                await refreshTargetTabs();
                return null;
            }
        }

        if (!tab || !tab.id) {
            alert('Could not find the selected tab.');
            return null;
        }

        if (!tab.url || !isChatGPTUrl(tab.url)) {
            alert('Select a ChatGPT tab before starting or adding to the queue.');
            return null;
        }

        return tab;
    }

    async function getOptimizerTargetTab() {
        let tab = null;

        if (targetTabSelect && targetTabSelect.value && targetTabSelect.value !== 'current') {
            try {
                tab = await chrome.tabs.get(Number(targetTabSelect.value));
            } catch (error) {
                return null;
            }
        } else {
            try {
                const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
                tab = activeTabs[0] || null;
            } catch (error) {
                tab = null;
            }

            if (!tab || !isChatGPTUrl(tab.url)) {
                try {
                    const tabs1 = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
                    const tabs2 = await chrome.tabs.query({ url: 'https://chat.openai.com/*' });
                    const chatgptTabs = [...tabs1, ...tabs2];
                    tab = chatgptTabs[0] || null;
                } catch (error) {
                    tab = null;
                }
            }
        }

        if (!tab || !tab.id || !isChatGPTUrl(tab.url)) {
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
        messageList.innerHTML = '';

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

        sequenceDropdown.innerHTML = '';

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
        const prevHTML = statusIndicator.innerHTML;
        const prevDisplay = statusIndicator.style.display;
        const prevBg = statusIndicator.style.background;
        const prevColor = statusIndicator.style.color;

        statusIndicator.innerHTML = msg;
        statusIndicator.style.display = 'block';
        statusIndicator.style.background = 'var(--status-bg)';
        statusIndicator.style.color = 'var(--status-text)';

        setTimeout(() => {
            statusIndicator.innerHTML = prevHTML;
            statusIndicator.style.background = prevBg;
            statusIndicator.style.color = prevColor;
            statusIndicator.style.display = prevDisplay;

            refreshRunningJobsStatus();
        }, 2000);
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
                statusIndicator.innerHTML = '<i class="fas fa-sync fa-spin"></i> Automation running...';
                setSendSequenceButtonMode(false);
                return;
            }

            const selectedTabId = await getSelectedTabIdForStatus();
            const selectedTabJob = selectedTabId ? runningJobs[selectedTabId] : null;

            stopAutomationButton.style.display = 'none';

            if (selectedTabJob) {
                setSendSequenceButtonMode(true);

                if (selectedTabJob.isPaused) {
                    statusIndicator.innerHTML = `<i class="fas fa-pause-circle"></i> Paused. Remaining: ${selectedTabJob.remaining}`;
                    statusIndicator.style.background = 'var(--disabled-bg)';
                    statusIndicator.style.color = 'var(--disabled-text)';
                } else {
                    statusIndicator.innerHTML = `<i class="fas fa-sync fa-spin"></i> Running. Remaining: ${selectedTabJob.remaining}`;
                    statusIndicator.style.background = 'var(--status-bg)';
                    statusIndicator.style.color = 'var(--status-text)';
                }
            } else {
                setSendSequenceButtonMode(false);
                statusIndicator.innerHTML = `<i class="fas fa-sync fa-spin"></i> Running on ${runningCount} tab${runningCount === 1 ? '' : 's'}`;
                statusIndicator.style.background = 'var(--status-bg)';
                statusIndicator.style.color = 'var(--status-text)';
            }

            statusIndicator.style.display = 'block';
        });
    }

    async function getSelectedTabIdForStatus() {
        if (targetTabSelect && targetTabSelect.value && targetTabSelect.value !== 'current') {
            return targetTabSelect.value;
        }

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return tab?.id ? String(tab.id) : '';
        } catch (error) {
            return '';
        }
    }

    async function getTabTitleMap() {
        const titleMap = {};

        try {
            const tabs1 = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
            const tabs2 = await chrome.tabs.query({ url: 'https://chat.openai.com/*' });
            const tabs = [...tabs1, ...tabs2];

            tabs.forEach(tab => {
                if (tab.id) {
                    titleMap[String(tab.id)] = cleanTabTitle(tab.title || 'ChatGPT');
                }
            });
        } catch (error) {
            // Ignore title lookup errors.
        }

        return titleMap;
    }

    async function renderRunningInstances(runningJobs) {
        if (!runningInstancesList) return;

        const entries = Object.entries(runningJobs || {});
        const titleMap = await getTabTitleMap();

        runningInstancesList.innerHTML = '';

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
            const nextPreview = job.nextMessagePreview ? ` | Next: ${job.nextMessagePreview}` : '';

            info.textContent = `${tabTitle} | ${status} | Remaining: ${job.remaining}${nextPreview}`;

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
            } catch (error) {
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
        } catch (error) {
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
            } catch (error) {
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
                return;
            }

            try {
                await sendOptimizerMessage(tab.id, {
                    type: 'UPDATE_CONFIG',
                    config: newConfig
                });

                await refreshOptimizerStatus();
            } catch (error) {
                setOptimizerStatus('Settings saved. Optimizer not loaded on selected tab.', 'disabled');
            }
        }, 500);
    }

    async function sendOptimizerMessage(tabId, message) {
        return new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, message, function (response) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                resolve(response);
            });
        });
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
            return;
        }

        try {
            const response = await sendOptimizerMessage(tab.id, { type: 'GET_STATUS' });

            if (response && response.enabled) {
                setOptimizerStatus('Optimizer Active', 'enabled');
                optimizerToggle.textContent = 'Disable';

                optimizerStats.innerHTML =
                    `<strong>Stats:</strong><br>` +
                    `Target: ${cleanTabTitle(tab.title)}<br>` +
                    `Total messages: ${response.messageCount}<br>` +
                    `Hidden: ${response.hiddenCount}<br>` +
                    `Visible: ${response.visibleCount}<br>` +
                    `Container: ${response.debugInfo?.containerFound ? 'Found' : 'Missing'}<br>` +
                    `Initialized: ${response.debugInfo?.initialized ? 'Yes' : 'No'}`;

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
        }
    }

    if (optimizerToggle) {
        optimizerToggle.addEventListener('click', async function () {
            const tab = await getOptimizerTargetTab();

            if (!tab) {
                setOptimizerStatus('No ChatGPT tab selected/open', 'disabled');
                return;
            }

            try {
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