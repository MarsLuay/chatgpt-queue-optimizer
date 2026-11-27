/**
 * @param {RunningJobSnapshot|Record<string, unknown>} [job]
 */
function requirePopupNative(value){
    if(value==null)throw new Error('Required native popup policy unavailable.');
    return value;
}
function getPopupQueueStatusLabel(job = {}) {
    return requirePopupNative(globalThis.CpoQueueEngine?.popupStatus?.(job));
}

function formatPopupRunningInstanceText(tabTitle, job = {}) {
    return requirePopupNative(globalThis.CpoQueueEngine?.popupRunningLabel?.(tabTitle,getPopupQueueStatusLabel(job),job));
}

function parseScheduledLocalDateTime(value) {
    const engine=globalThis.CpoQueueEngine;
    if(engine?.status==='Rust/WASM'){
        const parts=engine.localDateParts(value);
        if(!parts)return null;
        const [year,month,day,hour,minute]=parts;
        const date=new Date(year,month-1,day,hour,minute,0,0);
        // Only the platform can resolve local civil time and DST gaps.
        if(!engine.localDateMatches(parts,[date.getFullYear(),date.getMonth()+1,date.getDate(),date.getHours(),date.getMinutes()]))return null;
        return date.getTime();
    }
    return null;
}

function formatScheduledLocalDateTime(timestamp) {
    const date = new Date(Number(timestamp));
    if (!Number.isFinite(date.getTime())) return 'Invalid date';

    return date.toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short'
    });
}

function getScheduledStatusLabel(status) {
    return requirePopupNative(globalThis.CpoQueueEngine?.textBatch?.(11,[status||'']));
}

function formatScheduledItemText(item = {}, targetTitle = '') {
    return requirePopupNative(globalThis.CpoQueueEngine?.popupScheduledLabel?.(item,targetTitle,formatScheduledLocalDateTime(item.dueTs)));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatPopupRunningInstanceText,
        getPopupQueueStatusLabel,
        parseScheduledLocalDateTime,
        formatScheduledLocalDateTime,
        getScheduledStatusLabel,
        formatScheduledItemText
    };
}

document.addEventListener('DOMContentLoaded', async function () {
    const ui = new globalThis.CpoRustBrowserBridge(null);
    const [uiReady,queueReady]=await Promise.all([ui.load(),globalThis.CpoQueueEngine?.load()]);
    if(!uiReady||!queueReady){
        const status=document.getElementById('status-indicator');
        if(status){status.hidden=false;status.textContent='Required Rust modules unavailable. Rebuild and reinstall the extension.';}
        for(const input of document.querySelectorAll('button,input,textarea,select'))input.disabled=true;
        return;
    }
    function renderNative(kind,root,rows,limit=rows.length,dispatch=()=>{}){
        if(ui.renderUI(kind,root,rows,limit,dispatch)!==true){
            const status=document.getElementById('status-indicator');
            if(status){status.hidden=false;status.textContent='Native UI failed. Reopen the extension popup.';}
            return false;
        }
        return true;
    }
    const queueToolTab = document.getElementById('queue-tool-tab');
    const scheduledToolTab = document.getElementById('scheduled-tool-tab');
    const optimizerToolTab = document.getElementById('optimizer-tool-tab');
    const settingsToolTab = document.getElementById('settings-tool-tab');
    const queueToolPanel = document.getElementById('queue-tool-panel');
    const scheduledToolPanel = document.getElementById('scheduled-tool-panel');
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
    const scheduledTargetTabSelect = document.getElementById('scheduled-target-tab-select');
    const refreshScheduledTargetTabsButton = document.getElementById('refresh-scheduled-target-tabs');
    const scheduledDueAtInput = document.getElementById('scheduled-due-at');
    const scheduledMessageInput = document.getElementById('scheduled-message');
    const scheduleMessageButton = document.getElementById('schedule-message-btn');
    const scheduledItemsList = document.getElementById('scheduled-items-list');
    const refreshScheduledItemsButton = document.getElementById('refresh-scheduled-items');
    const scheduledStatusIndicator = document.getElementById('scheduled-status-indicator');

    const runningInstancesList = document.getElementById('running-instances-list');
    const refreshInstancesButton = document.getElementById('refresh-instances');
    const stopAllInstancesButton = document.getElementById('stop-all-instances');
    const queueLogList = document.getElementById('queue-log-list');
    const refreshQueueLogButton = document.getElementById('refresh-queue-log');
    const copyQueueLogButton = document.getElementById('copy-queue-log');
    const clearQueueLogButton = document.getElementById('clear-queue-log');
    const queueDeepResearchAware = document.getElementById('queue-deep-research-aware');
    const queueUnlimitedRetryWait = document.getElementById('queue-unlimited-retry-wait');
    const queueDeliveryTimeoutRefresh = document.getElementById('queue-delivery-timeout-refresh');

    const optimizerStatus = document.getElementById('optimizer-status');
    const optimizerWindowSize = document.getElementById('optimizer-window-size');
    const optimizerBatchSize = document.getElementById('optimizer-batch-size');
    const optimizerAutoScroll = document.getElementById('optimizer-auto-scroll');
    const optimizerOffscreen = document.getElementById('optimizer-offscreen');
    const optimizerEvictMedia = document.getElementById('optimizer-evict-media');
    const optimizerAdaptive = document.getElementById('optimizer-adaptive-budget');
    const optimizerResourceBudget = document.getElementById('optimizer-resource-budget');
    const optimizerIdleMinutes = document.getElementById('optimizer-idle-minutes');
    const optimizerHistory = document.getElementById('optimizer-history-reader');
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
    let scheduledStatusTimer = null;
    let popupStatusTimer = null;
    let activePopupStatus = null;
    let dismissedPopupStatusKey = '';

    const EDIT_SEQUENCE_VALUE = '__edit_selected_sequence__';
    let selectedSequenceName = '';
    let editingSequenceName = '';
    const PROVIDER_URL_PATTERNS = [
        'https://chatgpt.com/*',
        'https://chat.openai.com/*',
        'https://gemini.google.com/*',
        'https://claude.ai/*'
    ];
    const CHATGPT_URL_PATTERNS = PROVIDER_URL_PATTERNS;

    function tabsQuery(queryInfo) {
        return globalThis.CpoBrowserApi.invoke('tabQuery',queryInfo).then(tabs=>Array.isArray(tabs)?tabs:[]);
    }

    function tabsGet(tabId) {
        return globalThis.CpoBrowserApi.invoke('tabGet',tabId);
    }

    function executeScript(details) {
        return globalThis.CpoBrowserApi.inject(details);
    }

    function insertCSS(details) {
        return globalThis.CpoBrowserApi.inject(details,true);
    }

    function sleep(ms) {
        return new Promise(resolve => {
            setTimeout(resolve, ms);
        });
    }

    function getTabUrl(tab) {
        return tab?.url || tab?.pendingUrl || '';
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

    async function getAllSupportedTabs() {
        const collected = [];

        try {
            collected.push(...await tabsQuery({ url: PROVIDER_URL_PATTERNS }));
        } catch {
            for (const pattern of PROVIDER_URL_PATTERNS) {
                try {
                    collected.push(...await tabsQuery({ url: pattern }));
                } catch {
                    // Fall back to the unfiltered scan below.
                }
            }
        }

        try {
            const allTabs = await tabsQuery({});
            const filtered=globalThis.CpoQueueEngine.supportedTabs(allTabs);
            if(filtered==null)throw new Error('Native tab filter unavailable');
            collected.push(...filtered);
        } catch {
            // URL-filtered tab queries above are enough when all-tabs scanning is unavailable.
        }

        const selected=globalThis.CpoQueueEngine.supportedTabs(collected);
        if(selected==null)throw new Error('Native tab collection unavailable');
        // Locale collation remains browser-owned; clean each title only once.
        const titles=new Map(selected.map(tab=>[tab.id,cleanTabTitle(tab.title||'')]));
        return selected.toSorted((a,b)=>Number(!!b.active)-Number(!!a.active) ||
            titles.get(a.id).localeCompare(titles.get(b.id)));
    }

    const getAllChatGPTTabs = getAllSupportedTabs;

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
        refreshScheduledTargetTabs();
        refreshRunningJobsStatus();
        refreshQueueLog();
        refreshScheduledItems();
        initializeScheduledDueDefault();
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

    if (queueDeliveryTimeoutRefresh) {
        queueDeliveryTimeoutRefresh.addEventListener('change', saveQueueSettings);
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
            showPopupStatus(`Queue paused: ${request.error || 'ChatGPT failed.'}`, {
                kind: 'error',
                persistent: true,
                source: 'queue',
                key: `queue:${request.tabId || 'unknown'}:paused:${request.error || 'ChatGPT failed.'}`
            });
        }

        if (request.action === 'queueDebugLogUpdated') {
            refreshQueueLog();
        }

        if (request.action === 'scheduledMessagesUpdated') {
            refreshScheduledItems();
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

        if (changes.scheduledMessages) {
            refreshScheduledItems();
        }
    });

    if (
        queueToolTab &&
        scheduledToolTab &&
        optimizerToolTab &&
        settingsToolTab &&
        queueToolPanel &&
        scheduledToolPanel &&
        optimizerToolPanel &&
        settingsToolPanel
    ) {
        queueToolTab.addEventListener('click', function () {
            activateToolPanel(queueToolTab, queueToolPanel);
        });

        scheduledToolTab.addEventListener('click', function () {
            activateToolPanel(scheduledToolTab, scheduledToolPanel);
            refreshScheduledTargetTabs();
            refreshScheduledItems();
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
        [queueToolTab, scheduledToolTab, optimizerToolTab, settingsToolTab].forEach((tab) => {
            if (tab) {
                tab.classList.toggle('active', tab === activeTab);
            }
        });

        [queueToolPanel, scheduledToolPanel, optimizerToolPanel, settingsToolPanel].forEach((panel) => {
            if (panel) {
                panel.classList.toggle('active', panel === activePanel);
            }
        });
    }

    async function populateTargetTabSelect(selectEl) {
        if (!selectEl) return;

        const previousValue = selectEl.value || 'current';

        selectEl.textContent = '';

        const currentOption = document.createElement('option');
        currentOption.value = 'current';
        currentOption.textContent = 'Current supported tab';
        selectEl.appendChild(currentOption);

        const activeTab = await getActiveTab();
        const chatgptTabs = await getAllChatGPTTabs();

        chatgptTabs.forEach(tab => {
            if (!tab.id) return;

            const option = document.createElement('option');
            option.value = String(tab.id);
            option.textContent = cleanTabTitle(tab.title || 'Supported tab');
            selectEl.appendChild(option);
        });

        const optionValues = Array.from(selectEl.options).map(opt => opt.value);

        if (previousValue !== 'current' && optionValues.includes(previousValue)) {
            selectEl.value = previousValue;
            return;
        }

        if (activeTab && isSupportedProviderUrl(getTabUrl(activeTab))) {
            selectEl.value = 'current';
            return;
        }

        if (chatgptTabs.length > 0 && chatgptTabs[0].id) {
            selectEl.value = String(chatgptTabs[0].id);
            return;
        }

        selectEl.value = 'current';
    }

    async function refreshTargetTabs() {
        await populateTargetTabSelect(targetTabSelect);
    }

    async function refreshScheduledTargetTabs() {
        await populateTargetTabSelect(scheduledTargetTabSelect);
    }

    function showScheduledStatus(message, kind = 'info', duration = 3000) {
        if (!scheduledStatusIndicator) return;

        if (scheduledStatusTimer !== null) {
            clearTimeout(scheduledStatusTimer);
            scheduledStatusTimer = null;
        }

        const text = String(message || '').trim();
        if (!text) {
            scheduledStatusIndicator.hidden = true;
            scheduledStatusIndicator.textContent = '';
            return;
        }

        const normalizedKind = ['error', 'warning', 'success', 'info'].includes(kind) ? kind : 'info';
        scheduledStatusIndicator.className = normalizedKind === 'error' ? 'error' : normalizedKind;
        scheduledStatusIndicator.setAttribute(
            'role',
            normalizedKind === 'error' || normalizedKind === 'warning' ? 'alert' : 'status'
        );
        scheduledStatusIndicator.setAttribute(
            'aria-live',
            normalizedKind === 'error' || normalizedKind === 'warning' ? 'assertive' : 'polite'
        );
        scheduledStatusIndicator.textContent = text;
        scheduledStatusIndicator.hidden = false;

        if (duration > 0 && normalizedKind !== 'error') {
            scheduledStatusTimer = setTimeout(() => {
                scheduledStatusTimer = null;
                scheduledStatusIndicator.hidden = true;
                scheduledStatusIndicator.textContent = '';
            }, duration);
        }
    }

    function formatDateTimeLocalInput(timestamp) {
        const date = new Date(Number(timestamp));
        if (!Number.isFinite(date.getTime())) return '';

        return requirePopupNative(globalThis.CpoQueueEngine?.localDateInput?.([date.getFullYear(),date.getMonth()+1,date.getDate(),date.getHours(),date.getMinutes()]));
    }

    function initializeScheduledDueDefault() {
        if (!scheduledDueAtInput || scheduledDueAtInput.value) return;

        const now=Date.now();
        const nextMinute=globalThis.CpoQueueEngine.timestampMath(3,now,300000);
        if(nextMinute==null||!Number.isFinite(nextMinute))return;
        scheduledDueAtInput.value = formatDateTimeLocalInput(nextMinute);
    }

    async function getSelectedScheduledTargetTab() {
        let tab = null;
        const selectedValue = scheduledTargetTabSelect?.value || 'current';

        if (selectedValue !== 'current') {
            try {
                tab = await tabsGet(Number(selectedValue));
            } catch {
                showScheduledStatus('Selected target tab no longer exists. Refresh the tab list.', 'error', 0);
                await refreshScheduledTargetTabs();
                return null;
            }
        } else {
            tab = await getActiveTab();

            if (!tab || !isSupportedProviderUrl(getTabUrl(tab))) {
                const supportedTabs = await getAllSupportedTabs();
                tab = supportedTabs[0] || null;

                if (tab?.id && scheduledTargetTabSelect) {
                    await refreshScheduledTargetTabs();
                    scheduledTargetTabSelect.value = String(tab.id);
                }
            }
        }

        if (!tab || !tab.id) {
            showScheduledStatus(
                'No supported target tab is open. Open ChatGPT, Gemini, or Claude, then refresh the tab list.',
                'error',
                0
            );
            return null;
        }

        if (!isSupportedProviderUrl(getTabUrl(tab))) {
            showScheduledStatus(
                'Select a ChatGPT, Gemini, or Claude tab before scheduling.',
                'error',
                0
            );
            return null;
        }

        return tab;
    }

    function sendScheduledRuntimeMessage(request) {
        return globalThis.CpoBrowserApi.invoke('runtimeSend',request).then(response=>response||{});
    }

    function getScheduledTargetTitleMap() {
        return getAllSupportedTabs().then((tabs) => {
            const titles = {};
            tabs.forEach((tab) => {
                if (tab?.id) titles[String(tab.id)] = cleanTabTitle(tab.title || 'Supported tab');
            });
            return titles;
        }).catch(() => ({}));
    }

    async function renderScheduledItems(items) {
        if (!scheduledItemsList) return;

        const titleMap = await getScheduledTargetTitleMap();
        const sortedItems=globalThis.CpoQueueEngine.scheduledSort(Array.isArray(items)?items:[]);
        if(sortedItems==null)throw new Error('Native scheduled collection unavailable');

        const rows=sortedItems.map(item=>({fields:[formatScheduledItemText(item,titleMap[String(item.tabId)]),
            getScheduledStatusLabel(item.status),String(item.status||'').toLowerCase()],
            flags:globalThis.CpoQueueEngine.scheduledActions(item.status)??0}));
        renderNative(2,scheduledItemsList,rows,rows.length,(action,index)=>{
            const item=sortedItems[index];if(!item)return;
            if(action===4)updateScheduledItem('cancelScheduledMessage',item.id);
            else if(action===5)retryScheduledItem(item);
            else if(action===6)updateScheduledItem('deleteScheduledMessage',item.id);
        });
    }

    async function refreshScheduledItems() {
        if (!scheduledItemsList) return;

        try {
            const response = await sendScheduledRuntimeMessage({ action: 'listScheduledMessages' });
            if (!response.ok) {
                throw new Error(response.error || 'Could not read scheduled messages.');
            }
            await renderScheduledItems(response.items);
        } catch (error) {
            renderScheduledItems([]);
            showScheduledStatus(error.message || 'Could not read scheduled messages.', 'error', 0);
        }
    }

    async function updateScheduledItem(action, id) {
        try {
            const response = await sendScheduledRuntimeMessage({ action, id });
            if (!response.ok) {
                throw new Error(response.error || 'Could not update scheduled message.');
            }
            showScheduledStatus(action === 'deleteScheduledMessage' ? 'Scheduled message deleted.' : 'Scheduled message cancelled.');
            await refreshScheduledItems();
        } catch (error) {
            showScheduledStatus(error.message || 'Could not update scheduled message.', 'error', 0);
        }
    }

    async function retryScheduledItem(item) {
        const dueTs = parseScheduledLocalDateTime(scheduledDueAtInput?.value || '');
        const now=Date.now();
        const nextDueTs=globalThis.CpoQueueEngine.timestampMath(4,dueTs??0,now,60000);
        if(nextDueTs==null||!Number.isFinite(nextDueTs)){showScheduledStatus('Native timestamp calculation unavailable.','error',0);return;}

        try {
            const response = await sendScheduledRuntimeMessage({
                action: 'retryScheduledMessage',
                id: item.id,
                dueTs: nextDueTs
            });
            if (!response.ok) {
                throw new Error(response.error || 'Could not retry scheduled message.');
            }
            showScheduledStatus(`Scheduled message will retry at ${formatScheduledLocalDateTime(nextDueTs)}.`);
            await refreshScheduledItems();
        } catch (error) {
            showScheduledStatus(error.message || 'Could not retry scheduled message.', 'error', 0);
        }
    }

    if (refreshScheduledTargetTabsButton) {
        refreshScheduledTargetTabsButton.addEventListener('click', refreshScheduledTargetTabs);
    }

    if (refreshScheduledItemsButton) {
        refreshScheduledItemsButton.addEventListener('click', refreshScheduledItems);
    }

    if (scheduleMessageButton) {
        scheduleMessageButton.addEventListener('click', async function () {
            const message = scheduledMessageInput?.value.trim() || '';
            const dueTs = parseScheduledLocalDateTime(scheduledDueAtInput?.value || '');

            if (!message) {
                showScheduledStatus('Type a message before scheduling.', 'error', 0);
                return;
            }

            if (!dueTs) {
                showScheduledStatus('Choose a valid local date and time.', 'error', 0);
                return;
            }

            if (globalThis.CpoQueueEngine.timestampMath(6,dueTs,Date.now())!==1) {
                showScheduledStatus('Choose a future local date and time.', 'error', 0);
                return;
            }

            const tab = await getSelectedScheduledTargetTab();
            if (!tab) return;

            scheduleMessageButton.disabled = true;
            try {
                const response = await sendScheduledRuntimeMessage({
                    action: 'scheduleMessage',
                    message,
                    dueTs,
                    tabId: tab.id
                });

                if (!response.ok) {
                    throw new Error(response.error || 'Could not schedule message.');
                }

                scheduledMessageInput.value = '';
                showScheduledStatus(`Message scheduled for ${formatScheduledLocalDateTime(response.item?.dueTs || dueTs)}.` , 'success');
                await refreshScheduledItems();
            } catch (error) {
                showScheduledStatus(error.message || 'Could not schedule message.', 'error', 0);
            } finally {
                scheduleMessageButton.disabled = false;
            }
        });
    }

    function cleanTabTitle(title) {
        return requirePopupNative(globalThis.CpoQueueEngine?.textBatch?.(8,[String(title||'Supported tab')]));
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
                showErrorStatus('Selected tab no longer exists. Refresh the tab list.', 'target-tab-missing');
                await refreshTargetTabs();
                return null;
            }
        } else {
            tab = await getActiveTab();

            if (!tab || !isSupportedProviderUrl(getTabUrl(tab))) {
                const chatgptTabs = await getAllChatGPTTabs();

                if (chatgptTabs.length === 0) {
                    showErrorStatus(
                        'No supported tab is open. Open chatgpt.com, gemini.google.com, or claude.ai, then try again.',
                        'target-tab-none'
                    );
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
            showErrorStatus('Could not find the selected tab.', 'target-tab-unavailable');
            return null;
        }

        if (!isSupportedProviderUrl(getTabUrl(tab))) {
            showErrorStatus(
                'Select a ChatGPT, Gemini, or Claude tab before starting or adding to the queue.',
                'target-tab-unsupported'
            );
            return null;
        }

        return tab;
    }

    function tabSupportsOptimizer(tab) {
        const url = getTabUrl(tab);
        if (!isSupportedProviderUrl(url)) {
            return false;
        }
        if (typeof getProviderForUrl === 'function') {
            const provider = getProviderForUrl(url);
            return !!(provider && provider.supportsOptimizer);
        }
        return isChatGPTUrl(url);
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

            if (!tab || !tabSupportsOptimizer(tab)) {
                const chatgptTabs = await getAllChatGPTTabs();
                tab = chatgptTabs.find(candidate => tabSupportsOptimizer(candidate)) || null;
            }
        }

        if (!tab || !tab.id || !tabSupportsOptimizer(tab)) {
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
        const vars=globalThis.CpoQueueEngine.sequenceVariables(textList);
        if(vars==null)throw new Error('Native variable collection unavailable');
        return vars;
    }

    function resolveVariablesForTextList(textList) {
        const uniqueVars = getVariablesFromTextList(textList);
        let resolved = [...textList];

        if (uniqueVars.length === 0) {
            return resolved;
        }

        const values = new Map();
        for (const v of uniqueVars) {
            const input = prompt(`Enter value for {{${v}}}:`);
            if (input === null) return null;
            values.set(v,input);
        }
        for(const [name,value] of values){
            const next=[];
            for(const text of resolved){
                const replaced=ui.substitute(text,name,value);
                if(replaced==null){showErrorStatus('Native variable substitution failed.');return null;}
                next.push(replaced);
            }
            resolved=next;
        }

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
                    showErrorStatus(chrome.runtime.lastError.message || 'Could not stop sequence.', 'stop-sequence-error');
                    return;
                }

                if (response && response.ok) {
                    showTempStatus(`Stopped sequence on "${cleanTabTitle(tab.title)}".`);
                    refreshRunningJobsStatus();
                } else {
                    showErrorStatus(response?.error || 'Could not stop sequence.');
                }
            });

            return;
        }

        if (messages.length === 0) {
            showErrorStatus('No sequence messages to send. Open "Make a sequence" and add messages first.', 'sequence-empty');
            return;
        }

        const resolvedMessages = resolveVariablesForTextList(messages);
        if (!resolvedMessages) return;

        chrome.runtime.sendMessage({
            action: 'startSequence',
            messages: resolvedMessages,
            tabId: tab.id,
            waitForIdleBeforeStart: true
        }, function (response) {
            if (chrome.runtime.lastError) {
                showErrorStatus(chrome.runtime.lastError.message || 'Could not start sequence.', 'start-sequence-error');
                return;
            }

            if (response && response.ok) {
                showTempStatus(`Started sequence on "${cleanTabTitle(tab.title)}".`);
                refreshRunningJobsStatus();
            } else {
                showErrorStatus(response?.error || 'Could not start sequence.');
            }
        });
    });

    enqueueMessageButton.addEventListener('click', async function () {
        const rawMessage = queueMessageInput.value.trim();

        if (!rawMessage) {
            showErrorStatus('Type a message in the "Send message next" box.', 'enqueue-message-empty');
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
            message: resolvedMessage,
            waitForIdleBeforeStart: true
        }, function (response) {
            if (chrome.runtime.lastError) {
                showErrorStatus(chrome.runtime.lastError.message || 'Could not add message to queue.', 'enqueue-message-error');
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
                showErrorStatus(response?.error || 'Could not add message to queue.');
            }
        });
    });

    stopAutomationButton.addEventListener('click', async function () {
        const tab = await getSelectedTargetTab();

        chrome.runtime.sendMessage({ action: 'getRunningJobs' }, function (response) {
            if (chrome.runtime.lastError) {
                showErrorStatus(chrome.runtime.lastError.message || 'Could not read running jobs.', 'running-jobs-error');
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
                showErrorStatus('Could not copy queue log.', 'copy-queue-log-error');
            }
        });
    }

    if (clearQueueLogButton) {
        clearQueueLogButton.addEventListener('click', function () {
            chrome.runtime.sendMessage({ action: 'clearQueueDebugLogs' }, function (response) {
                if (chrome.runtime.lastError) {
                    showErrorStatus(chrome.runtime.lastError.message || 'Could not clear queue log.', 'clear-queue-log-error');
                    return;
                }

                if (!response || !response.ok) {
                    showErrorStatus(response?.error || 'Could not clear queue log.');
                    return;
                }

                renderQueueLog([]);
                showTempStatus('Queue log cleared.');
            });
        });
    }

    addMessageButton.addEventListener('click', function () {
        const message = globalThis.CpoQueueEngine.trim(newMessageInput.value);

        if (message && ui.sequenceEdit(messages,0,0,message)===true) {
            newMessageInput.value = '';
            saveMessages();
            updateMessagesList();
            refreshVarDropdown();
        }
    });

    // Rendering thousands of saved prompts at once can freeze the popup.
    // Keep all prompts in memory/storage; only the displayed rows are bounded.
    const MESSAGE_RENDER_CHUNK = 100;
    let renderedMessageLimit = MESSAGE_RENDER_CHUNK;
    function updateMessagesList() {
        const rendered=Math.min(messages.length,renderedMessageLimit);
        const rows=messages.slice(0,rendered).map((msg,index)=>({fields:[`${index+1}: ${msg}`]}));
        // Only visible prompts are materialized into DOM data. The extra
        // descriptor supplies the load-more label without copying all prompts.
        if(rendered<messages.length)rows.push({fields:['',`Show next ${Math.min(MESSAGE_RENDER_CHUNK,messages.length-rendered)} prompts (${rendered} of ${messages.length} shown)`]});
        renderNative(0,messageList,rows,rendered,(action,index)=>{
            if(action===3){
                renderedMessageLimit=ui.nextLimit(messages.length,renderedMessageLimit)??renderedMessageLimit;
                updateMessagesList();return;
            }
            if(index>=messages.length)return;
            if(action===1){
                const updated=prompt('Edit message:',messages[index]);
                if(updated===null)return;
                const value=globalThis.CpoQueueEngine.trim(updated);
                if(!value){showErrorStatus('Message cannot be empty.','message-empty');return;}
                if(ui.sequenceEdit(messages,1,index,value)!==true)return;
            }else if(action===2){
                if(ui.sequenceEdit(messages,2,index)!==true)return;
            }else return;
            saveMessages();updateMessagesList();refreshVarDropdown();
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

        if(!renderNative(1,sequenceDropdown,names.map(name=>({fields:[name]}))))return;
        const choice=ui.sequenceSelection(Number(!!(newSeqName&&Object.hasOwn(savedSequences,newSeqName)))|
            (Number(shouldLoadFirstSequence)<<1)|(Number(!!(selectedSequenceName&&Object.hasOwn(savedSequences,selectedSequenceName)))<<2),names.length);
        if(choice===0){selectedSequenceName='';setSequenceEditMode('');return;}
        if(choice==null)return;

        if (choice===1) {
            selectedSequenceName = newSeqName;
            sequenceDropdown.value = newSeqName;
            const loaded=ui.savedSequence(1,savedSequences,newSeqName,messages);
            if(!loaded?.ok)return;
            messages=loaded.messages;
            saveMessages();
            updateMessagesList();
            setSequenceEditMode('');
            return;
        }

        if (choice===3 && shouldLoadFirstSequence) {
            selectedSequenceName = names[0];
            sequenceDropdown.value = names[0];
            const loaded=ui.savedSequence(1,savedSequences,names[0],messages);
            if(!loaded?.ok)return;
            messages=loaded.messages;
            saveMessages();
            updateMessagesList();
            setSequenceEditMode('');
            return;
        }

        const keepName = choice===2 ? selectedSequenceName : names[0];

        selectedSequenceName = keepName;
        sequenceDropdown.value = keepName;
    }

    clearMessagesButton.addEventListener('click', function () {
        if(ui.sequenceEdit(messages,3)!==true)return;
        saveMessages();
        updateMessagesList();
        refreshVarDropdown();
    });

    saveSequenceButton.addEventListener('click', function () {
        if (editingSequenceName && savedSequences[editingSequenceName]) {
            const editedName = editingSequenceName;

            if(ui.savedSequence(0,savedSequences,editedName,messages)?.ok!==true){showErrorStatus('Could not save sequence.');return;}

            chrome.storage.local.set({ sequences: savedSequences }, () => {
                selectedSequenceName = editedName;
                setSequenceEditMode('');
                updateSequenceDropdown(false, editedName);
            });

            return;
        }

        const name = prompt('Enter a name for this sequence:');

        const cleanName=name?globalThis.CpoQueueEngine.trim(name):'';
        if (cleanName) {
            if(!globalThis.CpoQueueEngine.validSequenceName(cleanName)){showErrorStatus('Reserved sequence name or native validation unavailable.');return;}

            if(ui.savedSequence(0,savedSequences,cleanName,messages)?.ok!==true){showErrorStatus('Could not save sequence.');return;}

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

            const loaded=ui.savedSequence(1,savedSequences,targetName,messages);
            if(!loaded?.ok)return;
            messages=loaded.messages;
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
            const loaded=ui.savedSequence(1,savedSequences,selectedValue,messages);
            if(!loaded?.ok)return;
            messages=loaded.messages;
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
            if(ui.savedSequence(2,savedSequences,name,messages)?.ok!==true)return;

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

    function showPopupStatus(message, options = {}) {
        const text = String(message || '').trim();

        if (!text) {
            clearPopupStatus();
            return;
        }

        const allowedKinds = ['info', 'success', 'warning', 'error'];
        const kind = allowedKinds.includes(options.kind) ? options.kind : 'info';
        const persistent = options.persistent === true;
        const source = options.source || 'action';
        const key = options.key || `${source}:${kind}:${text}`;

        if (persistent && dismissedPopupStatusKey === key) {
            return;
        }

        if (!persistent && source === 'queue') {
            dismissedPopupStatusKey = '';
        }

        if (popupStatusTimer !== null) {
            clearTimeout(popupStatusTimer);
            popupStatusTimer = null;
        }

        activePopupStatus = { key, kind, persistent, source };
        statusIndicator.className = `popup-status popup-status-${kind}`;
        statusIndicator.dataset.statusKind = kind;
        statusIndicator.setAttribute('role', kind === 'error' || kind === 'warning' ? 'alert' : 'status');
        statusIndicator.setAttribute('aria-live', kind === 'error' || kind === 'warning' ? 'assertive' : 'polite');
        statusIndicator.setAttribute('aria-atomic', 'true');
        renderNative(7,statusIndicator,[{fields:[text],flags:Number(persistent)}],1,action=>{
            if(action===9)dismissPopupStatus();
        });

        statusIndicator.hidden = false;

        const duration = Number(options.duration ?? (persistent ? 0 : 2000));
        if (!persistent && duration > 0) {
            popupStatusTimer = setTimeout(() => {
                if (activePopupStatus?.key === key) {
                    clearPopupStatus();
                    refreshRunningJobsStatus();
                }
            }, duration);
        }
    }

    function showErrorStatus(message, key) {
        showPopupStatus(message, {
            kind: 'error',
            persistent: true,
            key
        });
    }

    function dismissPopupStatus() {
        if (activePopupStatus?.persistent && activePopupStatus.source === 'queue') {
            dismissedPopupStatusKey = activePopupStatus.key;
        }

        clearPopupStatus();
    }

    function clearPopupStatus({ resetDismissed = false } = {}) {
        if (popupStatusTimer !== null) {
            clearTimeout(popupStatusTimer);
            popupStatusTimer = null;
        }

        activePopupStatus = null;

        if (resetDismissed) {
            dismissedPopupStatusKey = '';
        }

        statusIndicator.hidden = true;
        statusIndicator.className = 'popup-status';
        statusIndicator.dataset.statusKind = 'info';
        statusIndicator.setAttribute('role', 'status');
        statusIndicator.setAttribute('aria-live', 'polite');
        statusIndicator.setAttribute('aria-atomic', 'true');
        statusIndicator.replaceChildren();
    }

    function showTempStatus(message) {
        showPopupStatus(message, { kind: 'info', source: 'action', duration: 2000 });
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

        if ((globalThis.CpoQueueEngine?.numeric('cpo_log_duplicate',[Number(signature===lastOptimizerLogSignature),now-lastOptimizerLogAt,dedupeMs]) ?? 0) === 1) {
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

        const rows=(Array.isArray(logs)?logs:[]).slice(-30).map(log=>{
            const level=['error','warn','success','info'].includes(log.level)?log.level:'info';
            const source=log.details?.source?' | '+String(log.details.source).toUpperCase():'';
            const details=formatLogDetails(log.details);
            return {fields:[`${formatLogTime(log.timestamp)} | ${level.toUpperCase()}${source}${log.tabId?' | Tab '+log.tabId:''}`,
                log.message||'Queue event',details,level],flags:Number(!!details)};
        });
        renderNative(4,queueLogList,rows);
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

        const totalRemaining = requirePopupNative(globalThis.CpoQueueEngine?.remaining(runningJobs));

        messagesToGoFooter.textContent = `${totalRemaining} message${totalRemaining === 1 ? '' : 's'} to go...`;
    }

    async function refreshRunningJobsStatus() {
        chrome.runtime.sendMessage({ action: 'getRunningJobs' }, async function (response) {
            if (chrome.runtime.lastError) {
                stopAutomationButton.style.display = 'none';
                setSendSequenceButtonMode(false);
                updateMessagesToGoFooter({});
                await renderRunningInstances({});
                showErrorStatus(chrome.runtime.lastError.message || 'Could not read running jobs.', 'running-jobs-error');
                return;
            }

            const runningJobs = response?.jobs || {};
            const runningCount = Object.keys(runningJobs).length;

            updateMessagesToGoFooter(runningJobs);
            await renderRunningInstances(runningJobs);

            if (runningCount === 0) {
                stopAutomationButton.style.display = 'none';
                setSendSequenceButtonMode(false);
                if (activePopupStatus?.source === 'queue') {
                    clearPopupStatus({ resetDismissed: true });
                }
                return;
            }

            const selectedTabId = await getSelectedTabIdForStatus();
            const selectedTabJob = selectedTabId ? runningJobs[selectedTabId] : null;

            stopAutomationButton.style.display = 'none';

            if (activePopupStatus?.persistent && activePopupStatus.source !== 'queue') {
                return;
            }

            if (selectedTabJob) {
                setSendSequenceButtonMode(true);

                if (selectedTabJob.isPaused || selectedTabJob.status === 'failed') {
                    const reason = selectedTabJob.lastError || selectedTabJob.pausedReason;
                    const reasonText = reason ? ` ${reason}` : '';
                    showPopupStatus(`Queue ${getPopupQueueStatusLabel(selectedTabJob).toLowerCase()}. Remaining: ${selectedTabJob.remaining}.${reasonText}`, {
                        kind: 'error',
                        persistent: true,
                        source: 'queue',
                        key: `queue:${selectedTabId}:paused:${reason || selectedTabJob.remaining}`
                    });
                } else {
                    dismissedPopupStatusKey = '';
                    showPopupStatus(`${getPopupQueueStatusLabel(selectedTabJob)}. Remaining: ${selectedTabJob.remaining}`, {
                        kind: 'info',
                        source: 'queue',
                        duration: 0,
                        key: `queue:${selectedTabId}:${selectedTabJob.currentPhase || selectedTabJob.status || 'running'}:${selectedTabJob.remaining}`
                    });
                }
            } else {
                setSendSequenceButtonMode(false);
                dismissedPopupStatusKey = '';
                showPopupStatus(`Running on ${runningCount} tab${runningCount === 1 ? '' : 's'}`, {
                    kind: 'info',
                    source: 'queue',
                    duration: 0,
                    key: `queue:all:${runningCount}`
                });
            }
        });
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

        const rows=entries.map(([tabId,job])=>({fields:[formatPopupRunningInstanceText(titleMap[tabId]||'ChatGPT',job)],flags:Number(!!job.isPaused)}));
        renderNative(3,runningInstancesList,rows,rows.length,(action,index)=>{
            const entry=entries[index];if(!entry)return;
            const [tabId]=entry;
            const tabTitle=titleMap[tabId]||'ChatGPT';
            if(action===7){
                chrome.runtime.sendMessage({action:'retryPausedJob',tabId:Number(tabId)},response=>{
                    if(response?.ok)showTempStatus(`Retry requested for "${tabTitle}".`);
                    else showErrorStatus(response?.error||'Could not retry paused queue.');
                    refreshRunningJobsStatus();
                });
            }else if(action===8){
                chrome.runtime.sendMessage({action:'stopSequence',tabId:Number(tabId)},()=>{
                    showTempStatus(`Stop requested for "${tabTitle}".`);refreshRunningJobsStatus();
                });
            }
        });
        if(stopAllInstancesButton)stopAllInstancesButton.style.display=entries.length?'block':'none';
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
                showErrorStatus('Copy failed. Please try again.', 'copy-prompt-error');
            }
        });
    }

    function parseImportedSequence(rawText) {
        return ui.importSequence(String(rawText||''));
    }

    function getUniqueSequenceName(baseName) {
        return globalThis.CpoQueueEngine.sequenceName(baseName,Object.keys(savedSequences));
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
                showErrorStatus(
                    'Import failed. Clipboard must contain a JSON object with name/messages, a JSON array of strings, or one message per line.',
                    'import-sequence-error'
                );
                return;
            }

            let sequenceName = importedSequence.name;

            if (!sequenceName) {
                sequenceName = prompt('Enter a name for this imported sequence:', 'Imported sequence');

                if (sequenceName === null) return;
            }

            const finalName = getUniqueSequenceName(sequenceName);
            if(finalName==null){showErrorStatus('Native sequence name generation unavailable.');return;}

            messages = importedSequence.messages;
            if(ui.savedSequence(0,savedSequences,finalName,messages)?.ok!==true){showErrorStatus('Could not save sequence.');return;}

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

    async function loadQueueSettings() {
        await globalThis.CpoQueueEngine?.load();
        if (!queueDeepResearchAware || !queueUnlimitedRetryWait || !queueDeliveryTimeoutRefresh) {
            return;
        }

        chrome.storage.sync.get(
            {
                queueDeepResearchAware: true,
                queueUnlimitedRetryWait: false,
                queueDeliveryTimeoutRefresh: true
            },
            function (config) {
                config=globalThis.CpoQueueEngine?.settings(config,'queue')??config;
                queueDeepResearchAware.checked = config.queueDeepResearchAware !== false;
                queueUnlimitedRetryWait.checked = config.queueUnlimitedRetryWait === true;
                queueDeliveryTimeoutRefresh.checked = config.queueDeliveryTimeoutRefresh !== false;
            }
        );
    }

    async function saveQueueSettings() {
        if (!queueDeepResearchAware || !queueUnlimitedRetryWait || !queueDeliveryTimeoutRefresh) {
            return;
        }

        await setSyncStorage({
            queueDeepResearchAware: queueDeepResearchAware.checked,
            queueUnlimitedRetryWait: queueUnlimitedRetryWait.checked,
            queueDeliveryTimeoutRefresh: queueDeliveryTimeoutRefresh.checked
        });

        showTempStatus('Queue settings saved.');
    }

    async function loadOptimizerSettings() {
        await globalThis.CpoQueueEngine?.load();
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
                autoScroll: true,
                offscreenRendering: false,
                adaptiveBudget: false,
                resourceBudget: 8000,
                evictPausedMedia: false,
                inactiveTabMinutes: 0
            },
            async function (config) {
                config=globalThis.CpoQueueEngine?.settings(config)??config;
                optimizerWindowSize.value = config.windowSize;
                optimizerBatchSize.value = config.batchSize;
                optimizerAutoScroll.checked = config.autoScroll;
                if (optimizerOffscreen) optimizerOffscreen.checked = config.offscreenRendering === true;
                if (optimizerAdaptive) optimizerAdaptive.checked = config.adaptiveBudget === true;
                if (optimizerEvictMedia) optimizerEvictMedia.checked = config.evictPausedMedia === true;
                if (optimizerResourceBudget) optimizerResourceBudget.value = String(config.resourceBudget || 8000);
                if (optimizerIdleMinutes) optimizerIdleMinutes.value = String(config.inactiveTabMinutes || 0);

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
        return globalThis.CpoBrowserApi.invoke('syncSet',items);
    }

    async function scheduleOptimizerAutoSave() {
        clearTimeout(optimizerAutoSaveTimer);

        optimizerAutoSaveTimer = setTimeout(async function () {
            if (!optimizerWindowSize || !optimizerBatchSize || !optimizerAutoScroll) return;

            const newConfig = {
                windowSize: parseInt(optimizerWindowSize.value, 10),
                batchSize: parseInt(optimizerBatchSize.value, 10),
                autoScroll: optimizerAutoScroll.checked,
                offscreenRendering: optimizerOffscreen?.checked === true,
                adaptiveBudget: optimizerAdaptive?.checked === true,
                evictPausedMedia: optimizerEvictMedia?.checked === true,
                resourceBudget: Math.max(1000, Math.min(1000000, Number(optimizerResourceBudget?.value) || 8000)),
                inactiveTabMinutes: Number(optimizerIdleMinutes?.value || 0)
            };

            if (!Number.isFinite(newConfig.windowSize)) {
                newConfig.windowSize = 50;
            }

            if (!Number.isFinite(newConfig.batchSize)) {
                newConfig.batchSize = 25;
            }

            Object.assign(newConfig,globalThis.CpoQueueEngine?.settings(newConfig)??{});
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
        return globalThis.CpoBrowserApi.invoke('tabSend',tabId,message);
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

                // Firefox MV2 accepts one script file per legacy injection.
                for (const file of ['rust-queue-bridge.js', 'rust-browser-bindings.js', 'rust-browser-bridge.js', 'content.js']) {
                    await executeScript({ target: { tabId }, files: [file] });
                }

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
        const lines=requirePopupNative(globalThis.CpoQueueEngine?.popupStats?.(cleanTabTitle(tab.title),response));
        renderNative(5,optimizerStats,lines.map(line=>({fields:[line]})));
    }

    if (optimizerIdleMinutes) optimizerIdleMinutes.addEventListener('change', scheduleOptimizerAutoSave);
    if (optimizerOffscreen) optimizerOffscreen.addEventListener('change', scheduleOptimizerAutoSave);
    if (optimizerEvictMedia) optimizerEvictMedia.addEventListener('change', scheduleOptimizerAutoSave);
    if (optimizerAdaptive) optimizerAdaptive.addEventListener('change', scheduleOptimizerAutoSave);
    if (optimizerResourceBudget) optimizerResourceBudget.addEventListener('change', scheduleOptimizerAutoSave);

    if (optimizerHistory) optimizerHistory.addEventListener('click', async () => {
        try {
            const tab = await getOptimizerTargetTab();
            if (tab?.incognito) throw new Error('Local history is unavailable for private tabs.');
            if (tab?.id && !tab.discarded) await ensureOptimizerContentScript(tab.id);
            const url = chrome.runtime.getURL('history-viewer.html') + (tab?.id ? '?tab=' + encodeURIComponent(tab.id) : '');
            await globalThis.CpoBrowserApi.invoke('tabCreate',{url,active:true});
        } catch (error) {
            setOptimizerStatus(error?.message || 'Could not open local history reader.', 'disabled');
        }
    });

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

    // React to tab changes instead of enumerating every browser tab every
    // three seconds. Keep a slower fallback for missed browser events.
    let targetTabsRefreshTimer = null;
    const refreshTabsAfterEvent = () => {
        clearTimeout(targetTabsRefreshTimer);
        targetTabsRefreshTimer = setTimeout(() => {
            if (document.hidden) return;
            refreshTargetTabs();
            refreshScheduledTargetTabs();
        }, 200);
    };
    for (const event of [
        chrome.tabs?.onCreated,
        chrome.tabs?.onRemoved,
        chrome.tabs?.onUpdated,
        chrome.tabs?.onActivated
    ]) {
        event?.addListener?.(refreshTabsAfterEvent);
    }
    setInterval(function () {
        if (document.hidden) return;
        refreshTargetTabs();
        refreshScheduledTargetTabs();
        // Queue-state changes normally arrive via chrome.storage.onChanged.
        // This is a low-frequency recovery refresh.
        refreshRunningJobsStatus();
        if (optimizerToolPanel && optimizerToolPanel.classList.contains('active')) {
            refreshOptimizerStatus();
        }
    }, 15000);
});
