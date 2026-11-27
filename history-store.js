(() => {
    'use strict';
    const PAGE = 16;
    const MAX_BYTES = 8 * 1024 * 1024;
    const MAX_TURNS = 4096;
    const HEADER = 16;
    const ROLES = ['', 'user', 'assistant', 'message'];
    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Local database request failed.'));
    });

    // Compatibility policy is used only if the local Rust module cannot load.
    function fallbackNext(kind, prev, valid, remaining) {
        if (prev === 0) return kind === 1 ? (valid ? 2 : 0) : 1;
        if (kind === 0 && prev === 1) return 7;
        if (kind === 1 && prev === 2) return 4;
        if (kind === 2 && prev === 1) return valid && remaining ? 3 : 0;
        if (kind === 2 && prev === 3) return remaining ? 3 : 4;
        if (kind === 3 && prev === 1) return valid ? 4 : 0;
        if ([1,2,3].includes(kind) && prev === 4) return 7;
        if (kind === 4 && prev === 1) return valid && remaining ? 6 : 7;
        if (kind === 4 && prev === 6) return 7;
        if (kind === 5 && prev === 1) return valid ? 2 : 0;
        if (kind === 5 && prev === 2) return 5;
        if (kind === 5 && prev === 5) return 7;
        return 0;
    }

    // Read CPO2 rows even when WASM is unavailable. Bound expansion before allocation.
    function decodeCompressed(input, length) {
        if (length > 111000 || length <= input.length) throw new Error('Corrupt compressed snapshot row.');
        const out = new Uint8Array(length);
        let i = 0, o = 0;
        while (i < input.length) {
            const token = input[i++];
            const n = token < 128 ? token + 1 : (token & 127) + 3;
            if (n > length - o) throw new Error('Corrupt compressed snapshot row.');
            if (token < 128) {
                if (n > input.length - i) throw new Error('Corrupt compressed snapshot row.');
                out.set(input.subarray(i, i+n), o); i += n; o += n;
            } else {
                if (input.length-i < 2) throw new Error('Corrupt compressed snapshot row.');
                const distance = input[i] | (input[i+1] << 8); i += 2;
                if (!distance || distance > o) throw new Error('Corrupt compressed snapshot row.');
                for (let j = 0; j < n; j++) { out[o] = out[o-distance]; o++; }
            }
        }
        if (o !== length) throw new Error('Corrupt compressed snapshot row.');
        return out;
    }

    class CpoHistoryStore {
        constructor(db) {
            this.db = db;
            this.core = null;
            this.encoder = new TextEncoder();
            this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        }

        async load() {
            try {
                const response = await fetch(chrome.runtime.getURL('optimizer_history.wasm'));
                if (!response.ok) throw new Error('History module unavailable');
                const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
                const core = result.instance.exports;
                const required = ['cpo_history_abi','cpo_history_buffer','cpo_history_capacity',
                    'cpo_history_encode','cpo_history_decode','cpo_history_wipe',
                    'cpo_history_compress','cpo_history_decompress','cpo_history_output','cpo_history_wipe_output',
                    'cpo_history_row_decision','cpo_history_meta_valid','cpo_history_next',
                    'cpo_history_page_start','cpo_history_page_size'];
                if (!required.every(name => typeof core[name] === 'function') ||
                    core.cpo_history_abi() !== 2 || !(core.memory instanceof WebAssembly.Memory)) {
                    throw new Error('History module ABI mismatch');
                }
                this.core = core;
            } catch (error) {
                console.warn('CPO: Rust history module unavailable; using compatibility storage.', error);
            }
        }

        transaction(mode, operation) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(['meta', 'turns'], mode);
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

        metaValid(kind, existing, options) {
            const updated = options.updated || {};
            const rows = options.records || [];
            const same = !!existing && typeof options.id === 'string' && !!options.id && existing.id === options.id;
            const flags = Number(!!existing) | (Number(same) << 1) |
                (Number(!!existing?.complete) << 2) | (Number(!!updated.complete) << 3);
            const nums = [existing?.count ?? 0, updated.count ?? 0, existing?.bytes ?? 0,
                updated.bytes ?? 0, rows.length, rows[0]?.index ?? 0];
            if (nums.some(n => !Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)) return false;
            if (this.core) return this.core.cpo_history_meta_valid(kind, flags, ...nums) === 1;
            const [oldCount, newCount, oldBytes, newBytes, count, first] = nums;
            const bounded = newCount <= MAX_TURNS && newBytes <= MAX_BYTES;
            if (kind === 1) return !updated.complete && newCount === 0 && newBytes === 0;
            if (kind === 2) return same && !existing.complete && !updated.complete && bounded &&
                count > 0 && count <= PAGE && first === oldCount && newCount === oldCount + count && newBytes >= oldBytes;
            if (kind === 3) return same && !existing.complete && updated.complete && bounded &&
                newCount > 0 && oldCount === newCount && oldBytes === newBytes;
            return kind === 5 && same;
        }

        pageStart(total, requested) {
            return this.core ? this.core.cpo_history_page_start(total, requested) >>> 0 :
                Math.min(requested, Math.max(0, Math.floor((total - 1) / PAGE) * PAGE));
        }

        pageSize(total, start) {
            return this.core ? this.core.cpo_history_page_size(total, start) >>> 0 :
                Math.min(PAGE, Math.max(0, total - start));
        }

        prepareRow(row, expected, used) {
            if (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX_TURNS ||
                !Number.isSafeInteger(used) || used < 0 || used > MAX_BYTES ||
                !row || !Number.isSafeInteger(row.index) || row.index < 0 || row.index > 0xffffffff ||
                typeof row.text !== 'string' || row.text.length > 37000 || !ROLES.includes(row.role) || !row.role) {
                throw new Error('Invalid snapshot row.');
            }
            const role = ROLES.indexOf(row.role);
            let binary = null;
            let size;
            const core = this.core;
            if (core) {
                const ptr = core.cpo_history_buffer() >>> 0;
                const capacity = core.cpo_history_capacity() >>> 0;
                const buffer = new Uint8Array(core.memory.buffer, ptr, capacity);
                let written = 0;
                let wipeSize = capacity;
                try {
                    const result = this.encoder.encodeInto(row.text, buffer.subarray(HEADER));
                    written = result.written;
                    wipeSize = HEADER + written;
                    if (result.read !== row.text.length) throw new Error('Snapshot row exceeds codec capacity.');
                    size = written + 128;
                    const decision = core.cpo_history_row_decision(row.index, expected, role, row.text.length, used, written);
                    if (decision === 0) throw new Error('Invalid snapshot row.');
                    if (decision === 2) return null;
                    const length = core.cpo_history_encode(row.index, role, Number(row.truncated === true), written) >>> 0;
                    if (length !== HEADER + written) throw new Error('Rust snapshot codec rejected row.');
                    const compressed = core.cpo_history_compress(length) >>> 0;
                    binary = compressed ? new Uint8Array(core.memory.buffer, core.cpo_history_output() >>> 0, compressed).slice() : buffer.slice(0, length);
                } finally {
                    core.cpo_history_wipe(wipeSize);
                    core.cpo_history_wipe_output(wipeSize);
                }
            } else {
                size = this.encoder.encode(row.text).byteLength + 128;
                if (row.index !== expected) throw new Error('Invalid snapshot row.');
                if (row.index >= MAX_TURNS || size > MAX_BYTES - used) return null;
            }
            const stored = binary || { index: row.index, role: row.role, text: row.text, truncated: row.truncated === true };
            return { index: row.index, stored, size, truncated: row.truncated === true };
        }

        decodeRow(value, index) {
            if (!(value instanceof Uint8Array)) {
                // Pre-migration IndexedDB rows are readable without data migration.
                if (value?.index !== index || typeof value.text !== 'string' || !ROLES.includes(value.role) || !value.role)
                    throw new Error('Invalid saved snapshot row.');
                return value;
            }
            if (value.length < HEADER || value.length > 111016) throw new Error('Corrupt snapshot row.');
            let flags;
            let textBytes = value.subarray(HEADER);
            const compressed = value[0] === 67 && value[1] === 80 && value[2] === 79 && value[3] === 50;
            const core = this.core;
            if (core) {
                const ptr = core.cpo_history_buffer() >>> 0;
                const buffer = new Uint8Array(core.memory.buffer, ptr, value.length);
                try {
                    buffer.set(value);
                    if (compressed) {
                        const length = core.cpo_history_decompress(index, value.length) >>> 0;
                        if (!length || length > 111016) throw new Error('Corrupt compressed snapshot row.');
                        const decoded = new Uint8Array(core.memory.buffer, core.cpo_history_output() >>> 0, length);
                        flags = decoded[8] | (decoded[9] << 8);
                        textBytes = decoded.slice(HEADER);
                    } else {
                        flags = core.cpo_history_decode(index, value.length) >>> 0;
                        if (!flags) throw new Error('Corrupt snapshot row.');
                    }
                } finally {
                    core.cpo_history_wipe(value.length);
                    if (compressed) core.cpo_history_wipe_output(core.cpo_history_capacity());
                }
            } else {
                const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
                if ((!compressed && view.getUint32(0, false) !== 0x43504f31) || view.getUint32(4, true) !== index ||
                    value[8] < 1 || value[8] > 3 || value[9] > 1 || value[10] || value[11] ||
                    (!compressed && view.getUint32(12, true) !== value.length - HEADER)) throw new Error('Corrupt snapshot row.');
                if (compressed) textBytes = decodeCompressed(textBytes, view.getUint32(12, true));
                flags = value[8] | (value[9] << 8);
            }
            return { index, role: ROLES[flags & 255], truncated: !!(flags & 256),
                text: this.decoder.decode(textBytes) };
        }

        execute(kind, options = {}) {
            const mode = kind === 0 || kind === 4 ? 'readonly' : 'readwrite';
            return this.transaction(mode, async (meta, turns) => {
                let previous = 0;
                let existing;
                let start = 0;
                let result = [];
                let rowIndex = 0;
                const rows = options.records || [];
                let remaining = rows.length;
                let valid = kind === 1 && this.metaValid(kind, null, options);
                for (let step = 0; step < PAGE + 8; step++) {
                    const command = this.core ? this.core.cpo_history_next(kind, previous, Number(valid), remaining) :
                        fallbackNext(kind, previous, valid, remaining);
                    switch (command) {
                        case 1:
                            existing = await request(meta.get('current'));
                            if (kind === 4) {
                                valid = !!existing?.complete;
                                if (valid && (!Number.isSafeInteger(existing.count) || existing.count < 0 ||
                                    existing.count > MAX_TURNS)) throw new Error('Invalid snapshot metadata.');
                                start = valid ? this.pageStart(existing.count, options.start || 0) : 0;
                                remaining = valid ? this.pageSize(existing.count, start) : 0;
                            } else valid = this.metaValid(kind, existing, options);
                            break;
                        case 2: await request(turns.clear()); break;
                        case 3: {
                            const row = rows[rowIndex++];
                            await request(turns.put(row.stored, row.index));
                            remaining--;
                            break;
                        }
                        case 4: await request(meta.put(options.updated, 'current')); break;
                        case 5: await request(meta.clear()); break;
                        case 6:
                            result = await request(turns.getAll(IDBKeyRange.bound(start, start + remaining - 1), remaining));
                            if (result.length !== remaining) throw new Error('Snapshot page is incomplete.');
                            break;
                        case 7:
                            if (kind === 0) return existing;
                            if (kind === 4) return { current: existing, start, records: result };
                            return true;
                        default: throw new Error('Snapshot transaction rejected; source metadata changed or is invalid.');
                    }
                    previous = command;
                }
                throw new Error('Snapshot transaction exceeded its command bound.');
            });
        }

        readMeta() { return this.execute(0); }
        replace(updated) { return this.execute(1, { updated }); }
        append(id, records, updated) { return this.execute(2, { id, records, updated }); }
        finalize(id, updated) { return this.execute(3, { id, updated }); }
        async page(start) {
            const result = await this.execute(4, { start });
            return { ...result, records: result.records.map((row, index) => this.decodeRow(row, result.start + index)) };
        }
        delete(id) { return this.execute(5, { id }); }
    }

    globalThis.CpoHistoryStore = CpoHistoryStore;
    if (typeof module !== 'undefined' && module.exports) module.exports = { CpoHistoryStore, fallbackNext };
})();
