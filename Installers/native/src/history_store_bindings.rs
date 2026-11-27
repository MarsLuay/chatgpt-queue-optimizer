//! Generate the IndexedDB and browser string/byte interoperability adapter.
//! The history WASM owns validation, codec dispatch and transaction cursors.
use super::Result;
use std::{fs,path::Path};
pub const OUTPUT:&str="history-store.js";
pub fn generate(stage:&Path)->Result<()>{
    fs::write(stage.join(OUTPUT),String::from("// @generated Rust history storage host. DO NOT EDIT.\n")+HOST)?;
    println!("Generated {OUTPUT} from Rust history storage");
    Ok(())
}
const HOST:&str=r###"(() => {
    'use strict';
    const HEADER = 16;
    const ROLES = ['', 'user', 'assistant', 'message'];
    const u32=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff?value:0xffffffff;
    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Local database request failed.'));
    });

    // Browser transaction transport for the required native history engine.
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
                    'cpo_history_page_start','cpo_history_page_size','cpo_reader_buttons','cpo_reader_move',
                    'cpo_reader_batch','cpo_reader_continue','cpo_reader_partial',
                    'cpo_reader_state','cpo_reader_capture','cpo_reader_guard',
                    'cpo_history_tx_mode','cpo_history_tx_step','cpo_history_page_plan','cpo_history_legacy_row',
                    'cpo_history_write_row','cpo_history_read_row'];
                if (!required.every(name => typeof core[name] === 'function') ||
                    core.cpo_history_abi() !== 5 || !(core.memory instanceof WebAssembly.Memory)) {
                    throw new Error('History module ABI mismatch');
                }
                this.core = core;
            } catch (error) {
                this.core = null;
                throw new Error('Required Rust history engine unavailable: '+(error?.message||String(error)));
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
            return this.requireCore().cpo_history_meta_valid(kind, flags, ...nums) === 1;
        }

        requireCore() {
            if(!this.core)throw new Error('Required Rust history engine is unavailable.');
            return this.core;
        }

        pageStart(total, requested) {
            return this.requireCore().cpo_history_page_start(total,requested)>>>0;
        }

        pageSize(total, start) {
            return this.requireCore().cpo_history_page_size(total,start)>>>0;
        }

        prepareRow(row, expected, used) {
            const core=this.requireCore();
            const role=ROLES.indexOf(row?.role);
            const chars=typeof row?.text==='string'?row.text.length:0xffffffff;
            const index=u32(row?.index), target=u32(expected), prior=u32(used);
            if(target>4096||core.cpo_history_row_decision(index,target,role,chars,prior,0)===0)
                throw new Error('Invalid snapshot row.');
            const capacity=core.cpo_history_capacity()>>>0;
            const ptr=core.cpo_history_buffer()>>>0;
            const buffer=new Uint8Array(core.memory.buffer,ptr,capacity);
            let wipeSize=capacity;
            try {
                const result=this.encoder.encodeInto(row.text,buffer.subarray(HEADER));
                wipeSize=HEADER+result.written;
                if(result.read!==chars)throw new Error('Snapshot row exceeds codec capacity.');
                const packed=core.cpo_history_write_row(index,target,role,Number(row.truncated===true),chars,prior,result.written)>>>0;
                if(packed===0)throw new Error('Invalid snapshot row.');
                if(packed===1)return null;
                const length=packed&0x1ffff;
                const output=packed&(1<<17)?core.cpo_history_output()>>>0:ptr;
                return {index,stored:new Uint8Array(core.memory.buffer,output,length).slice(),
                    size:result.written+128,truncated:row.truncated===true};
            } finally {
                core.cpo_history_wipe(wipeSize);
                core.cpo_history_wipe_output(wipeSize);
            }
        }

        decodeRow(value,index) {
            const core=this.requireCore();
            const expected=u32(index);
            if(!(value instanceof Uint8Array)){
                if(core.cpo_history_legacy_row(u32(value?.index),expected,ROLES.indexOf(value?.role),Number(typeof value?.text==='string'))!==1)
                    throw new Error('Invalid saved snapshot row.');
                return value;
            }
            const capacity=core.cpo_history_capacity()>>>0;
            if(value.length<HEADER||value.length>capacity)throw new Error('Corrupt snapshot row.');
            const ptr=core.cpo_history_buffer()>>>0;
            let outputWipe=capacity;
            try {
                new Uint8Array(core.memory.buffer,ptr,value.length).set(value);
                const packed=core.cpo_history_read_row(expected,value.length)>>>0;
                if(!packed)throw new Error('Corrupt snapshot row.');
                const length=packed&0x1ffff;
                const flags=(packed>>>17)&511;
                const compressed=!!(packed&(1<<26));
                outputWipe=compressed?length:0;
                const output=compressed?core.cpo_history_output()>>>0:ptr;
                // TextDecoder consumes the live native view synchronously,
                // before scratch memory is wiped. No intermediate byte copy.
                const text=this.decoder.decode(new Uint8Array(core.memory.buffer,output+HEADER,length-HEADER));
                return {index,role:ROLES[flags&255],truncated:!!(flags&256),text};
            } finally {
                core.cpo_history_wipe(value.length);
                if(outputWipe)core.cpo_history_wipe_output(outputWipe);
            }
        }

        execute(kind,options={}) {
            const core=this.requireCore();
            const mode=core.cpo_history_tx_mode(kind);
            if(!mode)throw new Error('Snapshot transaction rejected.');
            return this.transaction(mode===1?'readonly':'readwrite',async(meta,turns)=>{
                let cursor=0,existing,start=0,result=[];
                const rows=options.records||[];
                let plan=rows.length<=16?(rows.length|(Number(kind===1&&this.metaValid(kind,null,options))<<5)):31;
                for(;;){
                    cursor=core.cpo_history_tx_step(kind,cursor,plan)>>>0;
                    const command=cursor&7;
                    const remaining=(cursor>>>3)&31;
                    switch(command){
                        case 1:
                            existing=await request(meta.get('current'));
                            if(kind===4){
                                const page=core.cpo_history_page_plan(Number(!!existing?.complete),u32(existing?.count??0),u32(options.start??0))>>>0;
                                if(!page)throw new Error('Invalid snapshot metadata.');
                                start=(page-1)>>>5;
                                plan=((page-1)&31)|(Number(!!existing?.complete)<<5);
                            }else plan=rows.length<=16?(rows.length|(Number(this.metaValid(kind,existing,options))<<5)):31;
                            break;
                        case 2:await request(turns.clear());break;
                        case 3:{
                            const row=rows[rows.length-remaining];
                            await request(turns.put(row.stored,row.index));
                            break;
                        }
                        case 4:await request(meta.put(options.updated,'current'));break;
                        case 5:await request(meta.clear());break;
                        case 6:
                            result=await request(turns.getAll(IDBKeyRange.bound(start,start+remaining-1),remaining));
                            if(result.length!==remaining)throw new Error('Snapshot page is incomplete.');
                            break;
                        case 7:
                            if(kind===0)return existing;
                            if(kind===4)return {current:existing,start,records:result};
                            return true;
                        default:throw new Error('Snapshot transaction rejected; source metadata changed or is invalid.');
                    }
                }
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
    if (typeof module !== 'undefined' && module.exports) module.exports = { CpoHistoryStore };
})();
"###;
