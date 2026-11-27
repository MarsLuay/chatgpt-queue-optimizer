(() => {
    'use strict';
    const DB = 'cpo-local-history-v1';
    const PAGE_SIZE = 16;
    const MAX_BYTES = 8 * 1024 * 1024;
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
    let core = null;
    let busy = false;
    let renderEpoch = 0;

    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Local database request failed.'));
    });
    function transaction(mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['meta', 'turns'], mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || new Error('Local database transaction aborted.'));
            tx.onerror = () => reject(tx.error || new Error('Local database transaction failed.'));
            Promise.resolve().then(() => operation(tx.objectStore('meta'), tx.objectStore('turns')))
                .then(value => { result = value; })
                .catch(error => {
                    try { tx.abort(); } catch {}
                    reject(error);
                });
        });
    }
    function getTab(id) {
        return extensionApiPromise(done => chrome.tabs.get(id, done), () => chrome.tabs.get(id));
    }
    function sendToTab(id, message) {
        return extensionApiPromise(done => chrome.tabs.sendMessage(id, message, done),
            () => chrome.tabs.sendMessage(id, message));
    }
    function sendRuntime(message) {
        return extensionApiPromise(done => chrome.runtime.sendMessage(message, done),
            () => chrome.runtime.sendMessage(message));
    }
    function setStatus(message) { el('status').textContent = message; }
    function updateButtons() {
        const complete = !!meta?.complete;
        captureButton.disabled = busy || !Number.isSafeInteger(sourceTab) || sourceTab <= 0;
        discardButton.disabled = busy || !complete || meta?.tabId !== sourceTab;
        originalButton.disabled = busy || !complete;
        deleteButton.disabled = busy || !meta;
        prevButton.disabled = busy || !complete || pageStart === 0;
        nextButton.disabled = busy || !complete || pageStart + PAGE_SIZE >= meta?.count;
    }
    function pageCount(total, offset) {
        return core ? core.cpo_history_page_count(total, offset, PAGE_SIZE) >>> 0 :
            Math.min(PAGE_SIZE, Math.max(0, total - offset));
    }
    function acceptsBytes(used, next) {
        return core ? core.cpo_history_accept_bytes(used, next) === 1 :
            used <= MAX_BYTES && next <= MAX_BYTES - used;
    }
    async function readMeta() {
        return transaction('readonly', store => request(store.get('current')));
    }
    async function replaceSnapshot(initial) {
        await transaction('readwrite', async (store, turns) => {
            await request(turns.clear());
            await request(store.put(initial, 'current'));
        });
    }
    async function appendBatch(id, records, updated) {
        await transaction('readwrite', async (store, turns) => {
            const existing = await request(store.get('current'));
            if (existing?.id !== id || existing.count !== records[0]?.index) {
                throw new Error('Another reader replaced this snapshot.');
            }
            for (const record of records) await request(turns.put(record, record.index));
            await request(store.put(updated, 'current'));
        });
    }
    async function finalize(id, updated) {
        await transaction('readwrite', async store => {
            const existing = await request(store.get('current'));
            if (existing?.id !== id || existing.count !== updated.count) throw new Error('Snapshot changed.');
            await request(store.put(updated, 'current'));
        });
    }
    async function renderPage() {
        const epoch = ++renderEpoch;
        const result = await transaction('readonly', async (store, turns) => {
            const current = await request(store.get('current'));
            if (!current?.complete) return { current, records: [] };
            const start = Math.min(pageStart, Math.max(0, Math.floor((current.count - 1) / PAGE_SIZE) * PAGE_SIZE));
            const count = pageCount(current.count, start);
            const records = count ? await request(turns.getAll(IDBKeyRange.bound(start, start + count - 1), count)) : [];
            return { current, records, start };
        });
        if (epoch !== renderEpoch) return;
        meta = result.current || null;
        el('turns').replaceChildren();
        if (!meta?.complete) {
            el('page').textContent = 'No completed snapshot';
            updateButtons();
            return;
        }
        pageStart = result.start;
        for (const row of result.records) {
            const article = document.createElement('article');
            article.className = 'turn';
            const label = document.createElement('h2');
            label.textContent = (row.index + 1) + '. ' + row.role;
            const body = document.createElement('p');
            body.textContent = row.text;
            article.append(label, body);
            if (row.truncated) {
                const notice = document.createElement('p');
                notice.className = 'notice';
                notice.textContent = 'This turn was truncated by the snapshot limit.';
                article.append(notice);
            }
            el('turns').append(article);
        }
        el('page').textContent = (meta.count ? pageStart + 1 : 0) + '–' +
            Math.min(pageStart + PAGE_SIZE, meta.count) + ' of ' + meta.count;
        setStatus('Saved ' + new Date(meta.created).toLocaleString() + ' · ' +
            (meta.bytes / 1048576).toFixed(2) + ' MiB estimated payload · ' +
            (core ? 'Rust/WASM paging' : 'JavaScript fallback') +
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
        const encoder = new TextEncoder();
        const id = crypto.randomUUID();
        let offset = 0;
        let current = null;
        let partial = false;
        while (offset < MAX_TURNS) {
            const reply = await sendToTab(sourceTab, {
                type: 'CPO_HISTORY_BATCH', offset,
                identity: current?.identity, total: current?.total
            });
            if (!reply?.ok || !Array.isArray(reply.records) || !Number.isSafeInteger(reply.total) ||
                reply.total < 0 || reply.records.length > 16 || reply.next !== offset + reply.records.length) {
                throw new Error(reply?.error || 'The source conversation did not return a valid snapshot batch.');
            }
            if (!current) {
                if (reply.total === 0) throw new Error('No loaded turns found.');
                current = { id, tabId: sourceTab, url: tab.url, identity: reply.identity,
                    total: reply.total, created: Date.now(), count: 0, bytes: 0,
                    partial: false, complete: false };
                await replaceSnapshot(current);
                meta = current;
                el('turns').replaceChildren();
                pageStart = 0;
            }
            if (reply.identity !== current.identity || reply.total !== current.total) throw new Error('Conversation changed.');
            const records = [];
            let bytes = current.bytes;
            for (const row of reply.records) {
                if (row.index !== current.count + records.length ||
                    !['user','assistant','message'].includes(row.role) || typeof row.text !== 'string' ||
                    row.text.length > 37000) throw new Error('Invalid snapshot row.');
                const size = encoder.encode(row.text).byteLength + 128;
                if (row.index >= MAX_TURNS || !acceptsBytes(bytes, size)) { partial = true; break; }
                bytes += size;
                partial ||= row.truncated === true;
                records.push({ index: row.index, role: row.role, text: row.text, truncated: row.truncated === true });
            }
            if (records.length) {
                const updated = { ...current, count: current.count + records.length, bytes };
                await appendBatch(id, records, updated);
                current = updated;
                meta = current;
            }
            offset = current.count;
            setStatus('Captured ' + offset + ' of ' + current.total + ' loaded turns…');
            if (offset >= current.total || records.length < reply.records.length || !records.length) break;
        }
        if (!current?.count) throw new Error('No text rows were saved.');
        const source = await getTab(sourceTab);
        if (source.url !== current.url || source.active || source.discarded) throw new Error('Source tab changed during capture.');
        current = { ...current, partial: partial || current.count < current.total, complete: true };
        await finalize(id, current);
        await renderPage();
    }));
    discardButton.addEventListener('click', () => run(async () => {
        const saved = await readMeta();
        if (!saved?.complete || saved.id !== meta?.id || saved.tabId !== sourceTab) throw new Error('Snapshot is no longer current.');
        if (!window.confirm('Unload the original ChatGPT tab? The saved snapshot is read-only and may be incomplete. Opening the original will reload the conversation.')) return;
        const response = await sendRuntime({ action: 'discardHistorySource', tabId: sourceTab,
            expectedUrl: saved.url, expectedIdentity: saved.identity });
        if (!response?.ok) throw new Error(response?.error || 'Original tab could not be unloaded safely.');
        setStatus('Original tab discarded. Browser may release its page memory; opening the original reloads it.');
    }));
    originalButton.addEventListener('click', () => run(async () => {
        const saved = await readMeta();
        if (!saved?.complete || !isChatGPTUrl(saved.url)) throw new Error('No valid original conversation URL.');
        let tab;
        try { tab = await getTab(saved.tabId); } catch {}
        if (tab?.url === saved.url && !tab.incognito) {
            await extensionApiPromise(done => chrome.tabs.update(tab.id, { active: true }, done),
                () => chrome.tabs.update(tab.id, { active: true }));
        } else {
            await extensionApiPromise(done => chrome.tabs.create({ url: saved.url }, done),
                () => chrome.tabs.create({ url: saved.url }));
        }
    }));
    deleteButton.addEventListener('click', () => run(async () => {
        await transaction('readwrite', async (store, turns) => {
            const current = await request(store.get('current'));
            if (current?.id !== meta?.id) throw new Error('Snapshot has changed. Reload the reader.');
            await request(turns.clear());
            await request(store.clear());
        });
        meta = null;
        pageStart = 0;
        await renderPage();
        setStatus('Saved snapshot deleted.');
    }));
    prevButton.addEventListener('click', () => run(async () => { pageStart = Math.max(0, pageStart - PAGE_SIZE); await renderPage(); }));
    nextButton.addEventListener('click', () => run(async () => { pageStart += PAGE_SIZE; await renderPage(); }));

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
            try {
                const response = await fetch(chrome.runtime.getURL('optimizer_core.wasm'));
                if (!response.ok) throw new Error('WASM unavailable');
                const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
                const exports = result.instance.exports;
                if (exports.cpo_abi_version() === 4 && typeof exports.cpo_history_page_count === 'function' &&
                    typeof exports.cpo_history_accept_bytes === 'function') core = exports;
            } catch {}
            await renderPage();
            if (!meta?.complete) setStatus(meta ? 'An incomplete snapshot exists. Delete it or capture again.' : 'No saved snapshot. Capture a loaded conversation to begin.');
        } catch { setStatus('Local history storage could not be opened or is unavailable in this private context.'); }
        finally { busy = false; updateButtons(); if (!db) captureButton.disabled = true; }
    }
    init();
})();
