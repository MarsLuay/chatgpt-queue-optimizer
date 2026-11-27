//! Generate the history reader's browser-effect adapter. Rust/WASM owns
//! action authorization, busy state, page navigation and capture accounting.
use super::Result;
use std::{fs,path::Path};
pub const OUTPUT:&str="history-viewer.js";
pub fn generate(stage:&Path)->Result<()>{
    fs::write(stage.join(OUTPUT),String::from("// @generated Rust history reader host. DO NOT EDIT.\n")+HOST)?;
    println!("Generated {OUTPUT} from Rust history reader");
    Ok(())
}
const HOST:&str=r###"(() => {
    'use strict';
    const DB = 'cpo-local-history-v1';
    const sourceTab = Number(new URLSearchParams(location.search).get('tab') || 0);
    const el = id => document.getElementById(id);
    const captureButton = el('capture');
    const discardButton = el('discard');
    const originalButton = el('original');
    const deleteButton = el('delete');
    const prevButton = el('prev');
    const nextButton = el('next');
    let db;
    let meta = null;
    let historyStore = null;
    let ui = null;
    const buttons=[captureButton,discardButton,originalButton,deleteButton,prevButton,nextButton];
    const core=()=>historyStore.requireCore();
    const state=(op,a=0,b=0,c=0)=>core().cpo_reader_state(op,a,b,c)>>>0;
    const capture=(op,a=0,b=0,c=0)=>core().cpo_reader_capture(op,a,b,c)>>>0;
    const guard=(op,flags)=>core().cpo_reader_guard(op,flags)===1;
    const flags=(...facts)=>facts.reduce((value,fact,i)=>value|(Number(!!fact)<<i),0);

    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Local database request failed.'));
    });
    function getTab(id) {
        return globalThis.CpoBrowserApi.invoke('tabGet',id);
    }
    function sendToTab(id, message) {
        return globalThis.CpoBrowserApi.invoke('tabSend',id,message);
    }
    function sendRuntime(message) {
        return globalThis.CpoBrowserApi.invoke('runtimeSend',message);
    }
    function setStatus(message) { el('status').textContent = message; }
    function metadataFlags() {
        return flags(false,Number.isSafeInteger(sourceTab)&&sourceTab>0,meta,meta?.complete,meta?.tabId===sourceTab);
    }
    function updateButtons() {
        const mask=historyStore?.core?state(3,metadataFlags(),meta?.count||0):0;
        buttons.forEach((button,i)=>{button.disabled=!(mask&(1<<i));});
    }
    async function renderPage() {
        const result = await historyStore.page(state(4));
        meta = result.current || null;
        if (!meta?.complete) {
            el('turns').replaceChildren();
            el('page').textContent = 'No completed snapshot';
            updateButtons();
            return;
        }
        state(5,result.start,meta.count);
        const pageStart=state(4);
        const rows=result.records.map(row=>({fields:[(row.index+1)+'. '+row.role,row.text],flags:Number(!!row.truncated)}));
        if(ui.renderUI(6,el('turns'),rows)!==true)throw new Error('Native history renderer failed. Reopen the reader.');
        el('page').textContent = (meta.count ? pageStart + 1 : 0) + '–' +
            (pageStart + core().cpo_history_page_size(meta.count,pageStart)) + ' of ' + meta.count;
        setStatus('Saved ' + new Date(meta.created).toLocaleString() + ' · ' +
            (meta.bytes / 1048576).toFixed(2) + ' MiB estimated payload · ' +
            'Rust/WASM storage and codec' +
            (meta.partial ? ' · Partial snapshot (limits reached or incomplete turn text)' : '') +
            '. The original conversation is unchanged.');
        updateButtons();
    }
    async function run(code,action) {
        if(!historyStore?.core||!state(1,code,metadataFlags(),meta?.count||0))return;
        updateButtons();
        try { await action(); }
        catch (error) { setStatus(error?.message || 'History operation failed.'); }
        finally { state(2); updateButtons(); }
    }
    captureButton.addEventListener('click', () => run(1,async () => {
        const tab = await getTab(sourceTab);
        if (!guard(0,flags(tab,!tab?.incognito,isChatGPTUrl(tab?.url),!tab?.discarded,!tab?.active))) {
            throw new Error('Select an inactive, loaded, non-private ChatGPT tab first.');
        }
        const id = crypto.randomUUID();
        capture(0);
        let current = null;
        for (;;) {
            const offset=capture(4);
            const reply = await sendToTab(sourceTab, {
                type: 'CPO_HISTORY_BATCH', offset,
                identity: current?.identity, total: current?.total
            });
            const shape=!!reply?.ok&&Array.isArray(reply.records)&&Number.isSafeInteger(reply.total)&&reply.total>=0&&reply.total<=0xffffffff&&
                Number.isSafeInteger(reply.next)&&reply.next>=0&&reply.next<=0xffffffff;
            if(shape&&reply.total===0&&!current)throw new Error('No loaded turns found.');
            const accepted=shape&&capture(1,reply.total,reply.records.length,reply.next)===1;
            if (!accepted) {
                throw new Error(reply?.error || 'The source conversation did not return a valid snapshot batch.');
            }
            if (!current) {
                if (reply.total === 0) throw new Error('No loaded turns found.');
                current = { id, tabId: sourceTab, url: tab.url, identity: reply.identity,
                    total: reply.total, created: Date.now(), count: 0, bytes: 0,
                    partial: false, complete: false };
                await historyStore.replace(current);
                meta = current;
                el('turns').replaceChildren();
                state(6);
            }
            if (reply.identity !== current.identity || reply.total !== current.total) throw new Error('Conversation changed.');
            const records = [];
            for (const row of reply.records) {
                const encoded = historyStore.prepareRow(row,capture(4),capture(5));
                if (!encoded) { capture(3); break; }
                if(!capture(2,encoded.size,Number(encoded.truncated)))throw new Error('Native capture accounting rejected row.');
                records.push(encoded);
            }
            if (records.length) {
                const updated = { ...current, count: capture(4), bytes:capture(5) };
                await historyStore.append(id, records, updated);
                current = updated;
                meta = current;
            }
            setStatus('Captured ' + capture(4) + ' of ' + current.total + ' loaded turns…');
            if(!capture(7,reply.records.length))break;
        }
        if (!current?.count) throw new Error('No text rows were saved.');
        const source = await getTab(sourceTab);
        if (!guard(1,flags(source,source?.url===current.url,!source?.active,!source?.discarded&&!source?.incognito))) throw new Error('Source tab changed during capture.');
        current = { ...current, partial: !!capture(8), complete: true };
        await historyStore.finalize(id, current);
        await renderPage();
    }));
    discardButton.addEventListener('click', () => run(2,async () => {
        const saved = await historyStore.readMeta();
        if (!guard(2,flags(saved?.complete,saved?.id===meta?.id,saved?.tabId===sourceTab))) throw new Error('Snapshot is no longer current.');
        if (!window.confirm('Unload the original ChatGPT tab? The saved snapshot is read-only and may be incomplete. Opening the original will reload the conversation.')) return;
        const response = await sendRuntime({ action: 'discardHistorySource', tabId: sourceTab,
            expectedUrl: saved.url, expectedIdentity: saved.identity });
        if (!response?.ok) throw new Error(response?.error || 'Original tab could not be unloaded safely.');
        setStatus('Original tab discarded. Browser may release its page memory; opening the original reloads it.');
    }));
    originalButton.addEventListener('click', () => run(3,async () => {
        const saved = await historyStore.readMeta();
        if (!guard(3,flags(saved?.complete,isChatGPTUrl(saved?.url)))) throw new Error('No valid original conversation URL.');
        let tab;
        try { tab = await getTab(saved.tabId); } catch {}
        if (guard(4,flags(tab?.url===saved.url,tab&&!tab.incognito))) {
            await globalThis.CpoBrowserApi.invoke('tabUpdate',tab.id,{active:true});
        } else {
            await globalThis.CpoBrowserApi.invoke('tabCreate',{url:saved.url});
        }
    }));
    deleteButton.addEventListener('click', () => run(4,async () => {
        await historyStore.delete(meta?.id);
        meta = null;
        state(6);
        await renderPage();
        setStatus('Saved snapshot deleted.');
    }));
    prevButton.addEventListener('click', () => run(5,renderPage));
    nextButton.addEventListener('click', () => run(6,renderPage));

    async function init() {
        updateButtons();
        try {
            if (chrome.extension?.inIncognitoContext) throw new Error('Private context');
            const open = indexedDB.open(DB, 1);
            open.onupgradeneeded = () => {
                open.result.createObjectStore('meta');
                open.result.createObjectStore('turns');
            };
            db = await request(open);
            historyStore = new globalThis.CpoHistoryStore(db);
            ui=new globalThis.CpoRustBrowserBridge(null);
            const ready=await Promise.all([historyStore.load(),ui.load(),globalThis.CpoQueueEngine?.load()]);
            if(!historyStore.core||!ready[1]||!ready[2])throw new Error('Required Rust history modules unavailable. Rebuild the extension.');
            await renderPage();
            if (!meta?.complete) setStatus(meta ? 'An incomplete snapshot exists. Delete it or capture again.' : 'No saved snapshot. Capture a loaded conversation to begin.');
            state(0);
        } catch(error) { if(historyStore?.core)state(7); setStatus(error?.message||'Local history storage could not be opened.'); }
        finally { updateButtons(); }
    }
    init();
})();
"###;
