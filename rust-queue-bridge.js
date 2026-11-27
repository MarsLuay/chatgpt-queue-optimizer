(() => {
    'use strict';
    let core = null;
    let loading = null;
    let status = 'not loaded';
    let durableSchema = null;
    const phases = ['','terminal','waiting','retry-wait','rollover-in-progress'];
    const delivery = ['','confirmed-submission','active-response','terminal-awaiting-bookkeeping'];
    const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
    function install(exports) {
        const names = ['cpo_queue_abi','cpo_fingerprint_buffer','cpo_fingerprint_capacity',
            'cpo_fingerprint_reset','cpo_fingerprint_update','cpo_fingerprint_hash','cpo_fingerprint_len',
            'cpo_queue_next','cpo_queue_retry_action','cpo_queue_confirmed','cpo_queue_remaining',
            'cpo_queue_total','cpo_queue_can_retry','cpo_queue_backoff',
            'cpo_submission_ack','cpo_submission_poll','cpo_submission_stage','cpo_delivery_recovery',
            'cpo_restore_action','cpo_restore_eligible','cpo_restore_command_number','cpo_persist_action',
            'cpo_schedule_action','cpo_schedule_compare','cpo_schedule_identity',
            'cpo_provider_host','cpo_provider_route','cpo_marker_contains','cpo_generation_state',
            'cpo_response_class','cpo_wait_failure','cpo_wait_settle','cpo_rollover_next','cpo_rollover_fresh','cpo_rollover_generation',
            'cpo_json_output','cpo_json_escape','cpo_json_wipe','cpo_json_token','cpo_tab_discard','cpo_tab_alarm',
            'cpo_tab_reload_next','cpo_tab_recover_poll','cpo_tab_close_action',
            'cpo_durable_field_count','cpo_durable_field_rule','cpo_durable_field_name','cpo_durable_default',
            'cpo_durable_number','cpo_durable_boolean','cpo_durable_retry_mode','cpo_durable_trim',
            'cpo_setting_number','cpo_setting_bool','cpo_popup_status','cpo_popup_remaining','cpo_popup_schedule_actions',
            'cpo_log_duplicate','cpo_log_keep_start','cpo_log_limit','cpo_log_sensitive'];
        if (!names.every(name => typeof exports[name] === 'function') ||
            exports.cpo_queue_abi() !== 6 || !(exports.memory instanceof WebAssembly.Memory)) throw new Error('Queue WASM ABI mismatch');
        core = exports;
        durableSchema = null;
        status = 'Rust/WASM';
    }
    function fail(error) {
        core = null;
        status = 'unavailable';
        console.warn('CPO: native queue engine unavailable; using compatible JS execution.', error);
    }
    function load() {
        if (core || status === 'unavailable') return Promise.resolve(!!core);
        if (loading) return loading;
        if (typeof chrome === 'undefined' || typeof chrome.runtime?.getURL !== 'function' ||
            typeof WebAssembly === 'undefined' || typeof fetch !== 'function') return Promise.resolve(false);
        status = 'loading';
        loading = (async () => {
            try {
                const response = await fetch(chrome.runtime.getURL('optimizer_queue.wasm'));
                if (!response.ok) throw new Error('Queue WASM resource unavailable');
                const result = await WebAssembly.instantiate(await response.arrayBuffer(), {});
                install(result.instance.exports);
                return true;
            } catch (error) {
                fail(error);
                return false;
            } finally { loading = null; }
        })();
        return loading;
    }
    function call(name, args) {
        if (!core || args.some(value => count(value) === null)) return null;
        try { return core[name](...args) >>> 0; }
        catch (error) { fail(error); return null; }
    }
    // Timestamp-bearing exports accept f64 to preserve epoch milliseconds.
    function numeric(name, args) {
        if (!core || args.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
        try { return core[name](...args) >>> 0; }
        catch (error) { fail(error); return null; }
    }
    function schedule(action, item, now = Date.now()) {
        const state = Math.max(0, ['', 'pending', 'firing', 'completed', 'failed', 'cancelled'].indexOf(item?.status));
        const due = Number(item?.dueTs || 0);
        return numeric('cpo_schedule_action', [action, state, Number.isFinite(due) ? due : 0, now]);
    }
    function scheduleIdentity(stored, current) {
        const type = value => {
            const index = ['unknown','existing','new','unsupported'].indexOf(value.conversationType || value.type || 'unknown');
            return index < 0 ? 4 : index;
        };
        const a = stored.targetKey || stored.key || '';
        const b = current.targetKey || current.key || '';
        const flags = Number(!!(stored.provider && current.provider && current.provider !== 'unknown' && stored.provider !== current.provider)) |
            (Number(!!stored.conversationId) << 1) |
            (Number(stored.conversationId === current.conversationId) << 2) |
            (Number(!!(a && b && a === b)) << 3);
        return call('cpo_schedule_identity', [type(stored), type(current), flags]);
    }
    function restoreAction(job, confirmed) {
        const phase = job.currentPhase === 'waiting' ? 1 :
            ['sending','awaiting-submission-ack'].includes(job.currentPhase) ? 2 :
            job.currentPhase === 'terminal' ? 3 : 0;
        const flags = Number(!!confirmed) | (Number(job.deliveryState === 'terminal-awaiting-bookkeeping') << 1) |
            (Number(['pre-click','unknown-acceptance'].includes(job.deliveryState)) << 2) |
            (Number(!!job.currentMessage) << 3);
        return call('cpo_restore_action', [phase, flags]);
    }
    function withUnits(value, operation) {
        if (!core) return null;
        let input;
        try {
            const capacity = core.cpo_fingerprint_capacity() >>> 0;
            if (value.length > capacity) return null;
            input = new Uint16Array(core.memory.buffer, core.cpo_fingerprint_buffer() >>> 0, capacity);
            for (let i = 0; i < value.length; i++) input[i] = value.charCodeAt(i);
            return operation(core, value.length) >>> 0;
        } catch (error) { fail(error); return null; }
        finally { if (input) input.fill(0); }
    }
    function providerHost(host) {
        return withUnits(host, (e,n) => e.cpo_provider_host(n));
    }
    function providerRoute(provider, pathname) {
        const packed = withUnits(pathname, (e,n) => e.cpo_provider_route(provider,n));
        if (packed == null) return null;
        const kind = packed & 3;
        const start = (packed >>> 2) & 2047;
        const length = (packed >>> 13) & 2047;
        return { type: kind === 2 ? 'existing' : kind === 1 ? 'new' : 'unsupported',
            conversationId: kind === 2 ? pathname.slice(start,start+length) : null };
    }
    function contains(text, marker) {
        if (!core) return null;
        if (!marker.length) return true;
        if (marker.length > 256) return null;
        // Overlapping chunks retain matches across boundaries without copying
        // entire conversation text into WASM or growing linear memory.
        const capacity = core.cpo_fingerprint_capacity() >>> 0;
        const size = capacity-marker.length;
        if (size < marker.length) return null;
        for (let start=0; start<text.length; start+=size-marker.length+1) {
            const chunk = text.slice(start,start+size);
            const match = withUnits(chunk+marker,(e) => e.cpo_marker_contains(chunk.length,marker.length));
            if (match == null) return null;
            if (match) return true;
        }
        return false;
    }
    // Serialize the existing plain-data snapshot, retaining the browser's
    // ECMAScript number formatting and property enumeration semantics.
    function serialize(value) {
        if (!core) return null;
        const e = core;
        let input, output;
        const parts = [];
        const ancestors = new Set();
        try {
            const capacity = e.cpo_fingerprint_capacity() >>> 0;
            input = new Uint16Array(e.memory.buffer,e.cpo_fingerprint_buffer() >>> 0,capacity);
            output = new Uint16Array(e.memory.buffer,e.cpo_json_output() >>> 0,capacity*6);
            const token = kind => {
                if (kind === 9) { parts.push('false'); return; }
                const packed = e.cpo_json_token(kind) >>> 0;
                if (kind >= 7) parts.push(String.fromCharCode(packed&255,(packed>>>8)&255,(packed>>>16)&255,packed>>>24));
                else parts.push(String.fromCharCode(packed));
            };
            const string = text => {
                token(6);
                for (let start=0;start<text.length;) {
                    let end = Math.min(start+capacity,text.length);
                    // Preserve surrogate pairs across the chunk boundary.
                    if (end < text.length && text.charCodeAt(end-1)>=0xd800 && text.charCodeAt(end-1)<=0xdbff &&
                        text.charCodeAt(end)>=0xdc00 && text.charCodeAt(end)<=0xdfff) end--;
                    const length = end-start;
                    for (let i=0;i<length;i++) input[i]=text.charCodeAt(start+i);
                    const written=e.cpo_json_escape(length)>>>0;
                    if (written < length || written > capacity*6) throw new Error('Invalid JSON codec output');
                    parts.push(String.fromCharCode(...output.subarray(0,written)));
                    input.fill(0,0,length);
                    e.cpo_json_wipe(written);
                    start=end;
                }
                token(6);
            };
            const visit = (item,depth) => {
                if (depth>64) throw new Error('Unsupported snapshot depth');
                if (item===null || item===undefined) { token(7); return; }
                if (typeof item==='string') { string(item); return; }
                if (typeof item==='boolean') { token(item?8:9); return; }
                if (typeof item==='number') { if (Number.isFinite(item)) parts.push(String(item)); else token(7); return; }
                if (typeof item!=='object' || typeof item.toJSON==='function' || ancestors.has(item)) throw new Error('Unsupported snapshot value');
                ancestors.add(item);
                if (Array.isArray(item)) {
                    token(2);
                    for(let i=0;i<item.length;i++){ if(i)token(4);visit(item[i],depth+1); }
                    token(3);
                } else {
                    const proto=Object.getPrototypeOf(item);
                    if(proto!==Object.prototype && proto!==null)throw new Error('Unsupported snapshot object');
                    token(0);
                    let first=true;
                    for(const key of Object.keys(item)){
                        const v=item[key];
                        if(v===undefined || typeof v==='function' || typeof v==='symbol')continue;
                        if(!first)token(4);
                        first=false;string(key);token(5);visit(v,depth+1);
                    }
                    token(1);
                }
                ancestors.delete(item);
            };
            if(value===undefined)return null;
            visit(value,0);
            return parts.join('');
        } catch { return null; }
        finally {
            if(input)input.fill(0);
            if(output)try{e.cpo_json_wipe(output.length);}catch{}
        }
    }
    // The field list and conversion rules come from Rust. JS only reads and
    // writes structured-clone values because browser storage accepts objects.
    function getDurableSchema() {
        if (durableSchema) return durableSchema;
        const e=core;
        const size=e.cpo_durable_field_count()>>>0;
        if(!size||size>128)throw new Error('Invalid durable schema');
        const fields=[];
        const seen=new Set();
        for(let i=0;i<size;i++){
            let name='';
            for(let offset=0;offset<64;offset+=4){
                const packed=e.cpo_durable_field_name(i,offset)>>>0;
                if(!packed)break;
                for(let byte=0;byte<4;byte++){
                    const ch=(packed>>>(byte*8))&255;
                    if(!ch)break;
                    name+=String.fromCharCode(ch);
                }
            }
            if(!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)||seen.has(name)||
                ['constructor','prototype'].includes(name))throw new Error('Invalid durable field');
            seen.add(name);
            fields.push({name,project:e.cpo_durable_field_rule(i,0)>>>0,restore:e.cpo_durable_field_rule(i,1)>>>0});
        }
        durableSchema=fields;
        return fields;
    }
    function durableTrim(text) {
        const size=core.cpo_fingerprint_capacity()>>>0;
        if(!size||size>1024)throw new Error('Invalid trim capacity');
        const edge=chunk=>{
            const packed=withUnits(chunk,(e,n)=>e.cpo_durable_trim(n));
            if(packed==null||packed===0xffffffff)throw new Error('Native trim failed');
            return [packed&2047,(packed>>>11)&2047];
        };
        let start=0,end=text.length;
        while(start<end){
            const chunk=text.slice(start,Math.min(start+size,end));
            const [left]=edge(chunk);
            start+=left;
            if(left<chunk.length)break;
        }
        while(end>start){
            const from=Math.max(start,end-size);
            const chunk=text.slice(from,end);
            const [left,right]=edge(chunk);
            if(left===chunk.length){end=from;continue;}
            end=from+right;
            break;
        }
        return start===0&&end===text.length?text:text.slice(start,end);
    }
    function durableObject(source, mode, now=Date.now(), createId=()=>crypto.randomUUID()) {
        if(!core)return null;
        if(!source||typeof source!=='object'||Array.isArray(source))return {ok:false,error:'Invalid durable job'};
        const e=core;
        const out={};
        const read=name=>Object.prototype.hasOwnProperty.call(source,name)?source[name]:undefined;
        const reject=field=>({ok:false,error:'Invalid durable field: '+field});
        const defaultText=(rule)=>{
            const flags=Number(!!out.conversationId)|(Number(read('targetKey')==='chatgpt:new')<<1)|
                (Number(read('waitForIdleBeforeSend')===true)<<2)|(Number(!!out.currentMessage)<<3);
            const code=e.cpo_durable_default(rule,mode,flags)>>>0;
            switch(code){
                case 1:return '';
                case 2:return null;
                case 3:return 'chatgpt';
                case 4:return 'existing';
                case 5:return 'new';
                case 6:return 'unknown';
                case 7:return out.conversationId?out.provider+':c:'+out.conversationId:out.provider+':'+out.conversationType;
                case 8:return createId();
                case 9:return 'queued';
                case 10:return 'waiting-for-idle';
                case 11:return 'waiting';
                default:throw new Error('Unknown durable default');
            }
        };
        try{
            for(const field of getDurableSchema()){
                const rule=mode===0?field.project:field.restore;
                const key=field.name;
                const v=read(key);
                if(rule===6){
                    if(v!=null&&!Array.isArray(v))return reject(key);
                    const queue=[];
                    for(const item of v||[]){
                        if(typeof item!=='string')return reject(key);
                        const text=mode===1?durableTrim(item):item;
                        if(mode===0||text)queue.push(text);
                    }
                    out[key]=queue;
                }else if(rule===7){
                    if(v!=null&&typeof v!=='string')return reject(key);
                    const text=mode===1?durableTrim(v||''):v||'';
                    out[key]=text||defaultText(rule);
                }else if([3,4,13,14].includes(rule)){
                    if(mode===1&&v!=null&&typeof v!=='boolean')return reject(key);
                    if(mode===1&&rule===14&&v===true)return reject(key);
                    const flags=Number(v===true)|(Number(v===false)<<1)|(Number(!!v)<<2)|(Number(read('isPaused')===true)<<3);
                    out[key]=e.cpo_durable_boolean(rule,mode,flags)===1;
                }else if([5,16,17,18].includes(rule)){
                    // Numeric strings in older checkpoints are accepted, but
                    // objects, fractional counters and unsafe timestamps are not.
                    if(v!=null&&typeof v!=='number'&&typeof v!=='string')return reject(key);
                    if(mode===0&&rule===16&&v===undefined){out[key]=undefined;continue;}
                    const n=Number(v||0);
                    const value=e.cpo_durable_number(rule,mode,n,now);
                    if(!Number.isFinite(value))return reject(key);
                    if(rule===17){
                        const completed=Number(read('completedCount')||0);
                        const done=e.cpo_durable_number(5,mode,completed,now);
                        if(!Number.isFinite(done)||!Number.isSafeInteger(done+out.queue.length+Number(!!out.currentMessage)))return reject(key);
                        const remaining=out.queue.length+Number(!!out.currentMessage);
                        out[key]=value<=0xffffffff&&done<=0xffffffff&&done+remaining<=0xffffffff?
                            e.cpo_queue_total(value,done,remaining)>>>0:Math.max(value,done+remaining);
                    }else out[key]=value;
                }else if(rule===15){
                    if(v!=null&&typeof v!=='string')return reject(key);
                    const code=v==='finite'?1:v==='unlimited'?2:v?3:0;
                    const selected=e.cpo_durable_retry_mode(mode,code);
                    out[key]=selected===1?'finite':selected===2?'unlimited':selected===3?v:'';
                }else{
                    if(v!=null&&typeof v!=='string')return reject(key);
                    out[key]=v||defaultText(rule);
                }
            }
            if(mode===1){
                if(e.cpo_restore_eligible(out.tabId,out.queue.length,Number(!!out.currentMessage),Number(out.isStopped))!==1)return {ok:false,error:'Durable job is inactive or empty'};
                if(out.currentMessage&&!out.currentCommandNumber){
                    if(out.completedCount>=Number.MAX_SAFE_INTEGER)return reject('currentCommandNumber');
                    out.currentCommandNumber=out.completedCount+1;
                }
            }
            return {ok:true,value:out};
        }catch(error){
            // An engine failure is distinct from a rejected checkpoint. The
            // existing compatibility path handles unavailable native execution.
            fail(error);
            return null;
        }
    }
    function projectDurable(job){return durableObject(job,0);}
    function deserializeDurable(raw,now,createId){return durableObject(raw,1,now,createId);}
    function settings(source,mode='optimizer') {
        if(!core)return null;
        const out={};
        const bool=(key,defaultValue)=> {
            if(Object.prototype.hasOwnProperty.call(source,key)){
                out[key]=core.cpo_setting_bool(Number(defaultValue),source[key]===true?2:source[key]===false?1:0)===1;
            }
        };
        try{
            if(mode==='queue'){
                bool('queueUnlimitedRetryWait',false);bool('queueDeepResearchAware',true);bool('queueDeliveryTimeoutRefresh',true);
            }else{
                for(const [i,key] of ['windowSize','batchSize','resourceBudget','inactiveTabMinutes'].entries()){
                    if(Object.prototype.hasOwnProperty.call(source,key))out[key]=core.cpo_setting_number(i,Number(source[key]))>>>0;
                }
                for(const key of ['enabled','autoScroll','offscreenRendering','adaptiveBudget','evictPausedMedia'])bool(key,key==='enabled'||key==='autoScroll');
            }
            return out;
        }catch(error){fail(error);return null;}
    }
    function scheduledActions(status) {
        return call('cpo_popup_schedule_actions',[Math.max(0,['','pending','firing','completed','failed','cancelled'].indexOf(status))]);
    }
    function remaining(jobs) {
        if(!core)return null;
        try{
            let total=0;
            for(const job of Object.values(jobs||{}))total=core.cpo_popup_remaining(total,Number(job?.remaining||0));
            return total;
        }catch(error){fail(error);return null;}
    }
    function sensitiveKey(normalized) {
        return withUnits(normalized,(e,n)=>e.cpo_log_sensitive(n));
    }
    function tabDiscard(tab, stage, mode, minutes, now, provider, work=false, unchanged=false, safe=false) {
        const flags=Number(!!tab && Number.isInteger(tab.id)) |
            (Number(tab?.active===false)<<1) | (Number(tab?.status==='complete')<<2) |
            (Number(provider==='chatgpt')<<3) |
            (Number(!!(tab?.highlighted===true || tab?.discarded===true || tab?.pinned===true ||
                tab?.audible===true || tab?.incognito===true || tab?.autoDiscardable===false))<<4) |
            (Number(!!work)<<5) | (Number(!!unchanged)<<6) | (Number(!!safe)<<7);
        const elapsed=Number.isFinite(tab?.lastAccessed)&&tab.lastAccessed>0 ? now-tab.lastAccessed : -1;
        return numeric('cpo_tab_discard',[stage,mode,flags,minutes,elapsed]);
    }
    function fingerprint(text) {
        if (!core) return null;
        const value = String(text || '');
        let input;
        const engine = core;
        try {
            const capacity = engine.cpo_fingerprint_capacity() >>> 0;
            if (!capacity || capacity > 4096) throw new Error('Invalid fingerprint capacity');
            input = new Uint16Array(engine.memory.buffer, engine.cpo_fingerprint_buffer() >>> 0, capacity);
            engine.cpo_fingerprint_reset();
            for (let start = 0; start < value.length; start += capacity) {
                const length = Math.min(capacity, value.length - start);
                for (let i = 0; i < length; i++) input[i] = value.charCodeAt(start + i);
                if (engine.cpo_fingerprint_update(length) !== 1) throw new Error('Fingerprint update failed');
            }
            const hash = engine.cpo_fingerprint_hash() >>> 0;
            const length = engine.cpo_fingerprint_len() >>> 0;
            return 'fnv1a:' + hash.toString(16) + ':len:' + length;
        } catch (error) { fail(error); return null; }
        finally {
            if (input) input.fill(0);
            try { engine.cpo_fingerprint_reset(); } catch {}
        }
    }
    function confirmed(job) {
        return call('cpo_queue_confirmed', [Number(!!job?.submittedUserTurnId), Math.max(0, delivery.indexOf(String(job?.deliveryState || '')))]);
    }
    function next(job, confirmedSubmission) {
        const phase = ['waiting','awaiting-response','active-response'].includes(job.currentPhase) ? 2 :
            Math.max(0, phases.indexOf(job.currentPhase));
        const flags = Number(!!job.isRunning) | (Number(!!job.isPaused) << 1) |
            (Number(!!job.isStopped) << 2) | (Number(!!job.currentMessage) << 3) |
            (Number(!!confirmedSubmission) << 4) | (Number(!!job.rolloverInProgress) << 5) |
            (Number(!!job.waitForIdleBeforeSend) << 6);
        return call('cpo_queue_next', [flags, phase, job.queue.length]);
    }
    const api = { load, fingerprint, confirmed, next, call, numeric, schedule, scheduleIdentity, restoreAction, providerHost, providerRoute, contains, serialize, projectDurable, deserializeDurable, settings, remaining, scheduledActions, sensitiveKey, tabDiscard, install, get status() { return status; } };
    globalThis.CpoQueueEngine = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
