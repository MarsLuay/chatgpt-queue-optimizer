(() => {
    'use strict';
    const DB = 'cpo-local-history-v1';
    const PAGE_SIZE = 16;
    const MAX_TURNS = 4096;
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
    let pageStart = 0;
    let historyStore = null;
    let ui = null;
    let busy = false;
    let renderEpoch = 0;

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
    function updateButtons() {
        const complete = !!meta?.complete;
        const validSource=Number.isSafeInteger(sourceTab)&&sourceTab>0;
        const flags=Number(busy)|(Number(validSource)<<1)|(Number(!!meta)<<2)|(Number(complete)<<3)|(Number(meta?.tabId===sourceTab)<<4);
        const native=historyStore?.core?.cpo_reader_buttons(flags,pageStart,meta?.count||0);
        if(native!=null){
            [captureButton,discardButton,originalButton,deleteButton,prevButton,nextButton].forEach((button,i)=>{button.disabled=!(native&(1<<i));});
            return;
        }
        captureButton.disabled = busy || !Number.isSafeInteger(sourceTab) || sourceTab <= 0;
        discardButton.disabled = busy || !complete || meta?.tabId !== sourceTab;
        originalButton.disabled = busy || !complete;
        deleteButton.disabled = busy || !meta;
        prevButton.disabled = busy || !complete || pageStart === 0;
        nextButton.disabled = busy || !complete || pageStart + PAGE_SIZE >= meta?.count;
    }
    async function renderPage() {
        const epoch = ++renderEpoch;
        const result = await historyStore.page(pageStart);
        if (epoch !== renderEpoch) return;
        meta = result.current || null;
        if (!meta?.complete) {
            el('turns').replaceChildren();
            el('page').textContent = 'No completed snapshot';
            updateButtons();
            return;
        }
        pageStart = result.start;
        const rows=result.records.map(row=>({fields:[(row.index+1)+'. '+row.role,row.text],flags:Number(!!row.truncated)}));
        if(ui.renderUI(6,el('turns'),rows)!==true)throw new Error('Native history renderer failed. Reopen the reader.');
        el('page').textContent = (meta.count ? pageStart + 1 : 0) + '–' +
            Math.min(pageStart + PAGE_SIZE, meta.count) + ' of ' + meta.count;
        setStatus('Saved ' + new Date(meta.created).toLocaleString() + ' · ' +
            (meta.bytes / 1048576).toFixed(2) + ' MiB estimated payload · ' +
            (historyStore.core ? 'Rust/WASM storage and codec' : 'JavaScript fallback') +
            (meta.partial ? ' · Partial snapshot (limits reached or incomplete turn text)' : '') +
            '. The original conversation is unchanged.');
        updateButtons();
    }
    async function run(action) {
        if (busy) return;
        busy = true;
        updateButtons();
        try { await action(); }
        catch (error) { setStatus(error?.message || 'History operation failed.'); }
        finally { busy = false; updateButtons(); }
    }
    captureButton.addEventListener('click', () => run(async () => {
        const tab = await getTab(sourceTab);
        if (!tab || tab.incognito || !isChatGPTUrl(tab.url) || tab.discarded || tab.active) {
            throw new Error('Select an inactive, loaded, non-private ChatGPT tab first.');
        }
        const id = crypto.randomUUID();
        let offset = 0;
        let current = null;
        let partial = false;
        while (offset < MAX_TURNS) {
            const reply = await sendToTab(sourceTab, {
                type: 'CPO_HISTORY_BATCH', offset,
                identity: current?.identity, total: current?.total
            });
            const shape=!!reply?.ok&&Array.isArray(reply.records)&&Number.isSafeInteger(reply.total)&&reply.total>=0&&reply.total<=0xffffffff&&
                Number.isSafeInteger(reply.next)&&reply.next>=0&&reply.next<=0xffffffff;
            const accepted=shape&&(historyStore.core?.cpo_reader_batch(offset,reply.total,reply.records.length,reply.next,3) ??
                Number(reply.records.length<=16&&reply.next===offset+reply.records.length&&reply.next<=reply.total));
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
                pageStart = 0;
            }
            if (reply.identity !== current.identity || reply.total !== current.total) throw new Error('Conversation changed.');
            const records = [];
            let bytes = current.bytes;
            for (const row of reply.records) {
                const encoded = historyStore.prepareRow(row, current.count + records.length, bytes);
                if (!encoded) { partial = true; break; }
                bytes += encoded.size;
                partial ||= encoded.truncated;
                records.push(encoded);
            }
            if (records.length) {
                const updated = { ...current, count: current.count + records.length, bytes };
                await historyStore.append(id, records, updated);
                current = updated;
                meta = current;
            }
            offset = current.count;
            setStatus('Captured ' + offset + ' of ' + current.total + ' loaded turns…');
            if (!(historyStore.core?.cpo_reader_continue(offset,current.total,records.length,reply.records.length) ?? Number(offset<MAX_TURNS&&offset<current.total&&records.length===reply.records.length&&records.length>0))) break;
        }
        if (!current?.count) throw new Error('No text rows were saved.');
        const source = await getTab(sourceTab);
        if (source.url !== current.url || source.active || source.discarded) throw new Error('Source tab changed during capture.');
        current = { ...current, partial: !!(historyStore.core?.cpo_reader_partial(current.count,current.total,Number(partial)) ?? Number(partial || current.count < current.total)), complete: true };
        await historyStore.finalize(id, current);
        await renderPage();
    }));
    discardButton.addEventListener('click', () => run(async () => {
        const saved = await historyStore.readMeta();
        if (!saved?.complete || saved.id !== meta?.id || saved.tabId !== sourceTab) throw new Error('Snapshot is no longer current.');
        if (!window.confirm('Unload the original ChatGPT tab? The saved snapshot is read-only and may be incomplete. Opening the original will reload the conversation.')) return;
        const response = await sendRuntime({ action: 'discardHistorySource', tabId: sourceTab,
            expectedUrl: saved.url, expectedIdentity: saved.identity });
        if (!response?.ok) throw new Error(response?.error || 'Original tab could not be unloaded safely.');
        setStatus('Original tab discarded. Browser may release its page memory; opening the original reloads it.');
    }));
    originalButton.addEventListener('click', () => run(async () => {
        const saved = await historyStore.readMeta();
        if (!saved?.complete || !isChatGPTUrl(saved.url)) throw new Error('No valid original conversation URL.');
        let tab;
        try { tab = await getTab(saved.tabId); } catch {}
        if (tab?.url === saved.url && !tab.incognito) {
            await globalThis.CpoBrowserApi.invoke('tabUpdate',tab.id,{active:true});
        } else {
            await globalThis.CpoBrowserApi.invoke('tabCreate',{url:saved.url});
        }
    }));
    deleteButton.addEventListener('click', () => run(async () => {
        await historyStore.delete(meta?.id);
        meta = null;
        pageStart = 0;
        await renderPage();
        setStatus('Saved snapshot deleted.');
    }));
    prevButton.addEventListener('click', () => run(async () => { pageStart = historyStore.core?.cpo_reader_move(pageStart,0) ?? Math.max(0, pageStart - PAGE_SIZE); await renderPage(); }));
    nextButton.addEventListener('click', () => run(async () => { pageStart = historyStore.core?.cpo_reader_move(pageStart,1) ?? pageStart + PAGE_SIZE; await renderPage(); }));

    async function init() {
        busy = true;
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
            const ready=await Promise.all([historyStore.load(),ui.load()]);
            if(!historyStore.core||!ready[1])throw new Error('Required Rust history modules unavailable. Rebuild the extension.');
            await renderPage();
            if (!meta?.complete) setStatus(meta ? 'An incomplete snapshot exists. Delete it or capture again.' : 'No saved snapshot. Capture a loaded conversation to begin.');
        } catch(error) { setStatus(error?.message||'Local history storage could not be opened.'); }
        finally { busy = false; updateButtons(); if (!db||!historyStore?.core||!ui?.exports) { for(const button of [captureButton,discardButton,originalButton,deleteButton,prevButton,nextButton])button.disabled=true; } }
    }
    init();
})();
