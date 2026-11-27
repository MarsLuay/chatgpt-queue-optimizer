const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../rust-queue-bridge.js');
const wasmPath = path.join(__dirname,'..','optimizer_queue.wasm');
const skip = !fs.existsSync(wasmPath) && 'Build WASM first using Installers/build_optimizer.py';

function legacy(text) {
    const normalized = String(text || '').replace(/\s+/g,' ').trim();
    let hash = 2166136261;
    for (let i=0; i<normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash,16777619);
    }
    return 'fnv1a:'+(hash>>>0).toString(16)+':len:'+normalized.length;
}

test('Rust fingerprint is identical to legacy FNV for whitespace, surrogates and chunk boundaries',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    for(const value of ['',null,0,'  one\t two\n ', '\uFEFF\u2003a\u2028b\u202f',
        '\u0085\u180e\u200b', '\ud800\udfff', 'a'.repeat(1023)+'🌍\t end',
        ('a\t b 🌍\uFEFF').repeat(10000), 'x'.repeat(1024)+' '.repeat(4096)]) {
        assert.equal(engine.fingerprint(value),legacy(value));
    }
    const e=instance.exports;
    assert.ok(new Uint16Array(e.memory.buffer,e.cpo_fingerprint_buffer(),e.cpo_fingerprint_capacity()).every(v=>v===0));
});

test('Rust dispatcher retains legacy priority for every flag combination',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    const e=instance.exports;
    for(let flags=0;flags<128;flags++) for(let phase=0;phase<5;phase++) for(const queued of [0,5]){
        let expected;
        if(!(flags&1)||(flags&6)) expected=0;
        else if((flags&32)||phase===4) expected=1;
        else if(flags&8) expected=phase===1?2:phase===2?3:phase===3?4:(flags&16)?5:6;
        else expected=queued===0?7:(flags&64)?8:9;
        assert.equal(e.cpo_queue_next(flags,phase,queued),expected);
    }
    for(let attempt=0;attempt<40;attempt++){
        assert.equal(e.cpo_queue_backoff(attempt,2000,2,30000),Math.min(30000,2000*2**attempt));
        assert.equal(e.cpo_queue_can_retry(attempt,3,0),Number(attempt<3));
        assert.equal(e.cpo_queue_can_retry(attempt,3,1),1);
    }
    assert.equal(e.cpo_queue_retry_action(1,1),1);
    assert.equal(e.cpo_queue_retry_action(1,0),2);
    assert.equal(e.cpo_queue_confirmed(0,3),1);
    assert.equal(e.cpo_queue_confirmed(0,0),0);
});
