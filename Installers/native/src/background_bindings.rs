//! Build-generated background worker browser-effect adapter.
//! Queue storage and dispatch, processing ownership, response confirmation,
//! checkpoint revisions and authorization policy execute in Rust/WASM.
use super::Result;
use std::{fs,path::Path};
pub const OUTPUT:&str="background.js";
pub fn generate(stage:&Path)->Result<()>{
    fs::write(stage.join(OUTPUT),String::from("// @generated Rust background worker host. DO NOT EDIT.\n")+HOST)?;
    println!("Generated {OUTPUT} from Rust background controller");
    Ok(())
}
const HOST:&str=r####"// Ephemeral one-use click grants; never persisted or transferred between jobs.
const nativeClickGrants = new Map();
function grantControl(op,tabId=0,lease=0,flags=0,now=Date.now()){
    return globalThis.CpoQueueEngine?.numeric('cpo_background_grant',[op,tabId,lease,flags,now])??0;
}
function revokeClickGrant(tabId){
    if(tabId==null){nativeClickGrants.clear();grantControl(4);}
    else{nativeClickGrants.delete(tabId);grantControl(3,tabId);}
}
const restoreControl=(op,token=0)=>globalThis.CpoQueueEngine?.call('cpo_background_restore',[op,token])??0;
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
const QUEUE_WAKE_ALARM_NAME = 'queue-wake';
const QUEUE_WAKE_ALARM_PERIOD_MINUTES = 0.5;
const QUEUE_STATE_COALESCE_DELAY_MS = 50;
const QUEUE_LOG_COALESCE_DELAY_MS = 50;
const SCHEDULED_MESSAGES_KEY = 'scheduledMessages';
const SCHEDULED_ALARM_PREFIX = 'scheduled-msg:';
// Chrome alarms may fire late, but a scheduled message must never be delivered early.
const SCHEDULED_DUE_SKEW_MS = 0;


const IDLE_DISCARD_ALARM_NAME = 'cpo-idle-tab-discard';
const IDLE_DISCARD_PERIOD_MINUTES = 1;
const ALLOWED_IDLE_DISCARD_MINUTES = new Set([15, 30, 60]);

function isIdleDiscardCandidate(tab, minutes, now = Date.now()) {
    const native = globalThis.CpoQueueEngine?.tabDiscard(tab,0,0,minutes,now,getActiveProviderAdapter(tab?.url || '')?.id);
    return native === 1;
}

// Explicit user request from the extension's local reader, not from a web page.
async function discardHistorySource(request, sender) {
    if(!await globalThis.CpoQueueEngine?.load())return {ok:false,error:'Native tab safety engine unavailable.'};
    if (typeof chrome.tabs.discard !== 'function' ||
        typeof sender?.url !== 'string' || sender.url.split('?')[0] !== chrome.runtime.getURL('history-viewer.html')) {
        return { ok: false, error: 'Tab unloading is unavailable from this context.' };
    }
    const tabId = Number(request.tabId);
    const expectedUrl = request.expectedUrl;
    const expectedIdentity = request.expectedIdentity;
    if (!Number.isSafeInteger(tabId) || tabId <= 0 || typeof expectedUrl !== 'string' ||
        typeof expectedIdentity !== 'string' || !expectedIdentity ||
        getActiveProviderAdapter(expectedUrl)?.id !== 'chatgpt') {
        return { ok: false, error: 'Invalid source conversation.' };
    }
    const safeTab = tab => !!tab && tab.id === tabId && tab.url === expectedUrl &&
        (globalThis.CpoQueueEngine?.tabDiscard(tab,0,1,0,Date.now(),'chatgpt') ?? 0) === 1 &&
        tab.active === false && tab.highlighted !== true && tab.discarded !== true &&
        tab.pinned !== true && tab.audible !== true && tab.incognito !== true &&
        tab.autoDiscardable !== false && tab.status === 'complete';
    async function noWork() {
        const [stored, scheduled] = await Promise.all([
            readLocalStorage([QUEUE_DURABLE_STATE_KEY]), readScheduledMessages()
        ]);
        return !jobs.has(tabId) && !stored[QUEUE_DURABLE_STATE_KEY]?.[tabId] &&
            !scheduled.some(item => Number(item.tabId) === tabId &&
                (item.status === 'pending' || item.status === 'firing'));
    }
    try {
        const before = await getTab(tabId);
        if (!safeTab(before) || !await noWork()) return { ok: false, error: 'Source tab is active, protected, or has queue work.' };
        const identity = await sendTabMessage(tabId, { type: 'GET_CONVERSATION_IDENTITY' });
        if (identity?.identity?.key !== expectedIdentity) return { ok: false, error: 'Source conversation changed.' };
        const safe = await sendTabMessage(tabId, { type: 'CAN_DISCARD_INACTIVE_TAB' });
        if (!safe?.safe || !await noWork()) return { ok: false, error: 'Source has a draft, active response, upload, media, or pending work.' };
        const after = await getTab(tabId);
        const approved = globalThis.CpoQueueEngine?.tabDiscard(after,1,1,0,Date.now(),'chatgpt',jobs.has(tabId),
            before.lastAccessed === after?.lastAccessed && after?.url === expectedUrl, safe?.safe === true);
        if (approved !== 1 || !safeTab(after) || before.lastAccessed !== after.lastAccessed || jobs.has(tabId)) {
            return { ok: false, error: 'Source tab state changed.' };
        }
        const discarded = await globalThis.CpoBrowserApi.invoke('tabDiscard',tabId);
        const verified = discarded?.discarded === true || (await getTab(tabId))?.discarded === true;
        return verified ? { ok: true } : { ok: false, error: 'Browser did not confirm that the tab was discarded.' };
    } catch {
        return { ok: false, error: 'Unable to verify or discard the source tab.' };
    }
}

function configureIdleDiscardAlarm(minutes) {
    if (!chrome.alarms) return;
    chrome.alarms.clear(IDLE_DISCARD_ALARM_NAME);
    if ((globalThis.CpoQueueEngine?.call('cpo_tab_alarm',[Number(minutes)]) ?? 0) === 1) {
        chrome.alarms.create(IDLE_DISCARD_ALARM_NAME, { periodInMinutes: IDLE_DISCARD_PERIOD_MINUTES });
    }
}

async function discardInactiveChatGPTTabs() {
    await globalThis.CpoQueueEngine?.load();
    // Settings and queue-state read failures abort this sweep rather than risk work.
    const settings = await readSyncStorage({ inactiveTabMinutes: 0 });
    const minutes = Number(settings.inactiveTabMinutes || 0);
    if (!ALLOWED_IDLE_DISCARD_MINUTES.has(minutes) || typeof chrome.tabs.discard !== 'function') return 0;
    const [tabs, stored, scheduled] = await Promise.all([
        queryTabs({}),
        readLocalStorage([QUEUE_DURABLE_STATE_KEY]),
        readScheduledMessages()
    ]);
    const durable = stored[QUEUE_DURABLE_STATE_KEY] || {};
    let count = 0;
    for (const tab of tabs) {
        if (!isIdleDiscardCandidate(tab, minutes)) continue;
        if (jobs.has(tab.id) || durable[tab.id]) continue;
        if (scheduled.some(item => Number(item.tabId) === tab.id &&
            (item.status === 'pending' || item.status === 'firing'))) continue;
        try {
            const before = await getTab(tab.id);
            if (!isIdleDiscardCandidate(before, minutes)) continue;
            // A missing, outdated, or unresponsive content script is unsafe.
            const reply = await sendTabMessage(tab.id, { type: 'CAN_DISCARD_INACTIVE_TAB' });
            if (!reply?.safe) continue;
            const [latest, upcoming] = await Promise.all([
                readLocalStorage([QUEUE_DURABLE_STATE_KEY]),
                readScheduledMessages()
            ]);
            if (jobs.has(tab.id) || latest[QUEUE_DURABLE_STATE_KEY]?.[tab.id] ||
                upcoming.some(item => Number(item.tabId) === tab.id &&
                    (item.status === 'pending' || item.status === 'firing'))) continue;
            const after = await getTab(tab.id);
            const approved = globalThis.CpoQueueEngine?.tabDiscard(after,1,0,minutes,Date.now(),
                getActiveProviderAdapter(after?.url || '')?.id,jobs.has(tab.id),
                before.lastAccessed === after?.lastAccessed && before.url === after?.url,reply?.safe === true);
            if (approved !== 1 || !isIdleDiscardCandidate(after, minutes) ||
                before.lastAccessed !== after.lastAccessed || before.url !== after.url || jobs.has(tab.id)) continue;
            await globalThis.CpoBrowserApi.invoke('tabDiscard',tab.id);
            count++;
        } catch {
            // The tab may have changed state or disappeared during the sweep.
        }
    }
    return count;
}

function isIncompleteToolResponse(responseState = {}) {
    return responseState?.toolTurnIncomplete === true || responseState?.source === 'incomplete-tool-turn';
}

/** @type {Promise<any>} */
let scheduledStorageWrite = Promise.resolve();

if (typeof importScripts === 'function') {
    importScripts('utils.js', 'rust-queue-bridge.js', 'rust-browser-bindings.js', 'rust-browser-bridge.js');
} else if(typeof require==='function'&&!globalThis.CpoBrowserApi) {
    require('./utils.js');
}

if(typeof require==='function'&&!globalThis.CpoQueueEngine)require('./rust-queue-bridge.js');
const jobs = globalThis.CpoQueueEngine.createLiveJobs();

let providerAdapterRegistry = typeof globalThis !== 'undefined' ? globalThis.ProviderAdapterRegistry : null;
if (!providerAdapterRegistry && typeof require === 'function') {
    try {
        providerAdapterRegistry = require('./rust-browser-bridge.js');
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
    if(jobs.get(tabId)!==job)return {ok:false,reason:'Queue owner changed during conversation validation.',currentIdentity};

    if (!job.provider) {
        jobs.transaction(job,0,0,{provider:currentIdentity.provider||'chatgpt'});
    }

    if (job.rolloverInProgress) {
        const adapter = getActiveProviderAdapter(currentIdentity.provider || job.provider || 'chatgpt') || getActiveProviderAdapter('chatgpt');
        const fromId = job.rolloverFromConversationId || null;
        if (isVerifiedFreshConversation(adapter, currentIdentity, fromId, job.rolloverNavigationStarted)) {
            if (!job.rolloverRebindApplied) {
                applyAuthorizedConversationRebind(job, currentIdentity);
                await updateRunningJobsStorage({ force: true });
            } else if (job.conversationType === 'new' && currentIdentity.type === 'existing' && currentIdentity.conversationId) {
                jobs.transaction(job,0,0,{conversationId:currentIdentity.conversationId,conversationType:'existing',targetKey:currentIdentity.key,rolloverToConversationId:currentIdentity.conversationId});
                await updateRunningJobsStorage({ force: true });
            }
            return { ok: true, currentIdentity, rolloverRebind: true };
        }
        return {
            ok: false,
            awaitingRollover: true,
            reason: 'Rollover in progress; waiting for a verified new ChatGPT conversation before queue delivery resumes.',
            currentIdentity
        };
    }

    const decision=requiredQueueDecision(globalThis.CpoQueueEngine?.bindingDecision?.(job,currentIdentity));
    if(decision===3||decision===8){
        jobs.transaction(job,0,0,{provider:currentIdentity.provider||job.provider||'chatgpt',conversationId:currentIdentity.conversationId||null,conversationType:currentIdentity.type,targetKey:currentIdentity.key});
        await updateRunningJobsStorage({force:true});
        return {ok:true,currentIdentity,...(decision===3?{updatedBinding:true}:{boundFromUnknown:true})};
    }
    const reasons={
        1:()=>`Provider mismatch: queue is bound to ${job.provider}, but tab is on ${currentIdentity.provider}.`,
        2:()=>`Tab navigated away from conversation to unsupported page (${currentIdentity.key||'unsupported'}). Queue paused to prevent sending into the wrong page.`,
        4:()=>`Conversation mismatch: expected new conversation, but tab is now on ${currentIdentity.type} (${currentIdentity.key}).`,
        5:()=>`Conversation mismatch: tab was navigated from conversation "${job.conversationId}" to "${currentIdentity.conversationId}". Queue paused to prevent delivering prompts into the wrong conversation.`,
        6:()=>`Conversation mismatch: tab was navigated from conversation "${job.conversationId}" to a new conversation. Queue paused to prevent delivering prompts into the wrong conversation.`,
        7:()=>`Conversation mismatch: tab was navigated away from conversation "${job.conversationId}".`
    };
    if(decision!==0)return {ok:false,reason:reasons[decision]?.()||'Native conversation binding refused.',currentIdentity};

    return { ok: true, currentIdentity };
}

function emptyRolloverFields() {
    return {
        rolloverInProgress: false,
        rolloverStage: '',
        rolloverReason: '',
        rolloverFromConversationId: null,
        rolloverToConversationId: null,
        rolloverNavigationStarted: false,
        rolloverRebindApplied: false,
        handoffSubmitted: false,
        handoffEstablished: false,
        handoffFingerprint: '',
        conversationGeneration: 0
    };
}

function copyRolloverFields(source = {}) {
    return {
        rolloverInProgress: source.rolloverInProgress === true,
        rolloverStage: String(source.rolloverStage || ''),
        rolloverReason: String(source.rolloverReason || ''),
        rolloverFromConversationId: source.rolloverFromConversationId || null,
        rolloverToConversationId: source.rolloverToConversationId || null,
        rolloverNavigationStarted: source.rolloverNavigationStarted === true,
        rolloverRebindApplied: source.rolloverRebindApplied === true,
        handoffSubmitted: source.handoffSubmitted === true,
        handoffEstablished: source.handoffEstablished === true,
        handoffFingerprint: String(source.handoffFingerprint || ''),
        conversationGeneration: Number(source.conversationGeneration || 0)
    };
}

function isConversationCapacityFailure(result) {
    if (!result) return false;
    const details = result.details && typeof result.details === 'object' ? result.details : {};
    const state = details.state && typeof details.state === 'object' ? details.state : {};
    if (details.failureClass === 'conversation-max-length') return true;
    if (details.conversationCapacityReached === true || details.requiresNewConversation === true) return true;
    if (state.conversationCapacityReached === true || state.requiresNewConversation === true) return true;
    if (result.responseState?.source === 'conversation-max-length' || details.responseState?.source === 'conversation-max-length') {
        return true;
    }
    return /conversation-max-length|maximum length for this conversation/i.test(String(result.error || details.error || ''));
}

function applyAuthorizedConversationRebind(job, identity) {
    if (!job || !identity) return job;
    const provider=identity.provider||job.provider||'chatgpt';
    const conversationId=identity.conversationId||null;
    const conversationType=identity.type||(conversationId?'existing':'new');
    jobs.transaction(job,9,0,{provider,conversationId,conversationType,targetKey:normalizedIdentityKey(provider,conversationType,conversationId,identity.key)});
    return job;
}

function requiredQueueDecision(value) {
    if(value==null)throw new Error('Required native queue decision unavailable.');
    return value;
}

function isVerifiedFreshConversation(adapter, identity, fromConversationId, navigationStarted) {
    const kind = identity?.type === 'existing' ? 1 : identity?.type === 'new' ? 2 : 0;
    const flags = Number(adapter?.id === 'chatgpt' && identity?.provider === 'chatgpt') |
        (Number(!!identity?.conversationId)<<1) | (Number(identity?.conversationId !== fromConversationId)<<2) |
        (Number(!!fromConversationId)<<3) | (Number(navigationStarted === true)<<4);
    const native = globalThis.CpoQueueEngine?.call('cpo_rollover_fresh',[kind,flags]);
    return requiredQueueDecision(native) === 1;
}

async function confirmFreshConversationIdentity(tabId, job, adapter, fromConversationId) {
    const now=Date.now();
    const deadline=requiredQueueDecision(globalThis.CpoQueueEngine?.timestampMath?.(0,now,20000));
    const pollMs = Math.max(20, Number(QUEUE_WAIT_POLICY.submissionAckPollMs) || 50);

    while (Date.now() <= deadline) {
        if (jobs.processing(job,2)!==1) {
            return { ok: false, interrupted: true, identity: null };
        }
        const identity = await resolveTabConversationIdentity(tabId);
        if (jobs.get(tabId) !== job || job.isStopped || job.isPaused || !job.isRunning) return { ok: false, interrupted: true, identity: null };
        if (isVerifiedFreshConversation(adapter, identity, fromConversationId, job.rolloverNavigationStarted)) {
            return { ok: true, identity };
        }
        await sleep(pollMs);
    }

    return { ok: false, interrupted: false, identity: await resolveTabConversationIdentity(tabId) };
}

async function handleConversationCapacityRollover(tabId, job, waitResult = {}) {
    await globalThis.CpoQueueEngine?.load();
    if (!job || jobs.get(tabId) !== job || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    const adapter = getActiveProviderAdapter(job.provider || 'chatgpt') || getActiveProviderAdapter('chatgpt');
    const startPlan = adapter && typeof adapter.startNewConversation === 'function'
        ? adapter.startNewConversation()
        : { ok: false, url: '', method: 'unsupported' };
    const newConversationUrl = startPlan?.url || (typeof adapter?.getNewConversationUrl === 'function' ? adapter.getNewConversationUrl() : '');

    const supported = !!(adapter && typeof adapter.isFreshConversationIdentity === 'function' && newConversationUrl);
    const owned = () => jobs.processing(job,2)===1;
    const rolloverNext = (stage, fresh = false, present = false) =>
        jobs.rollover(job,stage,Number(supported)|(Number(fresh)<<1)|(Number(present)<<2));
    const initialAction = rolloverNext(0);
    if (initialAction === 0) return { action: 'return' };
    if (initialAction === 1) {
        pauseJob(tabId, 'Conversation reached maximum length, but automatic rollover is unavailable for this provider.', {
            phase: 'rollover',
            failureClass: 'conversation-max-length'
        });
        return { action: 'return' };
    }

    jobs.transaction(job,12,0);
    if (initialAction === 2) {
        await updateRunningJobsStorage({ force: true });
        logQueueEvent(tabId, 'warn', 'Conversation capacity reached; starting automatic rollover.', {
            event: 'conversation-capacity-reached',
            runId: job.runId || '',
            fromConversationId: job.rolloverFromConversationId,
            conversationGeneration: Number(job.conversationGeneration || 0),
            commandNumber: job.currentCommandNumber || 0,
            completedCount: Number(job.completedCount || 0),
            remaining: getRemainingCount(job),
            currentMessageLength: String(job.currentMessage || '').length
        });
    } else {
        await updateRunningJobsStorage({ force: true });
    }

    const fromConversationId = job.rolloverFromConversationId || null;
    if (!owned()) return { action: 'return' };
    if (rolloverNext(1) === 3) {
        const currentIdentity = await resolveTabConversationIdentity(tabId);
        const alreadyFresh = isVerifiedFreshConversation(adapter, currentIdentity, fromConversationId, job.rolloverNavigationStarted);

        if (!owned()) return { action: 'return' };
        const identityAction = rolloverNext(2, alreadyFresh);
        if (identityAction === 4 || identityAction === 5) {
            if (identityAction === 4) {
                jobs.transaction(job,12,1);
                await updateRunningJobsStorage({ force: true });
                logQueueEvent(tabId, 'info', 'Opening a fresh ChatGPT conversation for rollover.', {
                    event: 'rollover-started',
                    runId: job.runId || '',
                    fromConversationId,
                    method: startPlan.method || 'route',
                    conversationGeneration: Number(job.conversationGeneration || 0)
                });
                if (!owned()) return { action: 'return' };
                await updateTabUrl(tabId, newConversationUrl);
            }

            if(!owned())return {action:'return'};
            jobs.transaction(job,12,2);
            await updateRunningJobsStorage({ force: true });

            const confirmed = await confirmFreshConversationIdentity(tabId, job, adapter, fromConversationId);
            if (confirmed.interrupted || jobs.get(tabId) !== job || job.isStopped || job.isPaused || !job.isRunning) {
                return { action: 'return' };
            }
            if (!confirmed.ok) {
                pauseJob(tabId, 'Could not confirm a fresh ChatGPT conversation after maximum-length rollover.', {
                    phase: 'rollover',
                    failureClass: 'conversation-max-length'
                });
                return { action: 'return' };
            }
            applyAuthorizedConversationRebind(job, confirmed.identity);
        } else if (identityAction === 6) {
            applyAuthorizedConversationRebind(job, currentIdentity);
        }

        await updateRunningJobsStorage({ force: true });
        logQueueEvent(tabId, 'success', 'Fresh ChatGPT conversation confirmed for rollover.', {
            event: 'new-conversation-confirmed',
            runId: job.runId || '',
            fromConversationId,
            toConversationId: job.conversationId,
            conversationType: job.conversationType,
            conversationGeneration: Number(job.conversationGeneration || 0)
        });
    }

    if (!owned()) return { action: 'return' };
    const handoffAction = rolloverNext(3);
    if (handoffAction === 7 || handoffAction === 10) {
        // A persisted checkpoint is not permission to send into a different chat.
        const validation = await validateJobTargetConversation(tabId, job);
        if (!owned()) return { action: 'return' };
        if (!validation.ok || (job.conversationId && validation.currentIdentity?.conversationId !== job.conversationId)) {
            pauseJob(tabId, 'Rollover target identity could not be verified before handoff.', { phase: 'rollover-handoff', failureClass: 'conversation-max-length' });
            return { action: 'return' };
        }
        const remainingAfterCurrent = Math.max(0, (Array.isArray(job.queue) ? job.queue.length : 0));
        const handoffText = adapter.buildContinuationHandoffMessage({
            runId: job.runId,
            currentCommandNumber: job.currentCommandNumber,
            completedCount: job.completedCount,
            remainingCount: remainingAfterCurrent,
            conversationGeneration: job.conversationGeneration,
            pendingMessageLength: String(job.currentMessage || job.queue?.[0] || '').length
        });
        const handoffFingerprint=job.handoffFingerprint||fingerprintCommandTextForJob(handoffText);

        if (handoffAction === 7) {
            const inspect = await inspectTabCommandTurns(tabId, {
                expectedText: handoffText,
                expectedFingerprint: handoffFingerprint
            });
            const alreadyPresent = !!(inspect?.snapshot?.matchedUserTurnId ||
                (inspect?.snapshot?.userTurns || []).some(turn => turn.matchedExpected));

            if(!owned())return {action:'return'};
            jobs.transaction(job,12,3,{handoffFingerprint});
            await updateRunningJobsStorage({ force: true });

            if (!owned()) return { action: 'return' };
            if (rolloverNext(4,false,alreadyPresent) === 8) {
                const beforeHandoff = await validateJobTargetConversation(tabId, job);
                if (!owned()) return { action: 'return' };
                if (!beforeHandoff.ok || (job.conversationId && beforeHandoff.currentIdentity?.conversationId !== job.conversationId)) {
                    pauseJob(tabId, 'Rollover target changed before continuation submission.', { phase: 'rollover-handoff', failureClass: 'conversation-max-length' });
                    return { action: 'return' };
                }
                const sendResult = await sendPromptToSpecificTab(tabId, handoffText, job);
                if (jobs.get(tabId) !== job || job.isStopped || job.isPaused || !job.isRunning) {
                    return { action: 'return' };
                }
                if (!sendResult.ok) {
                    pauseJob(tabId, sendResult.error || 'Could not establish continuation handoff in the new conversation.', {
                        phase: 'rollover-handoff',
                        failureClass: sendResult.details?.failureClass || 'conversation-max-length'
                    });
                    return { action: 'return' };
                }
            }

            if(!owned())return {action:'return'};
            jobs.transaction(job,12,4);
            await updateRunningJobsStorage({ force: true });
        }

        const queueSettings = await getQueueSettings();
        const handoffWait = await waitForTabResponse(tabId, {
            waitForExistingGeneration: true,
            commandNumber: 0,
            totalMessages: getTotalMessages(job),
            queueSettings,
            maxWaitMs: Math.min(Number(QUEUE_WAIT_POLICY.responseMaxWaitMs) || 60000, 60000),
            checkIntervalMs: Number(QUEUE_WAIT_POLICY.checkIntervalMs) || 1000
        });
        if (jobs.get(tabId) !== job || job.isStopped || job.isPaused || !job.isRunning) {
            return { action: 'return' };
        }
        if (!handoffWait.ok && !isConversationCapacityFailure(handoffWait)) {
            pauseJob(tabId, handoffWait.error || 'Continuation handoff did not complete in the new conversation.', {
                phase: 'rollover-handoff',
                failureClass: handoffWait.details?.failureClass || 'conversation-max-length'
            });
            return { action: 'return' };
        }

        jobs.transaction(job,12,5);
        await updateRunningJobsStorage({ force: true });
        logQueueEvent(tabId, 'success', 'Continuation handoff established in the new conversation.', {
            event: 'handoff-established',
            runId: job.runId || '',
            conversationGeneration: Number(job.conversationGeneration || 0),
            handoffLength: String(handoffText || '').length,
            completedCount: Number(job.completedCount || 0)
        });
    }

    if (!owned() || rolloverNext(3) !== 11) return { action: 'return' };
    const preservedCommandNumber = Number(job.currentCommandNumber || 0);
    jobs.transaction(job,12,6);
    await updateRunningJobsStorage({ force: true });
    logQueueEvent(tabId, 'success', 'Queue resumed after conversation rollover.', {
        event: 'queue-resumed-after-rollover',
        runId: job.runId || '',
        conversationId: job.conversationId,
        conversationGeneration: Number(job.conversationGeneration || 0),
        completedCount: Number(job.completedCount || 0),
        remaining: getRemainingCount(job),
        nextCommandNumber: preservedCommandNumber || (Number(job.completedCount || 0) + 1)
    });

    return { action: 'continue' };
}

let queueStateWrite = Promise.resolve();
let queueStateFlushTimer = null;
let queueLogWrite = Promise.resolve();
let pendingQueueLogEntries = [];
let queueLogFlushTimer = null;
let queueLogGeneration = 0;

globalThis.CpoBrowserApi.listen(
    /**
     * @param {RuntimeMessageRequest} request
     * @param {chrome.runtime.MessageSender} sender
     * @param {(response?: RuntimeMessageResponse) => void} sendResponse
     */
    async (request, sender, sendResponse) => {
        const engine=globalThis.CpoQueueEngine;
        const ready=await engine?.load();
        let code=ready?engine.eventCode(1,request?.action):null;
        if(code==null){
            // Cancellation/status must remain possible during an engine outage.
            code=({stopSequence:6,stopAllSequences:7,getRunningJobs:8,getQueueDebugLogs:9,clearQueueDebugLogs:10})[request?.action]||0;
        }
        if (code === 1) {
            const tabId=sender?.tab?.id;
            const grant=nativeClickGrants.get(tabId);
            const flags=Number(!!grant&&grant.token===request.token)|
                (Number(!!grant&&(!grant.job||jobs.processing(grant.job,2)===1))<<1);
            const ok=!!grant&&grantControl(1,tabId,grant.lease,flags)===1;
            sendResponse({ok});
            return true;
        }

        if (code === 2) {
            discardHistorySource(request, sender).then(sendResponse, () =>
                sendResponse({ ok: false, error: 'Source tab unloading failed.' }));
            return true;
        }

        if (code === 3) {
            handleStartSequence(request, sendResponse);
            return true;
        }

        if (code === 4) {
            handleEnqueueMessage(request, sender, sendResponse);
            return true;
        }

        if (code === 5) {
            handleRetryPausedJob(request, sendResponse);
            return true;
        }

        if (code === 6) {
            handleStopSequence(request, sendResponse);
            return true;
        }

        if (code === 7) {
            handleStopAllSequences(sendResponse);
            return true;
        }

        if (code === 8) {
            if(!jobs.canPersist()){
                const stored=await readLocalStorage(['runningJobs']);
                sendResponse({ok:true,jobs:stored.runningJobs||{},nativeUnavailable:true});
            }else sendResponse({ok:true,jobs:getRunningJobsSnapshot()});
            return true;
        }

        if (code === 9) {
            handleGetQueueDebugLogs(sendResponse);
            return true;
        }

        if (code === 10) {
            handleClearQueueDebugLogs(sendResponse);
            return true;
        }

        if (code === 11) {
            handleLogAutomationEvent(request, sendResponse);
            return true;
        }

        if (code === 12) {
            handleScheduleMessage(request, sendResponse);
            return true;
        }

        if (code === 13) {
            handleListScheduledMessages(sendResponse);
            return true;
        }

        if (code === 14) {
            handleCancelScheduledMessage(request, sendResponse);
            return true;
        }

        if (code === 15) {
            handleDeleteScheduledMessage(request, sendResponse);
            return true;
        }

        if (code === 16) {
            handleRetryScheduledMessage(request, sendResponse);
            return true;
        }

        sendResponse({ok:false,error:'Unknown action or required Rust event router unavailable.'});
        return true;
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
            inactiveTabMinutes: undefined,
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

            if (!ALLOWED_IDLE_DISCARD_MINUTES.has(Number(data.inactiveTabMinutes)) &&
                data.inactiveTabMinutes !== 0) {
                defaults.inactiveTabMinutes = 0;
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
    revokeClickGrant(tabId);
    if(!jobs.canPersist()){
        if(jobs.has(tabId))emergencyStopQueues(tabId);
        return;
    }
    if ((globalThis.CpoQueueEngine?.call('cpo_tab_close_action',[Number(jobs.has(tabId))]) ?? Number(jobs.has(tabId))) === 1) {
        const job = jobs.get(tabId);
        logQueueEvent(tabId, 'warn', 'ChatGPT tab closed while queue was active.', {
            completedCount: job?.completedCount || 0,
            totalMessages: getTotalMessages(job),
            remaining: getRemainingCount(job)
        });
        if (job) { job.isStopped = true; job.isRunning = false; }
        jobs.delete(tabId);
        updateRunningJobsStorage({ force: true });
    }
});

if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || !alarm.name) return;

        if (alarm.name === IDLE_DISCARD_ALARM_NAME) {
            discardInactiveChatGPTTabs().catch(error => {
                console.warn('Inactive-tab sweep failed:', error);
            });
            return;
        }

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

if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.inactiveTabMinutes) {
            configureIdleDiscardAlarm(changes.inactiveTabMinutes.newValue);
        }
    });
}
readSyncStorage({ inactiveTabMinutes: 0 })
    .then(config => configureIdleDiscardAlarm(config.inactiveTabMinutes))
    .catch(() => configureIdleDiscardAlarm(0));

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
    if(!await globalThis.CpoQueueEngine?.load())return 0;
    if (jobs.size > 0) {
        updateQueueWakeAlarm(true);

        for (const job of jobs.values()) {
            if (jobs.processing(job,4)===1) {
                processQueue(job.tabId);
            }
        }

        return 0;
    }

    const lease=restoreControl(0);
    if(!lease)return 0;
    try{
    await queueStateWrite;
    if(restoreControl(1,lease)!==1)return 0;
    const data = await readLocalStorage([QUEUE_DURABLE_STATE_KEY]);
    if(restoreControl(1,lease)!==1)return 0;
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
    }finally{restoreControl(2,lease);}
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
        const decoded = globalThis.CpoQueueEngine?.deserializeDurable(rawJob, Date.now(), createRunId);
        if(decoded==null)throw new Error('Native durable restoration unavailable; stored jobs preserved.');
        if(!decoded.ok){console.warn('CPO: durable queue restore skipped:',decoded.error);continue;}
        const job=decoded.value;
        const tabId = job.tabId;
        if (jobs.has(tabId)||restoredJobs.some(existing=>existing.job.tabId===tabId)) continue;

        job.totalMessages = getTotalMessages(job);

        // Native deserialization already reconciles the restored command number.

        const confirmed = isSubmissionConfirmed(job);
        const restoreAction = globalThis.CpoQueueEngine?.restoreAction(job, confirmed);
        if(restoreAction==null)throw new Error('Native recovery classification unavailable.');
        if (restoreAction === 2) {
            // The published native job applies this recovery transition.
        } else if (restoreAction === 1) {
            logQueueEvent(tabId, 'info', 'Recovered a command with confirmed submission; resuming wait instead of resending.', {
                phase: job.currentPhase,
                commandNumber: job.currentCommandNumber || 0,
                totalMessages: getTotalMessages(job),
                ...collectDeliveryDiagnostics(job)
            });
        } else if (restoreAction === 3) {
            logQueueEvent(tabId, 'warn', 'Recovered a command that was not confirmed submitted; retrying it.', {
                phase: job.currentPhase,
                commandNumber: job.currentCommandNumber || 0,
                totalMessages: getTotalMessages(job),
                ...collectDeliveryDiagnostics(job)
            });
        }

        restoredJobs.push({job,restoreAction});
    }
    // Publish the reconstructed jobs only after the entire decode succeeds.
    const published=[];
    try{
        for(const {job,restoreAction} of restoredJobs){
            jobs.set(job.tabId,job);
            const owner=jobs.get(job.tabId);
            published.push(owner);
            if(restoreAction)jobs.transaction(owner,11,restoreAction);
        }
    }catch(error){
        for(const job of published){
            // On a trapped store the host handle can still be revoked.
            for(const [tabId,owner] of jobs.entries())if(owner===job)jobs.delete(tabId);
        }
        throw error;
    }
    return published;
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
        const targetKey = normalizedIdentityKey(provider,conversationType,conversationId,identity?.key);

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
            ...emptyRolloverFields(),
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
    jobs.transaction(existingJob,2,Number(addToEnd),{currentMessage:message});
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
    jobs.transaction(existingJob,2,Number(addToEnd),{currentMessage:message});

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
    const targetKey = normalizedIdentityKey(provider,conversationType,conversationId,identity?.key);

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
        ...emptyRolloverFields(),
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

    jobs.transaction(job,5);

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

// An unavailable native engine cannot publish a live snapshot. Explicit
// cancellation is still permitted by deleting only the requested persisted
// records, after earlier writes settle. Never replay or reconstruct prompts here.
function emergencyStopQueues(tabId, sendResponse=()=>{}) {
    const all=tabId==null;
    const found=all?jobs.size>0:jobs.has(tabId);
    restoreControl(3);
    if(all){
        revokeClickGrant(null);
        jobs.clear();
    }else{
        revokeClickGrant(tabId);
        jobs.delete(tabId);
    }
    globalThis.CpoQueueEngine?.numeric('cpo_background_checkpoint',[5,0]);
    if(queueStateFlushTimer!==null){
        clearTimeout(queueStateFlushTimer);
        queueStateFlushTimer=null;
    }
    const operation=queueStateWrite.catch(()=>{}).then(async()=>{
        const stored=await readLocalStorage([QUEUE_DURABLE_STATE_KEY,'runningJobs']);
        const durable={...(stored[QUEUE_DURABLE_STATE_KEY]||{})};
        const running={...(stored.runningJobs||{})};
        const existed=found||Object.hasOwn(durable,tabId)||Object.hasOwn(running,tabId);
        if(all){
            for(const key of Object.keys(durable))delete durable[key];
            for(const key of Object.keys(running))delete running[key];
        }else{
            delete durable[tabId];
            delete running[tabId];
        }
        if(!all&&!existed)return {ok:false,error:'No running or paused queue found for this tab.'};
        const isRunning=Object.keys(durable).length>0||Object.keys(running).length>0;
        await writeLocalStorage({[QUEUE_DURABLE_STATE_KEY]:durable,runningJobs:running,isRunning});
        updateQueueWakeAlarm(isRunning);
        return all?{ok:true,stopped:'all'}:{ok:true,stopped:'selected',tabId};
    });
    queueStateWrite=operation.catch(error=>{console.warn('Emergency queue cancellation failed:',error);});
    operation.then(sendResponse,error=>sendResponse({ok:false,error:String(error?.message||error)}));
}

function handleStopSequence(request, sendResponse) {
    const tabId = request.tabId;
    if(tabId&&(!jobs.canPersist()||(!jobs.has(tabId)&&restoreControl(4)===1))){emergencyStopQueues(tabId,sendResponse);return;}

    if (tabId && jobs.has(tabId)) {
        revokeClickGrant(tabId);
        const job = jobs.get(tabId);
        job.isRunning = false;
        job.isPaused = false;
        job.isStopped = true;

        logQueueEvent(tabId, 'warn', 'Queue stopped manually.', {
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job),
            remaining: getRemainingCount(job),
            currentCommandNumber: job.currentCommandNumber || 0,
            ...getQueueFailureDiagnostics(job, job.currentPhase, {}, 'cancelled')
        });

        jobs.delete(tabId);
        updateRunningJobsStorage({ force: true });

        sendResponse({ ok: true, stopped: 'selected', tabId });
        return;
    }

    sendResponse({ ok: false, error: 'No running or paused queue found for this tab.' });
}

function handleStopAllSequences(sendResponse) {
    if(!jobs.canPersist()||restoreControl(4)===1){emergencyStopQueues(null,sendResponse);return;}
    revokeClickGrant(null);
    for (const [tabId, job] of jobs.entries()) {
        job.isRunning = false;
        job.isPaused = false;
        job.isStopped = true;
        logQueueEvent(tabId, 'warn', 'Queue stopped by Stop all.', {
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job),
            remaining: getRemainingCount(job),
            currentCommandNumber: job.currentCommandNumber || 0,
            ...getQueueFailureDiagnostics(job, job.currentPhase, {}, 'cancelled')
        });
        jobs.delete(tabId);
    }

    updateRunningJobsStorage({ force: true });
    sendResponse({ ok: true, stopped: 'all' });
}

function queueExecutionAction(job) {
    const native = globalThis.CpoQueueEngine?.next(job, isSubmissionConfirmed(job));
    if (native == null) throw new Error('Required Rust queue dispatcher unavailable.');
    return native;
}

async function processQueue(tabId) {
    const job = jobs.get(tabId);

    if(!job||jobs.processing(job,0)!==1)return;

    try {
        // The native engine selects the next action from durable job state.
        // JavaScript performs asynchronous browser and storage effects only.
        if(!await globalThis.CpoQueueEngine?.load()) {
            pauseJob(tabId,'Required Rust queue engine unavailable. Rebuild and reinstall the extension.',{failureClass:'non-retryable'});
            return;
        }
        while (jobs.get(tabId) === job) {
            const action = queueExecutionAction(job);
            if (action === 0 || action === 7) break;
            if (action === 1) {
                const result = await handleConversationCapacityRollover(tabId, job);
                if (result.action === 'return') return;
                if (result.action === 'continue') continue;
                throw new Error('Unexpected rollover result.');
            }
            if (action === 2) {
                completeCurrentCommand(tabId, job, getTotalMessages(job), collectDeliveryDiagnostics(job, {
                    terminalAckSource: job.terminalAckSource || 'durable-recovery'
                }));
                if (job.queue.length > 0) await sleep(Number(QUEUE_WAIT_POLICY.interCommandDelayMs) || 0);
                continue;
            }
            if (action === 3 || action === 4 || action === 5) {
                if (action === 5) job.currentPhase = 'awaiting-response';
                const result = action === 4 ? await handleProcessRetryWait(tabId, job) :
                    await handleProcessWaiting(tabId, job);
                if (result.action === 'return') return;
                if (result.action === 'continue') continue;
                throw new Error('Unexpected response or retry result.');
            }
            if (action === 6) {
                handleProcessRecovered(tabId, job);
                continue;
            }
            if (action !== 8 && action !== 9) throw new Error('Unknown queue execution action.');
            const validation = await validateJobTargetConversation(tabId, job);
            if (!validation.ok) {
                if (validation.awaitingRollover || job.rolloverInProgress) {
                    const rolloverResult = await handleConversationCapacityRollover(tabId, job);
                    if (rolloverResult.action === 'return') return;
                    if (rolloverResult.action === 'continue') continue;
                }
                logQueueEvent(tabId, 'error', validation.reason, { phase: 'pre-send-validation', mismatch: true });
                pauseJob(tabId, validation.reason, { phase: 'pre-send-validation', mismatch: true });
                return;
            }
            // Recheck ownership after asynchronous validation, before a send.
            if (jobs.processing(job,2)!==1) return;
            const result = action === 8 ? await handleProcessWaitForIdle(tabId, job) :
                await handleProcessSending(tabId, job);
            if (result.action === 'return') return;
            if (result.action === 'continue' || result.action === 'next') continue;
            throw new Error('Unexpected queue effect result.');
        }

        if (jobs.get(tabId) !== job) return;
        const completion=jobs.processing(job,3);
        if (completion===1) {
            jobs.delete(tabId);
            updateRunningJobsStorage({ force: true });
            return;
        }

        if (completion===2) {
            logQueueEvent(tabId, 'success', 'Queue completed.', {
                completedCount: job.completedCount || 0,
                totalMessages: getTotalMessages(job)
            });
            jobs.delete(tabId);
            updateRunningJobsStorage({ force: true });
            recordCompletedRun(tabId);
        }
    } catch (error) {
        if (jobs.get(tabId) !== job) return;
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
        if (jobs.get(tabId)===job&&jobs.canPersist())jobs.processing(job,1);
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
        if (isConversationCapacityFailure(waitResult)) {
            return await handleConversationCapacityRollover(tabId, job, waitResult);
        }

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

    jobs.transaction(job,10);
    updateRunningJobsStorage({ force: true });
    return { action: 'continue' };
}

async function handleProcessRetryWait(tabId, job) {
    const retryNow=Date.now();
    const remainingMs=requiredQueueDecision(globalThis.CpoQueueEngine?.timestampMath?.(2,Number(job.nextRetryAt||0),retryNow));
    const interrupted = await interruptibleSleep(tabId, job, remainingMs);

    if (interrupted || !jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    jobs.transaction(job,6);
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
    const prompt=job.queue[0];
    const number=Number(job.completedCount||0)+1;
    jobs.transaction(job,7,0,{currentMessage:prompt,commandId:`${job.runId||'run'}:${number}`,commandFingerprint:fingerprintCommandTextForJob(prompt)});
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

    const sendResult = await sendPromptToSpecificTab(tabId, job.currentMessage, job);

    if (jobs.get(tabId) !== job || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    if (!sendResult.ok) {
        if (isConversationCapacityFailure(sendResult)) {
            return await handleConversationCapacityRollover(tabId, job, sendResult);
        }

        logQueueEvent(tabId, 'error', `Failed to submit command ${job.currentCommandNumber}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber,
            totalMessages,
            error: sendResult.error || 'Could not send message to ChatGPT.',
            ...getQueueFailureDiagnostics(job, 'send', sendResult.details, 'retry-or-pause'),
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

    jobs.transaction(job,0,0,{currentPhase:'awaiting-response',deliveryState:'confirmed-submission',submittedUserTurnId:sendResult.details?.userTurnId||job.submittedUserTurnId||null,submissionAckSource:sendResult.details?.submissionAckSource||job.submissionAckSource||'',commandFingerprint:sendResult.details?.commandFingerprint||job.commandFingerprint});
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
        if (isConversationCapacityFailure(waitResult)) {
            return await handleConversationCapacityRollover(tabId, job, waitResult);
        }

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
    const completed=Number(job.completedCount||0)+1;
    const terminalAckSource = diagnostics.terminalAckSource || job.terminalAckSource ||
        (diagnostics.recoveredViaBackendCompletion ? 'backend-completion' : '');

    logQueueEvent(tabId, 'success', `Completed command ${completed}/${totalMessages}.`, {
        commandNumber: completed,
        totalMessages,
        remaining: Math.max(0, job.queue.length),
        ...getQueueFailureDiagnostics(job, 'terminal', diagnostics, 'terminal-success'),
        diagnostics: collectDeliveryDiagnostics(job, {
            ...diagnostics,
            terminalAckSource
        })
    });

    jobs.transaction(job,3);
    updateRunningJobsStorage({ force: true });
}

function pauseJob(tabId, reason, details = {}) {
    const job = jobs.get(tabId);
    if (!job) return;

    const failedMessage = job.currentMessage || '';
    jobs.transaction(job,4,0,{pausedReason:reason||'Queue paused because ChatGPT failed.'});

    logQueueEvent(tabId, 'error', 'Queue paused.', {
        reason: job.pausedReason,
        commandNumber: job.currentCommandNumber || 0,
        completedCount: job.completedCount || 0,
        totalMessages: getTotalMessages(job),
        remaining: getRemainingCount(job),
        failedMessagePreview: previewText(failedMessage, 160),
        ...getQueueFailureDiagnostics(job, details.phase || job.currentPhase, details.diagnostics, 'terminal-pause'),
        ...collectDeliveryDiagnostics(job, details.diagnostics || details),
        ...details
    });

    updateRunningJobsStorage({ force: true });

    notifyRuntime({
        action: 'automationPaused',
        tabId,
        error: job.pausedReason
    });
}

function resetCommandRetryState(job) {if(job)jobs.transaction(job,1,1);}

function resetWaitTracking(job) {if(job)jobs.transaction(job,1,2);}

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
    return requiredQueueDecision(globalThis.CpoQueueEngine?.fingerprint(text));
}

function isSubmissionConfirmed(job) {
    if (!job) return false;
    return requiredQueueDecision(globalThis.CpoQueueEngine?.confirmed(job))===1;
}

function resetCommandDeliveryState(job) {if(job)jobs.transaction(job,1,4);}

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

function boundedDiagnosticValue(value, maxLength = 160) {
    return globalThis.CpoQueueEngine?.diagnosticText?.(value,maxLength)??'';
}

function getDiagnosticTurnIdentity(job, details = {}) {
    const responseState = details.responseState && typeof details.responseState === 'object'
        ? details.responseState
        : {};
    const userTurnId = boundedDiagnosticValue(
        details.userTurnId || responseState.userTurnId || job?.submittedUserTurnId || ''
    );
    const assistantTurnId = boundedDiagnosticValue(
        details.assistantTurnId || responseState.assistantTurnId || job?.assistantTurnId || ''
    );
    return {
        userTurnId: userTurnId || null,
        assistantTurnId: assistantTurnId || null
    };
}

function collectDeliveryDiagnostics(job, extra = {}) {
    const pick=(...values)=>globalThis.CpoQueueEngine?.diagnosticPick?.(...values)??'';
    const turnIdentity = getDiagnosticTurnIdentity(job, extra);
    return {
        ...extra,
        runId: boundedDiagnosticValue(pick(job?.runId,extra.runId)),
        commandId: boundedDiagnosticValue(pick(job?.commandId,extra.commandId)),
        commandNumber: job?.currentCommandNumber || extra.commandNumber || 0,
        deliveryState: boundedDiagnosticValue(pick(job?.deliveryState,extra.deliveryState)),
        submissionAckSource: boundedDiagnosticValue(pick(job?.submissionAckSource,extra.submissionAckSource)),
        terminalAckSource: boundedDiagnosticValue(pick(job?.terminalAckSource,extra.terminalAckSource)),
        userTurnId: turnIdentity.userTurnId,
        assistantTurnId: turnIdentity.assistantTurnId,
        lastResponsePhase: boundedDiagnosticValue(
            pick(job?.lastResponsePhase,extra.phase,extra.responseState?.phase)
        ),
        commandFingerprint: boundedDiagnosticValue(pick(job?.commandFingerprint,extra.commandFingerprint)),
        turnIdentity
    };
}

function summarizeProviderState(state = {}, responseState = {}) {
    /** @type {Record<string, any>} */
    const generation = state && typeof state === 'object' ? state : {};
    /** @type {Record<string, any>} */
    const response = responseState && typeof responseState === 'object' ? responseState : {};
    /** @type {Record<string, any>} */
    const matchedSignals = generation.matchedSignals && typeof generation.matchedSignals === 'object'
        ? generation.matchedSignals
        : {};

    return {
        phase: String(response.phase || generation.phase || ''),
        source: String(response.source || ''),
        generating: response.generating === true || generation.generating === true,
        deepResearchActive: response.deepResearchActive === true || generation.deepResearchActive === true,
        hasError: generation.hasError === true || response.phase === 'error',
        hasTryAgainButton: generation.hasTryAgainButton === true,
        hasDeliveryTimedOut: generation.hasDeliveryTimedOut === true,
        conversationCapacityReached: generation.conversationCapacityReached === true,
        requiresNewConversation: generation.requiresNewConversation === true,
        compatibilityState: boundedDiagnosticValue(generation.compatibilityState || ''),
        matchedSignal: boundedDiagnosticValue(
            matchedSignals.error || generation.matchedError || response.source || ''
        )
    };
}

function getQueueFailureDiagnostics(job, phase, diagnostics = {}, retryDecision = '') {
    /** @type {Record<string, any>} */
    const details = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
    const turnIdentity = getDiagnosticTurnIdentity(job, details);
    const failurePhase = boundedDiagnosticValue(phase || details.phase || job?.currentPhase || '');
    const providerState = summarizeProviderState(details.state, details.responseState);
    return {
        provider: boundedDiagnosticValue(job?.provider || 'chatgpt'),
        stage: failurePhase,
        queuePhase: boundedDiagnosticValue(job?.currentPhase || ''),
        failurePhase,
        turnIdentity,
        providerState,
        failureReason: boundedDiagnosticValue(providerState.matchedSignal || providerState.source || ''),
        retryDecision: boundedDiagnosticValue(retryDecision || ''),
        retryClass: boundedDiagnosticValue(details.failureClass || job?.retryClass || ''),
        retryAttemptCount: Number(details.retryAttemptCount ?? job?.retryAttemptCount ?? 0),
        retryMode: boundedDiagnosticValue(details.retryMode || job?.retryMode || '')
    };
}

function persistCommandDelivery(tabId, job, patch = {}) {
    if (!job || jobs.get(tabId) !== job) return;
    jobs.transaction(job,0,0,patch);
    return updateRunningJobsStorage({ force: true });
}

function getRetryBackoffDelayMs(attemptCount, unlimited = false) {
    if (unlimited) {
        return Math.max(1, Number(QUEUE_RETRY_POLICY.unlimitedDelayMs) || UNLIMITED_RETRY_DELAY_MS);
    }

    const exponent = Math.max(0, Number(attemptCount) || 0);
    const native = globalThis.CpoQueueEngine?.call('cpo_queue_backoff', [exponent,
        Number(QUEUE_RETRY_POLICY.backoffBaseMs), Number(QUEUE_RETRY_POLICY.backoffFactor) || 2,
        Number(QUEUE_RETRY_POLICY.backoffMaxMs)]);
    return requiredQueueDecision(native);
}

/**
 * @param {string} phase
 * @param {string} [reason]
 * @param {Record<string, any>} [diagnostics]
 * @returns {{ class: QueueFailureClass, retryable: boolean, reason: string }}
 */
function classifyQueueFailure(phase, reason, diagnostics = {}) {
    return requiredQueueDecision(globalThis.CpoQueueEngine?.classifyFailure?.(phase,reason,diagnostics||{}));
}

function getRetryExhaustionReason(job, lastReason) {
    const attempts = Number(job?.retryAttemptCount || 0);
    const reason = lastReason || job?.lastRetryableReason || job?.lastError || 'ChatGPT response failed.';
    return `Automatic retry exhausted after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${reason}`;
}

async function interruptibleSleep(tabId, job, ms) {
    const duration = Math.max(0, Number(ms) || 0);
    const now=Date.now();
    const deadline=requiredQueueDecision(globalThis.CpoQueueEngine?.timestampMath?.(0,now,duration));
    const sliceMs = Math.max(5, Number(QUEUE_RETRY_POLICY.sleepSliceMs) || 250);

    while (Date.now() < deadline) {
        if (jobs.processing(job,2)!==1) {
            return true;
        }
        await sleep(Math.min(sliceMs, deadline - Date.now()));
    }

    return jobs.processing(job,2)!==1;
}

async function retryCurrentCommandIfEnabled(tabId, job, phase, reason, diagnostics = {}) {
    if (!job || job.isStopped || job.isPaused || !job.isRunning) {
        return false;
    }

    if (!job.currentMessage) {
        return false;
    }

    const classification = classifyQueueFailure(phase, reason, diagnostics);
    jobs.transaction(job,0,0,{retryClass:classification.class,lastRetryableReason:classification.reason});

    if (!classification.retryable) {
        job.lastError = classification.reason;
        job.updatedAt = Date.now();
        return false;
    }

    const queueSettings = await getQueueSettings();
    if(jobs.get(tabId)!==job||job.isPaused||job.isStopped||!job.isRunning)return false;
    const unlimited = queueSettings.queueUnlimitedRetryWait === true;
    const maxAttempts = unlimited ? Number.POSITIVE_INFINITY : Number(QUEUE_RETRY_POLICY.maxAutomaticAttempts);
    const attemptCount = Number(job.retryAttemptCount || 0);

    const delayMs=jobs.retryPlan(job,unlimited,Number(QUEUE_RETRY_POLICY.maxAutomaticAttempts),
        Number(QUEUE_RETRY_POLICY.backoffBaseMs),Number(QUEUE_RETRY_POLICY.backoffFactor)||2,
        Number(QUEUE_RETRY_POLICY.backoffMaxMs),Math.max(1,Number(QUEUE_RETRY_POLICY.unlimitedDelayMs)||UNLIMITED_RETRY_DELAY_MS));
    if(delayMs==null)return false;
    if (delayMs === 0) {
        jobs.transaction(job,14,Number(unlimited),{lastError:getRetryExhaustionReason(job,classification.reason)});
        logQueueEvent(tabId, 'error', job.lastError, {
            phase,
            retryClass: classification.class,
            retryAttemptCount: attemptCount,
            retryMode: job.retryMode,
            commandNumber: job.currentCommandNumber || 0,
            completedCount: job.completedCount || 0,
            totalMessages: getTotalMessages(job),
            ...getQueueFailureDiagnostics(job, phase, diagnostics, 'terminal-retry-exhausted'),
            diagnostics
        });
        return false;
    }

    jobs.transaction(job,8,delayMs,{retryMode:unlimited?'unlimited':'finite',lastError:classification.reason,retryClass:classification.class,lastRetryableReason:classification.reason});
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
        ...getQueueFailureDiagnostics(job, phase, diagnostics, 'retry-scheduled'),
        diagnostics
    });

    const interrupted = await interruptibleSleep(tabId, job, delayMs);
    if (interrupted || !jobs.has(tabId) || job.isStopped || job.isPaused || !job.isRunning) {
        return false;
    }

    if(jobs.get(tabId)!==job)return false;
    jobs.transaction(job,6);
    updateRunningJobsStorage({ force: true });

    return true;
}

async function refreshChatGPTTab(tabId) {
    await globalThis.CpoQueueEngine?.load();
    let stage = 0;
    let succeeded = false;
    const owner = jobs.get(tabId);
    for (let attempt=0;attempt<4;attempt++) {
        if (owner && (jobs.get(tabId)!==owner || owner.isStopped || owner.isPaused)) return false;
        const flags=Number(succeeded) |
            (Number(typeof chrome.tabs?.reload==='function')<<1) |
            (Number(typeof chrome.scripting?.executeScript==='function')<<2);
        const action=globalThis.CpoQueueEngine?.call('cpo_tab_reload_next',[stage,flags]) ?? 0;
        if(action===4)return true;
        if(action===0)return false;
        try {
            if(action===1) succeeded=!!(await sendTabMessage(tabId,{type:'RELOAD_PAGE'}))?.ok;
            else if(action===2) {
                await globalThis.CpoBrowserApi.invoke('tabReload',tabId);
                succeeded=true;
            } else if(action===3) {
                await chrome.scripting.executeScript({target:{tabId},func:()=>window.location.reload()});
                succeeded=true;
            }
        } catch { succeeded=false; }
        stage=action;
    }
    return false;
}

async function waitForTabToRecover(tabId, maxWaitMs = 30000) {
    await globalThis.CpoQueueEngine?.load();
    const started=Date.now();
    const owner=jobs.get(tabId);
    const cancelled=()=>!!owner&&(jobs.get(tabId)!==owner||owner.isStopped||owner.isPaused);
    const poll=(ready=false)=>globalThis.CpoQueueEngine?.numeric('cpo_tab_recover_poll',[
        Date.now()-started,maxWaitMs,Number(ready)|(Number(cancelled())<<1)]) ??
        0;
    await sleep(1500);
    while(poll()===1){
        try{
            const resp=await sendTabMessage(tabId,{type:'CHECK_GENERATION_STATE'});
            if(poll(!!resp?.state)===2)return true;
        }catch{}
        await sleep(1000);
    }
    return false;
}

async function recoverFromDeliveryTimeout(tabId, job, waitResult, totalMessages, queueSettings) {
    if (!job || job.isStopped || job.isPaused || !job.isRunning) {
        return { action: 'return' };
    }

    if(jobs.processing(job,2)!==1)return {action:'return'};
    jobs.transaction(job,13,0);
    const attempt = job.deliveryTimeoutAttempts;
    const maxAttempts = queueSettings.queueUnlimitedRetryWait ? Number.POSITIVE_INFINITY : 3;

    const initialRecovery=jobs.delivery(job,0,Number(!!waitResult?.details?.state?.hasTryAgainButton)|(Number(!!queueSettings.queueUnlimitedRetryWait)<<3));
    if(initialRecovery===0)return {action:'return'};
    if (initialRecovery === 8) {
        logQueueEvent(tabId, 'error', `Exceeded maximum delivery timeout recovery attempts (${maxAttempts}) for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            attempts: attempt,
            maxAttempts
        });
        return { action: 'fail' };
    }

    jobs.transaction(job,13,1);
    await updateRunningJobsStorage({ force: true });

    // Stage 1: In-page retry if a retry/regenerate button is currently present
    if (initialRecovery === 1) {
        logQueueEvent(tabId, 'info', `Delivery timeout detected. Attempting in-page retry (attempt ${attempt}/${maxAttempts === Number.POSITIVE_INFINITY ? 'unlimited' : maxAttempts}) for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            attempt
        });

        try {
            const clickRes = await sendTabMessage(tabId, { type: 'CLICK_RETRY_BUTTON' });
            if (clickRes && clickRes.ok) {
                await sleep(2000);

                if (jobs.processing(job,2)!==1) {
                    return { action: 'return' };
                }

                const check = await sendTabMessage(tabId, { type: 'CHECK_GENERATION_STATE' }).catch(() => null);
                if (check?.state?.generating || check?.state?.deepResearchActive) {
                    logQueueEvent(tabId, 'info', `In-page retry resumed response for command ${job.currentCommandNumber || '?'}/${totalMessages}. Waiting for completion...`, {
                        commandNumber: job.currentCommandNumber || 0,
                        totalMessages
                    });

                    if(jobs.processing(job,2)!==1)return {action:'return'};
                    jobs.transaction(job,13,2,{sawGenerating:!!check?.state?.generating,sawDeepResearch:!!check?.state?.deepResearchActive});
                    await updateRunningJobsStorage({ force: true });

                    const retryWait = await waitForTabResponse(tabId, {
                        commandNumber: job.currentCommandNumber,
                        totalMessages,
                        queueSettings,
                        commandBinding: getCommandBinding(job)
                    });

                    if (jobs.processing(job,2)!==1) {
                        return { action: 'return' };
                    }

                    if (retryWait.ok) {
                        jobs.transaction(job,13,4);
                        return { action: 'complete', details: retryWait.details || {} };
                    }
                }
            }
        } catch (err) {
            console.warn('In-page retry button click failed, proceeding to reload:', err);
        }
    }

    if (jobs.processing(job,2)!==1) {
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

    if (jobs.processing(job,2)!==1) {
        return { action: 'return' };
    }

    const inspect = await sendTabMessage(tabId, { type: 'INSPECT_GENERATION_STATE' }).catch(() => null);
    const reloadedState = inspect?.state || {};
    const lastAssistant = inspect?.lastAssistant || null;

    const recoveryDecision=stage=>jobs.delivery(job,stage,
        Number(!!(reloadedState.hasTryAgainButton||lastAssistant?.hasRetry))|
        (Number(!!(reloadedState.generating||reloadedState.deepResearchActive))<<1)|
        (Number(!!lastAssistant?.hasCompletedText)<<2));
    // Case 0: Page reloaded and is actively generating
    if (recoveryDecision(1) === 3) {
        logQueueEvent(tabId, 'info', `ChatGPT resumed generating after reload for command ${job.currentCommandNumber || '?'}/${totalMessages}. Waiting for completion...`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages
        });

        jobs.transaction(job,13,2,{sawGenerating:!!reloadedState.generating,sawDeepResearch:!!reloadedState.deepResearchActive});
        await updateRunningJobsStorage({ force: true });

        const postReloadWait = await waitForTabResponse(tabId, {
            commandNumber: job.currentCommandNumber,
            totalMessages,
            queueSettings,
            commandBinding: getCommandBinding(job)
        });

        if (jobs.processing(job,2)!==1) {
            return { action: 'return' };
        }

        if (postReloadWait.ok) {
            jobs.transaction(job,13,4);
            return { action: 'complete', details: postReloadWait.details || {} };
        }
    }

    // Case A: Completed on backend prior to or during reload
    if (recoveryDecision(2) === 4) {
        logQueueEvent(tabId, 'success', `Response completed on backend prior to reload for command ${job.currentCommandNumber || '?'}/${totalMessages}. Advancing queue.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            recoveredTurnPreview: previewText(lastAssistant.text, 140)
        });
        jobs.transaction(job,13,4);
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
    if (recoveryDecision(2) === 5) {
        logQueueEvent(tabId, 'info', `Found Regenerate/Try Again button on reloaded page. Clicking for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages
        });

        try {
            const clickResult = await sendTabMessage(tabId, { type: 'CLICK_RETRY_BUTTON' });
            if (clickResult && clickResult.ok) {
                await sleep(2000);

                if (jobs.processing(job,2)!==1) {
                    return { action: 'return' };
                }

                jobs.transaction(job,13,2);
                await updateRunningJobsStorage({ force: true });

                const retryWait = await waitForTabResponse(tabId, {
                    commandNumber: job.currentCommandNumber,
                    totalMessages,
                    queueSettings,
                    commandBinding: getCommandBinding(job)
                });

                if (jobs.processing(job,2)!==1) {
                    return { action: 'return' };
                }

                if (retryWait.ok) {
                    jobs.transaction(job,13,4);
                    return { action: 'complete', details: retryWait.details || {} };
                }
            }
        } catch (err) {
            console.warn('Clicking retry button after reload failed:', err);
        }
    }

    // Case C: Turn not completed and no retry button.
    const finalRecovery = recoveryDecision(3);
    if (finalRecovery === 0) return { action: 'return' };
    if (finalRecovery === 6) {
        logQueueEvent(tabId, 'warn', `Delivery timeout recovery kept the confirmed command without resending.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            ...collectDeliveryDiagnostics(job)
        });
        jobs.transaction(job,13,2);
        await updateRunningJobsStorage({ force: true });
        return { action: 'retry' };
    }

    if (finalRecovery === 7) {
        logQueueEvent(tabId, 'info', `Re-submitting prompt after reload for command ${job.currentCommandNumber || '?'}/${totalMessages}.`, {
            commandNumber: job.currentCommandNumber || 0,
            totalMessages,
            messagePreview: previewText(job.currentMessage, 140)
        });

        jobs.transaction(job,13,3);
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
 * @param {{ expectedJob?: QueueJob, expectedText?: string, beforeSnapshot?: { userTurns?: Array<{ turnId?: string, matchedExpected?: boolean, fingerprint?: string }>, latestUserTurnId?: string|null, matchedUserTurnId?: string|null, conversationId?: string|null }, timeoutMs?: number, pollMs?: number }} [options]
 */
async function waitForSubmissionAck(tabId, { expectedText, beforeSnapshot, timeoutMs, pollMs, expectedJob = jobs.get(tabId) } = {}) {
    const job = expectedJob;
    await globalThis.CpoQueueEngine?.load();
    const provider = getActiveProviderAdapter(job?.provider) || getActiveProviderAdapter('chatgpt');
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : QUEUE_WAIT_POLICY.submissionAckTimeoutMs;
    const interval = Number(pollMs) > 0 ? Number(pollMs) : QUEUE_WAIT_POLICY.submissionAckPollMs;
    const startedAt = Date.now();
    const beforeIds = new Set((beforeSnapshot?.userTurns || []).map(turn => turn.turnId));
    const supportsTurnAck = provider?.supportsCommandTurnAck !== false;

    if (job) {
        await persistCommandDelivery(tabId, job, {
            currentPhase: 'awaiting-submission-ack',
            deliveryState: 'unknown-acceptance'
        });
    }

    while (true) {
        const liveJob = jobs.get(tabId);
        const cancelled = !!(job && liveJob !== job) || !!(liveJob && (liveJob.isStopped || liveJob.isPaused || !liveJob.isRunning));
        const elapsed = Date.now() - startedAt;
        const poll = globalThis.CpoQueueEngine?.numeric('cpo_submission_poll', [elapsed, timeout, Number(cancelled)]) ??
            0;
        if (poll === 0) break;
        if (poll === 2) {
            return {
                ok: false,
                error: !liveJob || liveJob.isStopped || liveJob !== job ? 'Queue was stopped.' : 'Queue was paused.',
                details: { failureClass: !liveJob || liveJob.isStopped || liveJob !== job ? 'user-stop' : 'non-retryable' }
            };
        }

        if (supportsTurnAck) {
            const inspected = await inspectTabCommandTurns(tabId, {
                expectedText,
                expectedFingerprint: liveJob?.commandFingerprint || fingerprintCommandTextForJob(expectedText)
            });
            const snapshot = inspected.snapshot || { userTurns: [] };
            const accept = (turn, expected) => {
                const flags = 1 | (Number(!!expected) << 1) | (Number(beforeIds.has(turn.turnId)) << 2) |
                    (Number(!!turn.turnId) << 3);
                return (globalThis.CpoQueueEngine?.call('cpo_submission_ack', [flags]) ??
                    0) === 1;
            };
            const matched = (snapshot.userTurns || []).find(turn => accept(turn, turn.matchedExpected)) ||
                (snapshot.matchedUserTurnId ? (snapshot.userTurns || []).find(turn =>
                    turn.turnId === snapshot.matchedUserTurnId && accept(turn, true)) : null);
            if (job && (jobs.get(tabId) !== job || job.isPaused || job.isStopped || !job.isRunning)) continue;

            if (matched) {
                if (liveJob) {
                    await persistCommandDelivery(tabId, liveJob, {
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
                const generating = !!(state.generating || state.deepResearchActive);
                if (job && (jobs.get(tabId) !== job || job.isPaused || job.isStopped || !job.isRunning)) continue;
                if ((globalThis.CpoQueueEngine?.call('cpo_submission_ack', [Number(generating) << 4]) ?? 0) === 2) {
                    if (liveJob) {
                        await persistCommandDelivery(tabId, liveJob, {
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

async function sendPromptToSpecificTab(tabId, text, expectedJob = jobs.get(tabId)) {
    try {
        if(!await globalThis.CpoQueueEngine?.load())return {ok:false,error:'Required Rust queue engine unavailable.',details:{failureClass:'non-retryable'}};
        let tabUrl = '';
        try {
            const tab = await getTab(tabId);
            tabUrl = tab?.url || tab?.pendingUrl || '';
        } catch {
            tabUrl = '';
        }

        const job = expectedJob;
        if (job && jobs.get(tabId) !== job) return { ok: false, error: 'Queue ownership changed.', details: { failureClass: 'user-stop' } };
        const provider = getActiveProviderAdapter(tabUrl) ||
            getActiveProviderAdapter(job?.provider) ||
            getActiveProviderAdapter('chatgpt');
        const beforeInspect = await inspectTabCommandTurns(tabId, {
            expectedText: text,
            expectedFingerprint: job?.commandFingerprint || fingerprintCommandTextForJob(text)
        });
        if (job) {
            await persistCommandDelivery(tabId, job, {
                currentPhase: 'sending',
                deliveryState: 'pre-click'
            });
        }

        const ownsSubmission = () => !job || jobs.processing(job,2)===1;
        const stageDecision = (stage, flags) => globalThis.CpoQueueEngine?.call('cpo_submission_stage',
            [stage, flags | Number(ownsSubmission())]) ?? 0;
        if (stageDecision(0, Number(!!beforeInspect.ok) << 1) !== 1) {
            return { ok: false, error: 'Queue stopped or paused before submission.', details: { failureClass: 'non-retryable' } };
        }
        // Negotiate capability before any mutation. If the native operation
        // has been attempted, never fall through to a second click path.
        let nativeCapability=null;
        try { nativeCapability=await sendTabMessage(tabId,{type:'GET_NATIVE_SUBMISSION_CAPABILITY'}); } catch {}
        let results;
        if(nativeCapability?.nativeSubmission===true){
            const identity=provider?.getConversationIdentity(tabUrl);
            const expectedKey=identity?.key;
            if(!ownsSubmission() || !expectedKey || identity.type==='unsupported' ||
                (job?.conversationId && identity.conversationId!==job.conversationId)){
                return {ok:false,error:'Queue target changed before native submission.',details:{failureClass:'non-retryable'}};
            }
            const token=createRunId();
            const lease=grantControl(0,tabId);
            if(!lease)return {ok:false,error:'Native submission authorization unavailable or already pending.',details:{failureClass:'transient'}};
            const grant={token,job,lease};
            nativeClickGrants.set(tabId,grant);
            try {
                const native=await sendTabMessage(tabId,{type:'NATIVE_SUBMIT_PROMPT',text,expectedKey,token});
                results=[{result:native}];
            } catch {
                results=[{result:{ok:false,error:'Native submission outcome could not be confirmed.',details:{failureClass:'submission-unconfirmed'}}}];
            } finally {
                if(nativeClickGrants.get(tabId)===grant)nativeClickGrants.delete(tabId);
                grantControl(2,tabId,lease);
            }
        } else {
            return {ok:false,error:'Required native submission engine unavailable. Reload the conversation after reinstalling the extension.',details:{failureClass:'non-retryable'}};
        }

        const result = results?.[0]?.result;

        if (stageDecision(1, Number(!!result?.ok) << 2) !== 2) {
            return {
                ok: false,
                error: result?.error || 'Could not send prompt, or queue ownership changed.',
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
            pollMs: QUEUE_WAIT_POLICY.submissionAckPollMs,
            expectedJob: job
        });

        if (stageDecision(2, Number(!!ack.ok) << 3) !== 3) {
            return {
                ok: false,
                error: ack.error || 'Send was not acknowledged as a new user turn, or queue ownership changed.',
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
    if(!await globalThis.CpoQueueEngine?.load())return {ok:false,error:'Required Rust queue engine unavailable.',details:{failureClass:'non-retryable'}};
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
    let lease;
    try{lease=jobs.waitControl(liveJob,0,0,0,0,startedAt);}catch{}
    if(!lease)return {ok:false,error:'Queue stopped or a native response wait is already active.',details:{failureClass:'user-stop'}};
    const waitNative=(op,a=0,b=0,now=Date.now())=>{
        try{return jobs.waitControl(liveJob,lease,op,a,b,now);}catch{return null;}
    };
    const sample=(op,needed=1)=>{
        const next=waitNative(3,op,Math.min(32767,Math.max(1,Math.ceil(needed))));
        if(next==null)throw new Error('Native response confirmation unavailable.');
        return next===1;
    };
    const waitLabel = getWaitContextLabel(context);
    const commandBinding = getCommandBinding(liveJob, context);
    const hasCommandBinding = !context.waitForExistingGeneration && !!(commandBinding.userTurnId || commandBinding.commandFingerprint);
    const requiredConfirmSamples = Math.max(1, Number(context.terminalConfirmSamples || QUEUE_WAIT_POLICY.terminalConfirmSamples) || 2);

    // Save delivery-state transitions promptly, but coalesce unchanged
    // heartbeat writes to avoid serializing large queued commands every poll.
    const persistWaitSignals=(force=false)=>{
        if(jobs.get(tabId)!==liveJob)return;
        const flags=Number(force)|(Number(sawGenerating)<<1)|(Number(sawDeepResearch)<<2);
        if(waitNative(4,flags)===1)updateRunningJobsStorage();
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
            try{persistWaitSignals(true);}
            catch(error){console.warn('Native wait checkpoint could not be saved:',error);}
            finally{waitNative(6);resolveRaw(value);}
        };
        const pollGeneration = () => {
            if (settled) {
                clearInterval(checkInterval);
                return;
            }
            const ready=waitNative(7);
            if(ready===0)return;
            if(ready==null){resolve({ok:false,error:'Queue ownership changed or native wait unavailable.',details:{failureClass:'user-stop'}});return;}

            const job = jobs.get(tabId);

            const flags=Number(!!job&&job===liveJob&&!job.isStopped)|
                (Number(!!job&&job===liveJob&&job.isRunning&&!job.isPaused)<<1)|
                (Number(unlimited)<<2)|(Number(queueSettings.queueDeepResearchAware)<<3)|(Number(sawDeepResearch)<<4);
            const now=Date.now();
            const gate=globalThis.CpoQueueEngine?.numeric('cpo_background_poll_gate',[
                flags,now-startedAt,ordinaryMaxWaitMs,deepResearchMaxWaitMs,
                now-Number(job?.lastResearchProgressAt||startedAt),deepResearchStaleMs]);
            if(gate==null){resolve({ok:false,error:'Native response poll admission unavailable.',details:{failureClass:'non-retryable'}});return;}
            if(gate===1||gate===2){
                resolve({ok:false,error:gate===1?'Queue was stopped.':'Queue was paused.',
                    details:buildWaitDetails({failureClass:gate===1?'user-stop':'non-retryable'})});
                return;
            }
            if(gate===3){
                const researchTimeout=queueSettings.queueDeepResearchAware&&sawDeepResearch;
                resolve({ok:false,error:researchTimeout?'Timed out waiting for Deep Research to finish.':
                    hasCommandBinding?'No terminal response was confirmed for this command.':'Timed out waiting for ChatGPT response.',
                    details:buildWaitDetails({failureClass:'timeout',timedOut:true,pendingWithoutTerminal:true})});
                return;
            }
            if(gate===4){
                resolve({ok:false,error:'Deep Research stalled without progress.',
                    details:buildWaitDetails({failureClass:'stalled-research',stalledResearch:true})});
                return;
            }

            try {
                if(waitNative(1)!==1){resolve({ok:false,error:'Native poll lease unavailable.',details:{failureClass:'non-retryable'}});return;}
                sendTabMessage(tabId, { type: 'CHECK_GENERATION_STATE', commandBinding }).then((response) => {
                    if (settled) {
                        return;
                    }

                    if(jobs.get(tabId)!==liveJob||jobs.processing(job,2)!==1){resolve({ok:false,error:'Queue ownership or activity changed during response polling.',details:{failureClass:'user-stop'}});return;}
                    const state = response?.state || {};
                    const responseState = response?.responseState || null;
                    const phase = String(responseState?.phase || '');

                    if (responseState && typeof responseState === 'object') {
                        if (responseState.userTurnId && !job.submittedUserTurnId) {
                            job.submittedUserTurnId = responseState.userTurnId;
                        }
                        if (responseState.assistantTurnId) {
                            job.assistantTurnId = responseState.assistantTurnId;
                        }
                    }
                    if (phase) {
                        job.lastResponsePhase = phase;
                    }

                    const isDeliveryTimeout = !!state.hasDeliveryTimedOut ||
                        (typeof state.matchedError === 'string' && /delivery time(?:d\s*)?out/i.test(state.matchedError)) ||
                        (typeof state.errorSnippet === 'string' && /delivery time(?:d\s*)?out/i.test(state.errorSnippet));

                    const failureFlags = Number(isDeliveryTimeout) |
                        (Number(!!(state.conversationCapacityReached || state.requiresNewConversation || responseState?.source === 'conversation-max-length'))<<1) |
                        (Number(!!(state.hasError || state.hasTryAgainButton || phase === 'error'))<<2) |
                        (Number(phase === 'waiting-for-user')<<3) | (Number(phase === 'interrupted')<<4);
                    const failure = globalThis.CpoQueueEngine?.call('cpo_wait_failure',[failureFlags]);
                    if(failure==null){clearInterval(checkInterval);resolve({ok:false,error:'Native response classifier unavailable.',details:{failureClass:'non-retryable'}});return;}
                    if (failure === 1) {
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

                    if (failure === 2) {
                        clearInterval(checkInterval);
                        resolve({
                            ok: false,
                            isDeliveryTimeout: false,
                            error: 'ChatGPT conversation reached maximum length.',
                            details: buildWaitDetails({
                                failureClass: 'conversation-max-length',
                                conversationCapacityReached: true,
                                requiresNewConversation: true,
                                state,
                                responseState
                            })
                        });
                        return;
                    }

                    if (failure === 3) {
                        clearInterval(checkInterval);
                        resolve({
                            ok: false,
                            isDeliveryTimeout: false,
                            error: 'ChatGPT showed an error or retry state.',
                            details: buildWaitDetails({
                                failureClass: state.hasTryAgainButton || responseState?.source === 'retry-visible' ? 'retry-visible' : 'generation-error',
                                providerState: summarizeProviderState(state, responseState),
                                state,
                                responseState
                            })
                        });
                        return;
                    }

                    if (failure === 4) {
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

                    if (failure === 5) {
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

                    const incompleteToolTurn = isIncompleteToolResponse(responseState);
                    const responseIsActive = state.generating || deepResearchActive || phase === 'active' || incompleteToolTurn;

                    if (responseIsActive) {
                    if (!sawGenerating && responseIsActive) {
                        logQueueEvent(tabId, 'info', `ChatGPT is responding for ${waitLabel}.`, {
                            commandNumber: context.commandNumber || 0,
                            totalMessages: context.totalMessages || 0,
                            elapsedMs: Date.now() - startedAt,
                            commandId: commandBinding.commandId || job.commandId || '',
                            userTurnId: responseState?.userTurnId || commandBinding.userTurnId || null,
                            responsePhase: incompleteToolTurn ? 'incomplete-tool' : (phase || 'active')
                        });
                    }

                    sawGenerating = sawGenerating || !!state.generating || phase === 'active' || incompleteToolTurn;
                    sawDeepResearch = sawDeepResearch || deepResearchActive;
                    job.deliveryState = hasCommandBinding ? 'active-response' : job.deliveryState;
                    job.lastResponsePhase = incompleteToolTurn ? 'incomplete-tool' : (phase || 'active');
                    if (responseState?.assistantTurnId) {
                        job.assistantTurnId = responseState.assistantTurnId;
                    }
                    sample(0);

                    if (state.generating || researchPreview !== lastResearchPreview || phase === 'active' || incompleteToolTurn) {
                        job.lastResearchProgressAt = Date.now();
                        lastResearchPreview = researchPreview;
                    }

                    persistWaitSignals();

                    if (waitNative(5)===1) {
                        logQueueEvent(tabId, 'info', `Still waiting for ${waitLabel}.`, {
                            commandNumber: context.commandNumber || 0,
                            totalMessages: context.totalMessages || 0,
                            elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
                            generating: !!state.generating,
                            deepResearchActive,
                            sawGenerating,
                            sawDeepResearch,
                            responsePhase: incompleteToolTurn ? 'incomplete-tool' : (phase || 'active'),
                            settings: queueSettings
                        });
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

                const pageIsIdle = !state.generating && !deepResearchActive && phase !== 'active' && !incompleteToolTurn;

                const bindingMatches = !commandBinding.userTurnId || !responseState?.userTurnId ||
                    responseState.userTurnId === commandBinding.userTurnId;
                const settleFlags = Number(!!context.waitForExistingGeneration) | (Number(!pageIsIdle)<<1) |
                    (Number(phase === 'transient-idle')<<2) | (Number(hasCommandBinding)<<3) |
                    (Number(phase === 'terminal')<<4) | (Number(bindingMatches)<<5) |
                    (Number(!!(sawGenerating || sawDeepResearch))<<6) | (Number(!phase)<<7) |
                    (Number(incompleteToolTurn)<<8);
                const settle = globalThis.CpoQueueEngine?.call('cpo_wait_settle',[settleFlags]);
                if(settle==null){clearInterval(checkInterval);resolve({ok:false,error:'Native response settlement unavailable.',details:{failureClass:'non-retryable'}});return;}
                if (settle === 1 || settle === 2) {
                    if (settle === 1) {
                        sample(1);
                        persistWaitSignals();
                        return;
                    }
                    const needed = (sawGenerating || sawDeepResearch) ? requiredConfirmSamples : 1;
                    const confirmed=sample(2,needed);
                    persistWaitSignals();
                    if (confirmed) {
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

                if (settle === 3) {
                    sample(0);
                    job.lastResponsePhase = phase || 'transient-idle';
                    persistWaitSignals();
                    return;
                }

                if (settle === 4) {
                    const confirmed=sample(3,requiredConfirmSamples);
                    job.lastResponsePhase = 'terminal';
                    job.assistantTurnId = responseState?.assistantTurnId || job.assistantTurnId || null;
                    job.terminalAckSource = responseState?.source || 'bound-assistant-turn';
                    persistWaitSignals();
                    if (confirmed) {
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

                if (settle === 5) {
                    const confirmed=sample(4,requiredConfirmSamples);
                    persistWaitSignals();
                    if (confirmed) {
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

                sample(0);

                if (queueSettings.queueUnlimitedRetryWait && waitNative(5)===1) {
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
                }).finally(() => {
                    waitNative(2);
                });
            } catch (error) {
                waitNative(2);
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
    return jobs.runningSnapshot();
}

function getRemainingCount(job) {
    const owned=jobs.processing(job,5);if(owned!=null)return owned;
    const queued = Array.isArray(job?.queue) ? job.queue.length : 0;
    return requiredQueueDecision(globalThis.CpoQueueEngine?.call('cpo_queue_remaining', [queued, Number(!!job?.currentMessage)]));
}

function getTotalMessages(job) {
    if (!job) return 0;
    const owned=jobs.processing(job,6);if(owned!=null)return owned;

    const declared = Number(job.totalMessages || 0);
    const completed = Number(job.completedCount || 0);
    const remaining = getRemainingCount(job);
    return requiredQueueDecision(globalThis.CpoQueueEngine?.call('cpo_queue_total', [declared, completed, remaining]));
}

function getJobStatus(job) {
    const owned=jobs.processing(job,7);if(owned!=null)return ['idle','paused','running','stopped'][owned];
    if (job.isPaused) return 'paused';
    if (job.isRunning) return 'running';
    if (job.isStopped) return 'stopped';
    return 'idle';
}

function updateRunningJobsStorage(options = {}) {
    // A native revision is an exact dirty token, not a hash or full JSON copy.
    // Never replace durable storage with an empty snapshot after an engine trap.
    if(!jobs.canPersist())return queueStateWrite;
    const serialized = jobs.revision();
    const hasJobs = jobs.size > 0;

    updateQueueWakeAlarm(hasJobs);

    const flags=Number(options.force===true)|(Number(queueStateFlushTimer!==null)<<1);
    const action=globalThis.CpoQueueEngine?.numeric('cpo_background_checkpoint_update',[serialized,flags]);
    if(action==null||action===0xffffffff)return queueStateWrite;
    if (action === 0) return queueStateWrite;
    if (action === 1) {
        if (queueStateFlushTimer !== null) {
            clearTimeout(queueStateFlushTimer);
            queueStateFlushTimer = null;
        }
        return queueStateWrite;
    }
    if (action === 2) return flushQueueState();
    if (action === 3) {
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

    if(!jobs.canPersist()||globalThis.CpoQueueEngine?.numeric('cpo_background_checkpoint',[0,0])!==1)return queueStateWrite;
    let nextState;
    try {
        const snapshot=getRunningJobsSnapshot();
        nextState={serialized:jobs.revision(),items:{
            runningJobs:snapshot,queueDurableJobs:getDurableJobsState(),isRunning:jobs.size>0
        }};
    } catch(error) {
        console.warn('Native checkpoint unavailable; previous durable state preserved.',error);
        return queueStateWrite;
    }
    if(globalThis.CpoQueueEngine?.numeric('cpo_background_checkpoint',[1,nextState.serialized])!==1)return queueStateWrite;
    queueStateWrite = queueStateWrite
        .catch(() => {})
        .then(async () => {
            if (globalThis.CpoQueueEngine?.numeric('cpo_background_checkpoint',[2,nextState.serialized])===1) {
                return;
            }

            await writeLocalStorage(nextState.items);
            globalThis.CpoQueueEngine?.numeric('cpo_background_checkpoint',[3,nextState.serialized]);
        })
        .catch((error) => {
            console.warn('Could not persist queue state:', error);
        })
        .finally(() => {
            globalThis.CpoQueueEngine?.numeric('cpo_background_checkpoint',[4,nextState.serialized]);
        });

    return queueStateWrite;
}

function getDurableJobsState() {
    const state = {};
    for(const [tabId,job] of jobs.entries())state[tabId]=jobs.checkpoint(job);
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
            const start=globalThis.CpoQueueEngine?.call('cpo_log_keep_start',[logs.length,entries.length,MAX_QUEUE_DEBUG_LOG_ENTRIES])??logs.length+entries.length;
            const nextLogs = [...logs.slice(Math.min(start,logs.length)), ...entries.slice(Math.max(0,start-logs.length))]
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
    return globalThis.CpoBrowserApi.invoke('localGet',keys).then(data=>data||{});
}

function writeLocalStorage(items) {
    return globalThis.CpoBrowserApi.invoke('localSet',items);
}

async function getQueueSettings() {
    try {
        const data = await readSyncStorage(QUEUE_SETTINGS_DEFAULTS);
        await globalThis.CpoQueueEngine?.load();
        const native=globalThis.CpoQueueEngine?.settings({...QUEUE_SETTINGS_DEFAULTS,...data},'queue');
        if(native)return native;

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
    return globalThis.CpoBrowserApi.invoke('syncGet',defaults).then(data=>data||{});
}

function getTab(tabId) {
    return globalThis.CpoBrowserApi.invoke('tabGet',tabId);
}

function updateTabUrl(tabId,url) {
    return globalThis.CpoBrowserApi.invoke('tabUpdate',tabId,{url});
}

function queryTabs(queryInfo) {
    return globalThis.CpoBrowserApi.invoke('tabQuery',queryInfo).then(tabs=>Array.isArray(tabs)?tabs:[]);
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

function sendTabMessage(tabId,message) {
    return globalThis.CpoBrowserApi.invoke('tabSend',tabId,message);
}

function createTab(createProperties) {
    return globalThis.CpoBrowserApi.invoke('tabCreate',createProperties);
}

async function openExtensionPopupPage() {
    await createTab({
        url: chrome.runtime.getURL('popup.html'),
        active: true
    });
}

function executeScript(details, callback) {
    const promise=globalThis.CpoBrowserApi.inject(details);
    if(typeof callback==='function'){
        promise.then(results=>callback(results,null),error=>callback(null,error));
        return undefined;
    }
    return promise;
}

function isSensitiveLogKey(key) {
    const normalized=String(key||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    return normalized?requiredQueueDecision(globalThis.CpoQueueEngine?.sensitiveKey(normalized))===1:false;
}

function describeLoggedMessage(text) {
    return {
        redacted: true,
        messageLength: String(text || '').length
    };
}

function sanitizeLogValue(value, depth = 0, key = '') {
    const native=globalThis.CpoQueueEngine?.sanitizeDiagnostic?.(value,depth,key,isSensitiveLogKey,serializeError);
    // No alternate recursive policy: when native redaction fails, drop the
    // complete detail object rather than exposing unclassified data.
    return native?.ok?native.value:{redacted:true,nativeUnavailable:true};
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
    return globalThis.CpoQueueEngine?.diagnosticText?.(text||'',maxLength)??'';
}

function scheduledAlarmName(id) {
    return `${SCHEDULED_ALARM_PREFIX}${String(id || '')}`;
}

function nativeScheduledCollection(method,...args){
    const result=globalThis.CpoQueueEngine?.[method]?.(...args);
    if(result==null)throw new Error('Native scheduled collection unavailable; stored items preserved.');
    return result;
}
function sortScheduledMessages(items) {
    return nativeScheduledCollection('scheduledSort',Array.isArray(items)?items:[]);
}
function findScheduledItem(items,id){
    return nativeScheduledCollection('scheduledLookup',items,id)[0];
}

function scheduledAction(action, item, now = Date.now()) {
    if (!item) return 0;
    const native=globalThis.CpoQueueEngine?.schedule(action,item,now);
    if(native==null)throw new Error('Native scheduler unavailable; no scheduled delivery authorized.');
    return native;
}

async function readScheduledMessages() {
    if(!await globalThis.CpoQueueEngine?.load())throw new Error('Native scheduler unavailable.');
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
    const now=Date.now();
    const when=globalThis.CpoQueueEngine?.timestampMath?.(5,Number(item.dueTs),now);
    if(when==null||!Number.isFinite(when))return;
    chrome.alarms.create(scheduledAlarmName(item.id), { when });
}

async function persistScheduledItem(nextItem) {
    return withScheduledStorageLock(async () => {
        const items = await readScheduledMessages();
        const previous=findScheduledItem(items,nextItem.id);
        const index=items.indexOf(previous);
        const terminal=nextItem.status==='completed'||nextItem.status==='failed';
        if(globalThis.CpoQueueEngine?.call('cpo_background_schedule_guard',[2,
            Number(terminal)|(Number(!!previous)<<1)|(Number(previous?.status==='firing')<<2)])!==0)
            throw new Error('Scheduled claim changed before settlement; no record overwritten.');
        if(index>=0)items[index]=nextItem;
        else items.push(nextItem);
        await writeScheduledMessages(items);
        notifyRuntime({
            action: 'scheduledMessagesUpdated',
            item: nextItem
        });
        return nextItem;
    });
}

function normalizedIdentityKey(provider,type,id,key=''){
    return requiredQueueDecision(globalThis.CpoQueueEngine?.identityKey?.(provider,type,id,key));
}
function buildScheduledConversationIdentity(item) {
    return {
        provider: item.provider || 'chatgpt',
        type: item.conversationType || 'unknown',
        conversationId: item.conversationId || null,
        key: normalizedIdentityKey(item.provider||'chatgpt',item.conversationType||'unknown',null,item.targetKey)
    };
}

function identitiesMatchForSchedule(stored,current){
    return !!stored&&!!current&&globalThis.CpoQueueEngine?.scheduleIdentity(stored,current)===1;
}

async function createScheduledMessage({ text, dueTs, tabId, conversationIdentity = null }) {
    const message = String(text || '').trim();
    const normalizedTabId = Number(tabId || 0);
    const normalizedDueTs = Number(dueTs);

    const guard=requiredQueueDecision(globalThis.CpoQueueEngine?.call('cpo_background_schedule_guard',[0,
        Number(!!message)|(Number(!!normalizedTabId)<<1)|(Number(globalThis.CpoQueueEngine?.timestampValid?.(normalizedDueTs)===true)<<2)]));
    if(guard!==0)return {ok:false,error:['','Message text is required.','A supported target tab is required.','A valid due date/time is required.'][guard]||'Invalid scheduled request.'};

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
    const targetKey = normalizedIdentityKey(provider,conversationType,conversationId,identity?.key);
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
        const item = findScheduledItem(items,scheduledId);

        if (!item) {
            return { ok: false, error: 'Scheduled message not found.' };
        }

        const action = scheduledAction(1, item);
        if (action === 2) {
            return { ok: false, error: 'Completed scheduled messages cannot be cancelled.' };
        }

        if (action === 3) {
            return { ok: false, error: 'Scheduled message delivery is already in progress.' };
        }

        if(!globalThis.CpoQueueEngine.scheduledMutation(1,item))throw new Error('Native cancellation rejected.');
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
        const item = findScheduledItem(items,scheduledId);

        if (!item) {
            return { ok: false, error: 'Scheduled message not found.' };
        }

        if (scheduledAction(2, item) === 3) {
            return { ok: false, error: 'Scheduled message delivery is already in progress.' };
        }

        const nextItems = nativeScheduledCollection('scheduledWithout',items,scheduledId);
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
        const item = findScheduledItem(items,scheduledId);

        if (!item) {
            return { ok: false, error: 'Scheduled message not found.' };
        }

        const action = scheduledAction(3, item);
        if (action === 2) {
            return { ok: false, error: 'Completed scheduled messages cannot be retried.' };
        }

        if (action === 3) {
            return { ok: false, error: 'Scheduled message delivery is already in progress.' };
        }

        const nextDueTs = dueTs == null ? Date.now() : Number(dueTs);
        if (globalThis.CpoQueueEngine?.timestampValid?.(nextDueTs)!==true) {
            return { ok: false, error: 'A valid due date/time is required to retry.' };
        }

        if(!globalThis.CpoQueueEngine.scheduledMutation(3,item,Date.now(),nextDueTs))throw new Error('Native retry rejected.');
        await writeScheduledMessages(items);
        createScheduledAlarm(item);
        notifyRuntime({ action: 'scheduledMessagesUpdated', item });
        return { ok: true, item };
    });

    if (result.ok && scheduledAction(4, result.item) === 1) {
        await processDueScheduledMessages('retry', result.item.id);
    }

    return result;
}

async function markScheduledFailed(item, reason) {
    if(!globalThis.CpoQueueEngine.scheduledMutation(6,item,Date.now(),0,String(reason||'Scheduled delivery failed.')))throw new Error('Native scheduled failure rejected.');
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
    if(!globalThis.CpoQueueEngine.scheduledMutation(7,item))throw new Error('Native scheduled completion rejected.');
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
        const item = findScheduledItem(items,id);

        if (!item) {
            return null;
        }

        if (scheduledAction(4, item, now) !== 1) return null;

        if(!globalThis.CpoQueueEngine.scheduledMutation(4,item,now))return null;
        await writeScheduledMessages(items);
        return { ...item };
    });
}

async function validateScheduledTarget(item) {
    const tabId = Number(item.tabId || 0);
    const guard=requiredQueueDecision(globalThis.CpoQueueEngine?.call('cpo_background_schedule_guard',[1,
        Number(!!tabId)|(Number(['existing','new'].includes(item.conversationType)&&!!item.provider)<<1)]));
    if(guard===1)return {ok:false,reason:'Scheduled item is missing a target tab.'};
    if (guard!==0) {
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
    const selectedItem = onlyId ? findScheduledItem(items,onlyId) : null;

    if (
        selectedItem &&
        scheduledAction(4, selectedItem, now) === 4
    ) {
        // A one-shot alarm can be delivered early by a test/browser shim. Keep the
        // item pending and replace the consumed alarm instead of sending early.
        createScheduledAlarm(selectedItem);
        return [];
    }

    const dueItems = nativeScheduledCollection('scheduledDue',items,onlyId,now);

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
    const items = await withScheduledStorageLock(async () => {
        const items = await readScheduledMessages();
        let changed = false;

        for (const item of items) {
            if (scheduledAction(5, item) === 5) {
            if(!globalThis.CpoQueueEngine.scheduledMutation(5,item))throw new Error('Native scheduled recovery rejected.');
            clearScheduledAlarm(item.id);
                changed = true;
            }
        }
        if (changed) await writeScheduledMessages(items);
        return items;
    });

    for (const item of items) {
        if (scheduledAction(5, item) === 4) createScheduledAlarm(item);
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
        queueExecutionAction,
        refreshChatGPTTab,
        waitForTabToRecover,
        waitForTabResponse,
        retryCurrentCommandIfEnabled,
        classifyQueueFailure,
        handleConversationCapacityRollover,
        isConversationCapacityFailure,
        applyAuthorizedConversationRebind,
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
        sortScheduledMessages,
        scheduledAction,
        isIdleDiscardCandidate,
        discardInactiveChatGPTTabs
    };
}
"####;
