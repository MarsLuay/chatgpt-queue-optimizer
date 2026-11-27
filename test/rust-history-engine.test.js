const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CpoHistoryStore } = require('../history-store.js');

const wasmPath = path.join(__dirname, '..', 'optimizer_history.wasm');
const skip = !fs.existsSync(wasmPath) && 'Build WASM first using cargo run --release --manifest-path Installers/native/Cargo.toml -- build';

async function nativeStore() {
    const store = new CpoHistoryStore(null);
    const result = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    store.core = result.instance.exports;
    assert.equal(store.core.cpo_history_abi(), 3);
    return store;
}

test('Rust codec round-trips Unicode and rejects corrupt or out-of-order rows', { skip }, async () => {
    const store = await nativeStore();
    const row = {index: 7, role: 'assistant', text: '\uFEFFhello 🌍 café', truncated: true};
    const result = store.prepareRow(row, 7, 0);
    assert.ok(result.stored instanceof Uint8Array);
    assert.deepEqual(store.decodeRow(result.stored, 7), row);
    assert.throws(() => store.decodeRow(result.stored, 8), /Corrupt/);
    const damaged = result.stored.slice();
    damaged[0] = 0;
    assert.throws(() => store.decodeRow(damaged, 7), /Corrupt/);
    assert.equal(store.prepareRow(row, 7, 8 * 1024 * 1024), null);
    assert.throws(() => store.prepareRow(row, 6, 0), /Invalid/);
    const scratch = new Uint8Array(store.core.memory.buffer, store.core.cpo_history_buffer(),
        store.core.cpo_history_capacity());
    assert.ok(scratch.every(byte => byte === 0));
    // Native decoding requires the engine; legacy object rows remain readable.
    const fallback = new CpoHistoryStore(null);
    assert.throws(() => fallback.decodeRow(result.stored, 7), /Required Rust/);
    assert.deepEqual(store.decodeRow(row, 7), row);
});

test('history storage refuses to run without its native engine', () => {
    const store=new CpoHistoryStore(null);
    assert.throws(()=>store.pageStart(30,0),/Required Rust/);
    assert.throws(()=>store.pageSize(30,0),/Required Rust/);
    assert.throws(()=>store.prepareRow({index:0,role:'user',text:'x'},0,0),/Required Rust/);
});

function fakeRequest(value) {
    const req = { result: value };
    queueMicrotask(() => req.onsuccess());
    return req;
}

// Test the host's ordered request execution; real IDB atomic commit/abort is
// still provided by the browser and requires a browser integration test.
test('history transport creates, appends, finalizes, pages and deletes via native commands', { skip }, async () => {
    const store = await nativeStore();
    const metadata = new Map();
    const rows = new Map();
    const meta = {
        get: key => fakeRequest(metadata.get(key)),
        put(value, key) { metadata.set(key, value); return fakeRequest(key); },
        clear() { metadata.clear(); return fakeRequest(undefined); }
    };
    const turns = {
        put(value, key) { rows.set(key, value); return fakeRequest(key); },
        clear() { rows.clear(); return fakeRequest(undefined); },
        getAll(range, count) { return fakeRequest([...rows.entries()]
            .filter(([key]) => key >= range.lower && key <= range.upper)
            .sort((a,b) => a[0] - b[0]).slice(0,count).map(([,value]) => value)); }
    };
    const oldRange = global.IDBKeyRange;
    global.IDBKeyRange = { bound: (lower, upper) => ({lower, upper}) };
    store.transaction = async (_mode, callback) => callback(meta, turns);
    try {
        const initial = { id: 'snapshot', count: 0, bytes: 0, complete: false };
        await store.replace(initial);
        const record = store.prepareRow({index:0,role:'user',text:'test',truncated:false},0,0);
        const updated = {...initial,count:1,bytes:record.size};
        await assert.rejects(store.append('wrong',[record],updated), /rejected/);
        assert.equal(rows.size,0);
        await store.append(initial.id,[record],updated);
        await assert.rejects(store.append(initial.id,[record],updated), /rejected/);
        assert.equal((await store.page(0)).records.length,0);
        await store.finalize(initial.id,{...updated,complete:true});
        const page = await store.page(100);
        assert.equal(page.start,0);
        assert.equal(page.records[0].text,'test');
        assert.equal((await store.readMeta()).complete,true);
        await assert.rejects(store.delete('wrong'), /rejected/);
        await store.delete(initial.id);
        assert.equal(await store.readMeta(),undefined);
        assert.equal(rows.size,0);
    } finally {
        if (oldRange === undefined) delete global.IDBKeyRange;
        else global.IDBKeyRange = oldRange;
    }
});

test('compressed rows are smaller and require WASM to decode', { skip }, async () => {
    const store = await nativeStore();
    const row = { index: 0, role: 'assistant', text: 'Repeated Unicode text 🌍 café. '.repeat(500), truncated: false };
    const record = store.prepareRow(row, 0, 0);
    assert.equal(Buffer.from(record.stored.subarray(0, 4)).toString('ascii'), 'CPO2');
    assert.ok(record.stored.length < Buffer.byteLength(row.text));
    assert.deepEqual(store.decodeRow(record.stored, 0), row);
    const fallback = new CpoHistoryStore(null);
    assert.throws(() => fallback.decodeRow(record.stored, 0), /Required Rust/);
    const bad = record.stored.slice();
    bad[16] = 128; bad[17] = 0; bad[18] = 0;
    assert.throws(() => store.decodeRow(bad, 0), /Corrupt/);
    assert.throws(() => fallback.decodeRow(bad, 0), /Required Rust/);
    const scratch = new Uint8Array(store.core.memory.buffer, store.core.cpo_history_output(),
        store.core.cpo_history_capacity());
    assert.ok(scratch.every(byte => byte === 0));
});

test('native reader application controls and capture transitions', {skip}, async () => {
    const store=await nativeStore();
    const e=store.core;
    assert.equal(e.cpo_reader_buttons(2|4|8|16,16,40),63);
    assert.equal(e.cpo_reader_buttons(1|2|4|8,0,40),0);
    assert.equal(e.cpo_reader_move(0,0),0);
    assert.equal(e.cpo_reader_move(16,1),32);
    assert.equal(e.cpo_reader_batch(16,20,4,20,3),1);
    assert.equal(e.cpo_reader_batch(16,20,5,21,3),0);
    assert.equal(e.cpo_reader_batch(0,20,4,4,1),0);
    assert.equal(e.cpo_reader_continue(4096,5000,16,16),0);
    assert.equal(e.cpo_reader_partial(4096,5000,0),1);
});
