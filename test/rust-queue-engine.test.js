const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../rust-queue-bridge.js');
const wasmPath = path.join(__dirname,'..','optimizer_queue.wasm');
const skip = !fs.existsSync(wasmPath) && 'Build WASM first using cargo run --release --manifest-path Installers/native/Cargo.toml -- build';

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

test('native submission acknowledges only new matching turns or supported generation fallback', {skip}, async () => {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    const e = instance.exports;
    assert.equal(e.cpo_queue_abi(), 17);
    for (let flags = 0; flags < 32; flags++) {
        const expected = flags & 1 ? ((flags & 14) === 10 ? 1 : 0) : (flags & 16 ? 2 : 0);
        assert.equal(e.cpo_submission_ack(flags), expected);
    }
    assert.equal(e.cpo_submission_poll(8000,8000,0),1);
    assert.equal(e.cpo_submission_poll(8001,8000,0),0);
    assert.equal(e.cpo_submission_poll(1,8000,1),2);
    assert.equal(e.cpo_submission_stage(0,0),0);
    assert.equal(e.cpo_submission_stage(1,5),2);
    assert.equal(e.cpo_submission_stage(2,9),3);
});

test('native recovery and persistence retain acknowledged submissions and flush forced checkpoints', {skip}, async () => {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    const e = instance.exports;
    assert.equal(e.cpo_delivery_recovery(0,3,4,3),8);
    assert.equal(e.cpo_delivery_recovery(0,67,4,3),1);
    assert.equal(e.cpo_delivery_recovery(1,5,1,3),3);
    assert.equal(e.cpo_delivery_recovery(2,9,1,3),4);
    assert.equal(e.cpo_delivery_recovery(3,49,1,3),6);
    assert.equal(e.cpo_delivery_recovery(3,33,1,3),7);
    assert.equal(e.cpo_restore_action(2,9),1);
    assert.equal(e.cpo_restore_action(2,12),3);
    assert.equal(e.cpo_restore_action(1,3),2);
    assert.equal(e.cpo_restore_eligible(5,1,0,1),0);
    assert.equal(e.cpo_restore_eligible(5,1,0,0),1);
    assert.equal(e.cpo_restore_eligible(5.5,1,0,0),0);
    for (let flags=0; flags<64; flags++) {
        const expected = flags & 1 ? (flags & 16 ? 2 : 0) :
            (flags & 2) || (flags & 12) === 12 ? 1 : flags & 16 ? 2 : flags & 32 ? 4 : 3;
        assert.equal(e.cpo_persist_action(flags),expected);
    }
});

test('scheduler keeps full epoch precision and rejects early or duplicate claims', {skip}, async () => {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    engine.install(instance.exports);
    const now = 1800000000000;
    const item = {status:'pending',dueTs:now+1};
    assert.equal(engine.schedule(4,item,now),4);
    assert.equal(engine.schedule(4,item,now+1),1);
    assert.equal(engine.schedule(4,{...item,status:'firing'},now+1),0);
    assert.equal(engine.schedule(5,{...item,status:'firing'},now),5);
    assert.equal(engine.schedule(1,{...item,status:'completed'},now),2);
    assert.equal(engine.schedule(4,{...item,dueTs:NaN},now),0);
    assert.equal(engine.numeric('cpo_schedule_compare',[now,now+1,now,now]),0);
    assert.equal(engine.scheduleIdentity({type:'existing',provider:'chatgpt',conversationId:'a'},
        {type:'existing',provider:'chatgpt',conversationId:'b'}),0);
    assert.equal(engine.scheduleIdentity({type:'existing',provider:'chatgpt',conversationId:'a'},
        {type:'existing',provider:'chatgpt',conversationId:'a'}),1);
});

test('native provider routing and marker matching preserve legacy identities', {skip}, async () => {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    const registry = require('../rust-browser-bridge.js');
    const urls = [
        'https://chatgpt.com/', 'https://chat.openai.com/c/abc-1',
        'https://chatgpt.com/g/tool/c/abc', 'https://chatgpt.com/g/my_gpt/',
        'https://chatgpt.com/settings', 'https://chatgpt.com/c/',
        'https://gemini.google.com/', 'https://gemini.google.com/app/abc',
        'https://gemini.google.com/u/12/app/', 'https://gemini.google.com/u/2/app/xyz',
        'https://gemini.google.com/app/app', 'https://gemini.google.com/app/abc/extra',
        'https://claude.ai/new', 'https://claude.ai/chat/abc', 'https://claude.ai/chat/abc/',
        'https://claude.ai/chat/abc/extra', 'https://claude.ai/settings',
        'http://chatgpt.com/', 'https://chatgpt.com.evil.example/'
    ];
    const oldEngine = globalThis.CpoQueueEngine;
    try {
        globalThis.CpoQueueEngine = undefined;
        const expected = urls.map(url => registry.getConversationIdentity(url));
        engine.install(instance.exports);
        globalThis.CpoQueueEngine = engine;
        assert.deepEqual(urls.map(url => registry.getConversationIdentity(url)), expected);
        const marker = 'deep research';
        for (const offset of [0, 1000, 1010, 1020, 2030, 10000]) {
            assert.equal(engine.contains('x'.repeat(offset)+marker+'x',marker),true);
        }
        assert.equal(engine.contains('x'.repeat(6000),marker),false);
        assert.equal(engine.contains('',''),true);
    } finally { globalThis.CpoQueueEngine = oldEngine; }
});

test('native response classifier prioritizes failure and active tool turns over terminal text', {skip}, async () => {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    const e = instance.exports;
    assert.equal(e.cpo_response_class(1|256|512),1);
    assert.equal(e.cpo_response_class(2|8),2);
    assert.equal(e.cpo_response_class(8|16),3);
    assert.equal(e.cpo_response_class(64|512),7);
    assert.equal(e.cpo_response_class(128),8);
    assert.equal(e.cpo_response_class(4096|256),9);
    assert.equal(e.cpo_response_class(256),13);
    assert.equal(e.cpo_response_class(0),0);
    assert.equal(e.cpo_generation_state(1|32),35);
    assert.equal(e.cpo_generation_state(1|8|32),8);
    assert.equal(e.cpo_wait_failure(1|2|4),1);
    assert.equal(e.cpo_wait_settle(8|16|32),4);
    assert.equal(e.cpo_wait_settle(8|16|32|256),0);
    assert.equal(e.cpo_wait_settle(8|16|32|2),0);
    assert.equal(e.cpo_wait_settle(64),5);
});

test('native rollover decisions respect persisted stage checkpoints', {skip}, async () => {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    const e = instance.exports;
    const owned = 1|2;
    assert.equal(e.cpo_rollover_next(0,0),0);
    assert.equal(e.cpo_rollover_next(0,1),1);
    assert.equal(e.cpo_rollover_next(0,owned),2);
    assert.equal(e.cpo_rollover_next(1,owned|4),3);
    assert.equal(e.cpo_rollover_next(2,owned|4),4);
    assert.equal(e.cpo_rollover_next(2,owned|4|64),5);
    assert.equal(e.cpo_rollover_next(2,owned|4|32),6);
    assert.equal(e.cpo_rollover_next(3,owned|4|8|16),7);
    assert.equal(e.cpo_rollover_next(4,owned),8);
    assert.equal(e.cpo_rollover_next(4,owned|512),9);
    assert.equal(e.cpo_rollover_next(3,owned|128),10);
    assert.equal(e.cpo_rollover_next(3,owned|256),11);
    assert.equal(e.cpo_rollover_fresh(1,1|2|4),1);
    assert.equal(e.cpo_rollover_fresh(1,1|2),0);
    assert.equal(e.cpo_rollover_fresh(2,1|16),1);
    assert.equal(e.cpo_rollover_fresh(2,16),0);
    assert.equal(e.cpo_rollover_generation(3,0),4);
    assert.equal(e.cpo_rollover_generation(4,1),4);
});

test('native queue serialization matches JSON.stringify for durable snapshots', {skip}, async () => {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    engine.install(instance.exports);
    const values = [
        {runningJobs:{},queueDurableJobs:{},isRunning:false},
        {queue:['quote " slash \\', '\n\r\t\b\f\u0000', '\ud800', '\udc00', 'x'.repeat(1023)+'😀','a'.repeat(20000)],currentMessage:'こんにちは',n:123,negativeZero:-0,ts:1800000000000},
        {2:'two',1:'one',a:undefined,b:null,c:[true,false,undefined,NaN,Infinity],d:1e-20,e:1e21},
        {nested:{a:[{},[],null]}}
    ];
    for(const value of values)assert.equal(engine.serialize(value),JSON.stringify(value));
    const cyclic={};cyclic.self=cyclic;
    assert.equal(engine.serialize(cyclic),null);
    assert.equal(engine.serialize(new Date()),null);
    const e=instance.exports;
    assert.ok(new Uint16Array(e.memory.buffer,e.cpo_fingerprint_buffer(),e.cpo_fingerprint_capacity()).every(n=>n===0));
    assert.ok(new Uint16Array(e.memory.buffer,e.cpo_json_output(),e.cpo_fingerprint_capacity()*6).every(n=>n===0));
});

test('tab lifecycle rejects protected tabs and requires final safety confirmation', {skip}, async () => {
    const {instance} = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
    engine.install(instance.exports);
    const now=1800000000000;
    const tab={id:5,active:false,status:'complete',lastAccessed:now-900000};
    assert.equal(engine.tabDiscard(tab,0,0,15,now,'chatgpt'),1);
    assert.equal(engine.tabDiscard({...tab,lastAccessed:now-899999},0,0,15,now,'chatgpt'),0);
    for(const key of ['active','highlighted','pinned','audible','incognito','discarded']){
        assert.equal(engine.tabDiscard({...tab,[key]:true},0,0,15,now,'chatgpt'),0);
    }
    assert.equal(engine.tabDiscard(tab,1,1,0,now,'chatgpt',false,true,true),1);
    assert.equal(engine.tabDiscard(tab,1,1,0,now,'chatgpt',true,true,true),0);
    assert.equal(engine.tabDiscard(tab,1,1,0,now,'chatgpt',false,false,true),0);
    assert.equal(engine.tabDiscard(tab,1,1,0,now,'chatgpt',false,true,false),0);
    const e=instance.exports;
    assert.equal(e.cpo_tab_reload_next(0,0),1);
    assert.equal(e.cpo_tab_reload_next(1,6),2);
    assert.equal(e.cpo_tab_reload_next(2,6),3);
    assert.equal(e.cpo_tab_reload_next(3,1),4);
    assert.equal(e.cpo_tab_recover_poll(1,30000,2),0);
    assert.equal(e.cpo_tab_recover_poll(1,30000,1),2);
});

test('native durable projection and restoration preserve the complete checkpoint schema', {skip}, async () => {
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const now=1800000000000;
    const source={
        tabId:42,provider:'chatgpt',conversationId:'abc',conversationType:'existing',targetKey:'chatgpt:c:abc',
        queue:['next','later'],currentMessage:'active',isRunning:true,isPaused:false,isStopped:false,
        runId:'run',totalMessages:5,completedCount:2,currentCommandNumber:3,currentPhase:'awaiting-response',
        deliveryState:'confirmed-submission',commandId:'command',commandFingerprint:'fnv1a:a:len:6',
        submittedUserTurnId:'user-turn',assistantTurnId:'assistant-turn',
        retryMode:'unlimited',retryAttemptCount:2,nextRetryAt:now+1000,
        rolloverInProgress:true,rolloverStage:'handoff-waiting',rolloverReason:'capacity',
        rolloverFromConversationId:'old',rolloverToConversationId:'abc',rolloverNavigationStarted:true,
        rolloverRebindApplied:true,handoffSubmitted:true,handoffEstablished:false,handoffFingerprint:'handoff',
        conversationGeneration:3,startedAt:now-1000,updatedAt:now,
        isProcessing:true,internalTransient:'never persist'
    };
    const result=engine.projectDurable(source);
    assert.equal(result.ok,true);
    const stored=result.value;
    assert.equal(Object.keys(stored).length,51);
    assert.equal(stored.isProcessing,undefined);
    assert.equal(stored.internalTransient,undefined);
    assert.notEqual(stored.queue,source.queue);
    for(const key of Object.keys(source)){
        if(key==='isProcessing'||key==='internalTransient')continue;
        assert.deepEqual(stored[key],source[key],key);
    }
    const decoded=engine.deserializeDurable(JSON.parse(JSON.stringify(stored)),now,()=>{throw Error('existing run ID must survive');});
    assert.equal(decoded.ok,true);
    assert.deepEqual(decoded.value,stored);
    assert.equal(engine.confirmed(decoded.value),1);
    assert.equal(engine.next(decoded.value,true),1);
    assert.equal(engine.next({...decoded.value,rolloverInProgress:false},true),3);
});

test('native deserialization reconstructs legacy defaults and trims long prompts without damaging Unicode', {skip}, async () => {
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const now=1800000000000;
    const body='a'.repeat(5000)+'😀'+'\ud800';
    const raw={tabId:'7',targetKey:'chatgpt:new',queue:['\uFEFF'+ ' '.repeat(2048)+body+'\u2003'.repeat(2050),'\t\n','  next  '],
        currentMessage:'  active  ',completedCount:'2',isPaused:true,waitForIdleBeforeSend:true,retryMode:'legacy'};
    const restored=engine.deserializeDurable(raw,now,()=> 'generated-run');
    assert.equal(restored.ok,true);
    const job=restored.value;
    assert.equal(job.tabId,7);
    assert.equal(job.provider,'chatgpt');
    assert.equal(job.conversationType,'new');
    assert.equal(job.targetKey,'chatgpt:new');
    assert.deepEqual(job.queue,[body,'next']);
    assert.equal(job.currentMessage,'active');
    assert.equal(job.currentCommandNumber,3);
    assert.equal(job.totalMessages,5);
    assert.equal(job.currentPhase,'waiting-for-idle');
    assert.equal(job.isRunning,false);
    assert.equal(job.isPaused,true);
    assert.equal(job.retryMode,'');
    assert.equal(job.startedAt,now);
    assert.equal(job.updatedAt,now);
    assert.equal(job.runId,'generated-run');
    assert.equal(job.conversationId,null);
    assert.equal(engine.projectDurable({...job,currentMessage:null}).value.currentMessage,'');
    assert.equal(engine.deserializeDurable({tabId:8,queue:['next']},now,()=> 'run').value.currentMessage,null);
    const e=instance.exports;
    assert.ok(new Uint16Array(e.memory.buffer,e.cpo_fingerprint_buffer(),e.cpo_fingerprint_capacity()).every(n=>n===0));
});

test('native deserialization rejects malformed or non-runnable durable jobs', {skip}, async () => {
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const base={tabId:7,queue:['next'],runId:'run'};
    for(const patch of [
        {tabId:0},{tabId:1.5},{tabId:Number.MAX_SAFE_INTEGER+1},{queue:[]},
        {queue:[{text:'unexpected'}]},{queue:'not an array'},{isStopped:true},
        {currentMessage:{}},{isPaused:'true'},{completedCount:-1},
        {nextRetryAt:Infinity},{startedAt:'invalid'},{submittedUserTurnId:17}
    ]){
        const result=engine.deserializeDurable({...base,...patch},1800000000000,()=> 'run');
        assert.equal(result.ok,false,JSON.stringify(patch));
    }
});

test('native application settings, popup progress and logging policy', {skip}, async () => {
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const e=instance.exports;
    assert.deepEqual(engine.settings({windowSize:900,batchSize:2,resourceBudget:'bad',inactiveTabMinutes:16,
        adaptiveBudget:true,enabled:null,autoScroll:false}),{windowSize:500,batchSize:5,resourceBudget:8000,
        inactiveTabMinutes:0,enabled:true,autoScroll:false,adaptiveBudget:true});
    assert.deepEqual(engine.settings({queueUnlimitedRetryWait:true,queueDeepResearchAware:false,queueDeliveryTimeoutRefresh:null},'queue'),
        {queueUnlimitedRetryWait:true,queueDeepResearchAware:false,queueDeliveryTimeoutRefresh:true});
    assert.equal(engine.remaining({1:{remaining:4},2:{remaining:3}}),7);
    assert.equal(e.cpo_popup_status(1|4),0);
    assert.equal(e.cpo_popup_status(0),10);
    for(const key of ['prompt','accesstoken','assistantpreview','filepath','authorization','tooloutput']){
        assert.equal(engine.sensitiveKey(key),1,key);
    }
    assert.equal(engine.sensitiveKey('commandnumber'),0);
    assert.equal(e.cpo_log_limit(0,0,701),697);
    assert.equal(e.cpo_log_keep_start(299,10,300),9);
    assert.equal(e.cpo_log_duplicate(1,29999,30000),1);
    assert.equal(e.cpo_log_duplicate(1,30000,30000),0);
});

test('native browser API routing and event classification reject unknown names and arity', {skip}, async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    assert.equal(engine.eventCode(0,'CPO_HISTORY_BATCH'),5);
    assert.equal(engine.eventCode(0,'CHECK_GENERATION_STATE'),9);
    assert.equal(engine.eventCode(1,'stopSequence'),6);
    assert.equal(engine.eventCode(1,'authorizeNativeQueueClick'),1);
    assert.equal(engine.eventCode(2,'tabDiscard'),11);
    assert.equal(engine.eventCode(2,'__proto__'),0);
    assert.equal(engine.eventCode(2,'tabSend '),0);
    assert.equal(engine.call('cpo_content_event_kind',[5]),3);
    assert.equal(engine.call('cpo_content_event_kind',[13]),2);
    assert.equal(engine.call('cpo_api_mode',[9,2,3]),1);
    assert.equal(engine.call('cpo_api_mode',[9,2,2]),2);
    assert.equal(engine.call('cpo_api_mode',[9,1,3]),0);
    assert.equal(engine.call('cpo_api_mode',[99,1,3]),0);
    assert.equal(engine.call('cpo_api_mode',[11,1,0]),0);
});

test('native method paths, injection capability and completion transitions',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    assert.deepEqual(engine.apiPath(1),['storage','local','get']);
    assert.deepEqual(engine.apiPath(13),['scripting','executeScript']);
    assert.deepEqual(engine.apiPath(16),['tabs','insertCSS']);
    assert.equal(engine.apiPath(99),null);
    assert.equal(engine.call('cpo_injection_route',[0,1|2|4|16]),13);
    assert.equal(engine.call('cpo_injection_route',[1,2|4|16]),16);
    assert.equal(engine.call('cpo_injection_route',[1,2|8|16]),0);
    assert.equal(engine.call('cpo_async_transition',[0,1]),1);
    assert.equal(engine.call('cpo_async_transition',[1,2]),0);
});

test('native live jobs preserve queue order, revision and durable recovery schema',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const jobs=engine.createLiveJobs();
    jobs.set(17,{tabId:17,queue:['second','third'],runId:'run-17',
        provider:'chatgpt',conversationType:'existing',conversationId:'abc',
        targetKey:'chatgpt:c:abc',isRunning:true,isPaused:false,isStopped:false,
        currentMessage:null,currentPhase:'queued',totalMessages:2,completedCount:0,
        startedAt:1800000000000,updatedAt:1800000000000});
    const job=jobs.get(17);
    job.queue.unshift('first');
    job.queue.splice(1,0,'next');
    job.queue.push('last\ud800');
    assert.deepEqual([...job.queue],['first','next','second','third','last\ud800']);
    assert.equal(job.queue.shift(),'first');
    assert.deepEqual([...job.queue],['next','second','third','last\ud800']);
    const revision=jobs.revision();
    job.isProcessing=true;
    assert.equal(jobs.revision(),revision);
    job.currentPhase='queued';
    assert.equal(jobs.revision(),revision);
    const checkpoint=jobs.checkpoint(job);
    assert.deepEqual(checkpoint.queue,['next','second','third','last\ud800']);
    assert.equal(checkpoint.totalMessages,4);
    assert.deepEqual(jobs.checkpoint(job),checkpoint);
    job.currentMessage=job.queue.shift();
    assert.ok(jobs.revision()>revision);
    const second=jobs.checkpoint(job);
    assert.equal(second.currentMessage,'next');
    assert.deepEqual(second.queue,['second','third','last\ud800']);
    assert.deepEqual(checkpoint.queue,['next','second','third','last\ud800']);
    assert.equal(engine.deserializeDurable(second,1800000000000,()=> 'replacement').ok,true);
    jobs.delete(17);
    jobs.set(17,{tabId:17,queue:['replacement'],isRunning:true});
    job.currentMessage='stale';
    job.queue.push('stale');
    assert.deepEqual([...jobs.get(17).queue],['replacement']);
    assert.notEqual(jobs.get(17),job);
    jobs.clear();
    assert.equal(jobs.size,0);
});

test('native provider catalogs, keyboard and diagnostic policies',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    assert.equal(engine.providerCatalog(1).composer[0],'#prompt-textarea');
    assert.equal(engine.providerCatalog(2).composer[0],'.ql-editor[contenteditable="true"]');
    assert.equal(engine.providerCatalog(3).composer[0],'[data-testid="chat-input"]');
    assert.equal(engine.providerCatalog(4).turnContext.length,3);
    assert.equal(engine.call('cpo_provider_predicate',[2,2,8]),1);
    assert.equal(engine.call('cpo_provider_predicate',[2,2,40]),0);
    assert.equal(engine.call('cpo_provider_predicate',[3,2,16]),1);
    for(let flags=0;flags<128;flags++)assert.equal(engine.call('cpo_enter_eligible',[flags]),Number(flags===1));
    assert.equal(engine.numeric('cpo_enter_action',[5,1199]),2);
    assert.equal(engine.numeric('cpo_enter_action',[5,1200]),3);
    assert.equal(engine.numeric('cpo_enter_action',[3,0]),1);
    assert.equal(engine.diagnosticText('  a\t b  ',10),'a b');
    assert.equal(engine.diagnosticText('  abcdef ',4),'abc…');
    const result=engine.sanitizeDiagnostic({prompt:'secret',nested:{token:{redacted:true,secret:'leak'},ok:true}},0,'',
        key=>['prompt','token'].includes(key),error=>({message:error.message}));
    assert.deepEqual(result,{ok:true,value:{prompt:{redacted:true,length:6},nested:{token:{redacted:true},ok:true}}});
});

test('native scheduled collections, identity and popup formatters',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const a={id:'a',dueTs:10,createdAt:5,status:'pending'},b={id:'b',dueTs:1,createdAt:9,status:'pending'},c={id:'c',dueTs:10,createdAt:5,status:'failed'};
    assert.deepEqual(engine.scheduledSort([a,b,c]),[b,a,c]);
    assert.deepEqual(engine.scheduledLookup([a,b,c],'b'),[b]);
    assert.deepEqual(engine.scheduledWithout([a,b,c],'b'),[a,c]);
    assert.deepEqual(engine.scheduledDue([a,b,c],null,10),[a,b]);
    assert.deepEqual(engine.scheduledDue([a,b,c],'a',9),[]);
    assert.equal(engine.identityKey('chatgpt','existing','abc'),'chatgpt:c:abc');
    assert.equal(engine.identityKey('claude','new',null),'claude:new');
    assert.equal(engine.identityKey('chatgpt','existing','abc','preserved'),'preserved');
    assert.match(engine.continuationHandoff({runId:'  test  id ',pendingMessageLength:4}),/Logical run id: test id.*pending \(length 4\)/);
    assert.equal(engine.textBatch(8,['ChatGPT - Example – Claude']),'Example');
    assert.equal(engine.popupStatus({currentPhase:'retry_wait'}),'Retrying');
    assert.equal(engine.popupRunningLabel('Tab','Queued',{totalMessages:2,completedCount:1,remaining:1}),'Tab | Queued | Done: 1/2 | Remaining: 1');
    assert.equal(engine.popupScheduledLabel({status:'pending',text:' a  b '},'Tab','Today'),'Tab | Pending | Today | a b');
    const tabs=[{id:1,url:'https://chatgpt.com/'},{id:1,url:'https://claude.ai/'},{id:2,url:'https://claude.ai/',active:true},{id:3,url:'https://example.com/'}];
    assert.deepEqual(engine.supportedTabs(tabs),[tabs[2],tabs[0]]);
    assert.equal(engine.popupStats('ChatGPT',{messageCount:2,hiddenCount:0,visibleCount:2})[0],'Target: ChatGPT');
    assert.equal(engine.popupStats('ChatGPT',{messageCount:2,hiddenCount:0,visibleCount:2,debugInfo:{resources:{}}}).length,26);
});

test('native sequence names, ordered variable collection, keyboard and date policy',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    assert.equal(engine.sequenceName('  Test  ',['Test','Test 2','Test 4']),'Test 3');
    assert.equal(engine.sequenceName('',[]),'Imported sequence');
    assert.equal(engine.sequenceName('__proto__',[]),'__proto__ 2');
    assert.equal(engine.validSequenceName('__proto__'),false);
    assert.equal(engine.validSequenceName('__edit_selected_sequence__'),false);
    assert.equal(engine.validSequenceName('Example'),true);
    assert.deepEqual(engine.sequenceVariables(['{{ x }} {{y}} {{ x}}','{{z}} {{a\nb}} {{ }}','{{x}} {{\ud800}}']),['x','y','z','\ud800']);
    assert.equal(engine.keyboardEvent({key:'Enter',keyCode:13}),1);
    for(const modifier of ['shiftKey','altKey','ctrlKey','metaKey','isComposing'])assert.equal(engine.keyboardEvent({key:'Enter',[modifier]:true}),0);
    assert.equal(engine.keyboardEvent({key:'Enter',keyCode:229}),0);
    assert.equal(engine.keyboardEvent({key:'Escape'}),0);
    assert.deepEqual(engine.localDateParts(' 2024-02-29T23:59 '),[2024,2,29,23,59]);
    for(const value of ['2023-02-29T12:00','1900-02-29T12:00','2026-04-31T12:00','2026-01-01T24:00','2026-01-01T01:60','0099-01-01T12:00'])assert.equal(engine.localDateParts(value),null);
    assert.equal(engine.localDateMatches([2024,2,29,23,59],[2024,2,29,23,59]),true);
    assert.equal(engine.localDateMatches([2024,2,29,23,59],[2024,3,1,0,59]),false);
    assert.equal(engine.localDateInput([2026,1,2,3,4]),'2026-01-02T03:04');
    assert.equal(engine.timestampValid(Infinity),false);
    assert.equal(engine.timestampMath(3,1800000000001,300000),1800000360000);
    assert.equal(engine.timestampMath(4,0,1800000000000,60000),1800000060000);
});


test('native job transactions retain confirmed prompts, revisions and snapshot privacy',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const jobs=engine.createLiveJobs();
    jobs.set(1,{tabId:1,provider:'chatgpt',conversationType:'new',targetKey:'chatgpt:new',queue:['a🌍','b'],currentMessage:null,isRunning:true,isPaused:false,isStopped:false,totalMessages:2,completedCount:0,runId:'r'});
    const job=jobs.get(1);
    let epoch=jobs.revision();
    jobs.transaction(job,2,0,{currentMessage:'secret'});
    assert.equal(jobs.revision(),epoch+1);
    assert.deepEqual([...job.queue],['secret','a🌍','b']);
    assert.equal(job.totalMessages,3);
    jobs.transaction(job,7,0,{currentMessage:'secret',commandId:'r:1',commandFingerprint:engine.fingerprint('secret')});
    assert.equal(job.currentMessage,'secret');
    const snapshot=jobs.runningSnapshot()[1];
    assert.equal(snapshot.currentMessageLength,6);
    assert.equal(snapshot.nextMessageLength,3);
    assert.equal(snapshot.remaining,3);
    assert.equal(Object.hasOwn(snapshot,'currentMessage'),false);
    jobs.transaction(job,0,0,{deliveryState:'confirmed-submission',submittedUserTurnId:'turn-1'});
    jobs.transaction(job,4,0,{pausedReason:'error'});
    assert.equal(job.currentMessage,'secret');
    assert.deepEqual([...job.queue],['a🌍','b']);
    jobs.transaction(job,5);
    assert.equal(job.currentPhase,'awaiting-response');
    jobs.transaction(job,3);
    assert.equal(job.completedCount,1);
    assert.equal(job.currentMessage,null);
    assert.equal(job.deliveryState,'');
    assert.equal(job.queue.length,2);
    assert.equal(engine.classifyFailure('wait','DELIVERY TIMEOUT',{}).class,'timeout');
    assert.equal(engine.classifyFailure('send','queue was stopped',{}).retryable,false);
    assert.equal(engine.bindingDecision({provider:'chatgpt',conversationType:'existing',conversationId:'a'},{provider:'chatgpt',type:'existing',conversationId:'b'}),5);
    const scheduled={status:'pending',dueTs:1000};
    assert.equal(engine.scheduledMutation(4,scheduled,999),false);
    assert.equal(engine.scheduledMutation(4,scheduled,1000),true);
    assert.equal(scheduled.status,'firing');
    assert.equal(engine.scheduledMutation(7,scheduled,1001),true);
    assert.equal(scheduled.completedAt,1001);
});


test('native provider snapshots preserve exact-match safety and response association',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const rows=[[1,'u1','','fp1',0,''],[2,'a1','','fpA',16,''],[1,'u2','','fp2',1,''],[2,'a2','','fpB',8,'']];
    const snap=engine.providerTurnSnapshot(rows,'fp2',true);
    assert.equal(snap.matchedUserTurnId,'u2');
    assert.equal(snap.latestAssistantTurnId,'a2');
    assert.equal(snap.assistantTurns[0].followingUserTurnId,'u1');
    assert.equal(snap.assistantTurns[0].hasCompletedText,true);
    assert.equal(engine.providerBoundResponse(snap,{userTurnId:'u1'},{}).phase,'terminal');
    assert.equal(engine.providerBoundResponse(snap,{userTurnId:'u2'},{}).source,'incomplete-tool-turn');
    assert.equal(engine.providerBoundResponse(snap,{userTurnId:'u2'},{hasDeliveryTimedOut:true}).source,'delivery-timeout');
    assert.equal(engine.providerTurnSnapshot([[1,'u','','collision',0,'']],'collision',true).matchedUserTurnId,null);
    assert.equal(engine.providerTurnSnapshot([[1,'u','','collision',0,'']],'collision',false).matchedUserTurnId,'u');
    assert.equal(engine.textBatch(22,['Something went wrong. Later']), 'something went wrong');
    assert.equal(engine.textBatch(22,['Something went wrongish']), '');
    assert.equal(engine.providerSemanticButton(1,[[0,'retry','',''],[1,'other','Try again','']]),1);
    assert.equal(engine.providerSemanticButton(0,[[1,'stop-generating','','']]),0);
});

test('native semantic observation spans all supported providers',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const button=(label,disabled=false)=>({disabled,getAttribute:k=>k==='aria-label'?label:'',innerText:'',className:''});
    const stop=button('Stop generating');
    assert.deepEqual(engine.providerButtons(2,0,[button('Stop',true),stop,button('Submit')]),[stop]);
    const observation=engine.providerGenerationText(1,'Deep research','maximum length for this conversation');
    assert.equal(observation.capacity,true);
    assert.equal(observation.deep,true);
    assert.equal(observation.error,'conversation-max-length');
    assert.deepEqual(engine.providerDiagnostics(7,0,true),['empty-conversation']);
});

test('native provider generation state resolves errors, capacity, retry and progress',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    const deep=engine.providerGenerationState(1,' Deep research  ','',1);
    assert.equal(deep.generating,true);
    assert.equal(deep.deepResearchActive,true);
    assert.equal(deep.statusText,'Deep research');
    const capacity=engine.providerGenerationState(1,'','maximum length for this conversation',17);
    assert.equal(capacity.capacity,true);
    assert.equal(capacity.hasTryAgainButton,false);
    assert.equal(capacity.error,'conversation-max-length');
    const external=engine.providerGenerationState(2,'Thinking','There was an error',0);
    assert.equal(external.hasKnownError,true);
    assert.equal(external.deepResearchActive,false);
    assert.equal(external.research,'thinking');
});

test('native turn metadata streams fingerprints and avoids reading cached DOM text',{skip},async()=>{
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(wasmPath),{});
    engine.install(instance.exports);
    let reads=0;
    const source='  Something    went wrong. '+('large text '.repeat(2000));
    const metadata=engine.providerTurnMetadata(7,1,2,()=>{reads++;return source;});
    assert.equal(metadata.fingerprint,engine.fingerprint(source));
    assert.equal(metadata.errorSignal,'something went wrong');
    assert.equal(metadata.hasText,true);
    assert.deepEqual(engine.providerTurnMetadata(7,1,2,()=>{throw Error('cache miss');}),metadata);
    assert.equal(reads,1);
    assert.equal(engine.invalidateProviderTurn(7,1),true);
    assert.equal(engine.providerTurnMetadata(7,1,2,()=>{reads++;return 'changed';}).errorSignal,'');
    assert.equal(reads,2);
    assert.equal(engine.providerTurnMetadata(7,1,1,()=>source).errorSignal,'');
    assert.equal(engine.invalidateProviderTurn(7),true);
    assert.equal(engine.providerTurnMetadata(7,1,2,()=> '  ').hasText,false);
    assert.deepEqual(engine.providerLastAssistant(4,'',''),{hasError:false,hasDeliveryTimeout:false,hasCompletedText:true,errorSignal:''});
    assert.equal(engine.providerLastAssistant(4,'Message delivery timed out','').hasCompletedText,false);
});
