function getUrlProvider(url) {
    if(typeof url!=='string')return null;
    try{
        const parsed=new URL(url);
        if(parsed.protocol!=='https:')return null;
        const code=globalThis.CpoQueueEngine?.providerHost(parsed.hostname.toLowerCase());
        return ['','chatgpt','gemini','claude'][code]||null;
    }catch{return null;}
}

function isSupportedProviderUrl(url) {
    return getUrlProvider(url) !== null;
}

function isChatGPTUrl(url) {
    return getUrlProvider(url) === 'chatgpt';
}

// Browser-owned Promise/callback objects. Native code decides whether an
// outstanding call may settle; local state survives a missing/trapped module.
function completionGate() {
    let state=0;
    return event=>{
        const next=globalThis.CpoQueueEngine?.call('cpo_async_transition',[state,event]);
        const accepted=next==null?(state===0?event:0):next;
        if(state!==0||accepted!==event)return false;
        state=event;return true;
    };
}

function extensionApiPromise(callWithCallback, callWithoutCallback) {
    return new Promise((resolve,reject)=>{
        const settle=completionGate();
        const success=value=>{if(settle(1))resolve(value);};
        const failure=error=>{if(settle(2))reject(error instanceof Error?error:new Error(String(error||'Extension API call failed.')));};
        const callback=value=>{
            const error=globalThis.chrome?.runtime?.lastError;
            if(error)failure(error.message||'Extension API call failed.');
            else success(value);
        };
        try{
            // Choose the API form before invocation, never retry an uncertain effect.
            const result=typeof globalThis.browser!=='undefined'&&callWithoutCallback
                ?callWithoutCallback():callWithCallback(callback);
            if(result&&typeof result.then==='function')result.then(success,failure);
        }catch(error){failure(error);}
    });
}

const CpoBrowserApi = (() => {
    const emergency=Object.freeze(Object.assign(Object.create(null),{
        localGet:['storage','local','get'],localSet:['storage','local','set'],
        syncGet:['storage','sync','get'],syncSet:['storage','sync','set'],
        tabGet:['tabs','get'],tabQuery:['tabs','query']
    }));
    const find=(root,path)=>{
        const parent=path.slice(0,-1).reduce((value,key)=>value?.[key],root);
        return [parent,parent?.[path[path.length-1]]];
    };
    function endpoints(path){
        return [find(globalThis.browser,path),find(globalThis.chrome,path)];
    }
    function capabilities(pair){
        return Number(typeof pair[0][1]==='function')|(Number(typeof pair[1][1]==='function')<<1);
    }
    function invokePath(engine,code,path,args){
        const pair=endpoints(path);
        const flags=capabilities(pair);
        const mode=engine?.call('cpo_api_mode',[code,args.length,flags])??
            (code===0&&args.length===1?(flags&1?1:flags&2?2:0):0);
        if(mode===1){
            const [parent,method]=pair[0];
            return Promise.resolve(method.apply(parent,args));
        }
        if(mode===2){
            const [parent,method]=pair[1];
            return extensionApiPromise(done=>method.apply(parent,[...args,done]));
        }
        throw new Error('Browser API not authorized or unavailable.');
    }
    async function invoke(operation,...args){
        const engine=globalThis.CpoQueueEngine;
        if(await engine?.load()){
            const code=engine.eventCode(2,operation);
            const path=engine.apiPath(code);
            if(code&&path)return invokePath(engine,code,path,args);
            if(code!=null)throw new Error('Unknown browser API operation: '+operation);
        }
        if(Object.hasOwn(emergency,operation))return invokePath(null,0,emergency[operation],args);
        throw new Error('Required native browser API router unavailable: '+operation);
    }
    async function inject(details,css=false){
        const engine=globalThis.CpoQueueEngine;
        if(!await engine?.load())throw new Error('Required native injection router unavailable.');
        const modern=css?14:13,legacy=css?16:15;
        const modernPath=engine.apiPath(modern),legacyPath=engine.apiPath(legacy);
        if(!modernPath||!legacyPath)throw new Error('Native injection paths unavailable.');
        const tabId=details?.target?.tabId;
        const single=Array.isArray(details?.files)&&details.files.length===1&&typeof details.files[0]==='string';
        const func=typeof details?.func==='function';
        const flags=Number(!!capabilities(endpoints(modernPath)))|
            (Number(!!capabilities(endpoints(legacyPath)))<<1)|(Number(single)<<2)|
            (Number(func)<<3)|(Number(Number.isInteger(tabId)&&tabId>=0)<<4);
        const code=engine.call('cpo_injection_route',[Number(css),flags]);
        if(code===modern)return invokePath(engine,code,modernPath,[details]);
        if(code===legacy){
            const converted=single?{file:details.files[0]}:{code:`(${details.func}).apply(null, ${JSON.stringify(details.args||[])});`};
            return invokePath(engine,code,legacyPath,[tabId,converted]);
        }
        throw new Error('No authorized script or CSS injection route.');
    }
    function listen(handler){
        // Register synchronously: MV3 service workers must not await WASM
        // startup before registering browser listeners.
        chrome.runtime.onMessage.addListener((message,sender,reply)=>{
            const settle=completionGate();
            const respond=value=>{if(settle(1))reply(value);};
            const reject=error=>{if(settle(2))reply({ok:false,error:String(error?.message||error)});};
            try{
                const result=handler(message,sender,respond);
                if(result&&typeof result.then==='function')result.catch(reject);
            }catch(error){reject(error);}
            return true;
        });
    }
    return Object.freeze({invoke,inject,listen});
})();

function isGeminiUrl(url) {
    return getUrlProvider(url) === 'gemini';
}

function isClaudeUrl(url) {
    return getUrlProvider(url) === 'claude';
}

if (typeof globalThis !== 'undefined') {
    globalThis.extensionApiPromise = extensionApiPromise;
    globalThis.CpoBrowserApi = CpoBrowserApi;
    globalThis.CHATGPT_HOSTS = CHATGPT_HOSTS;
    globalThis.GEMINI_HOSTS = GEMINI_HOSTS;
    globalThis.CLAUDE_HOSTS = CLAUDE_HOSTS;
    globalThis.PROVIDER_HOSTS = PROVIDER_HOSTS;
    globalThis.getUrlProvider = getUrlProvider;
    globalThis.isSupportedProviderUrl = isSupportedProviderUrl;
    globalThis.isChatGPTUrl = isChatGPTUrl;
    globalThis.isGeminiUrl = isGeminiUrl;
    globalThis.isClaudeUrl = isClaudeUrl;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CHATGPT_HOSTS,
        GEMINI_HOSTS,
        CLAUDE_HOSTS,
        PROVIDER_HOSTS,
        getUrlProvider,
        isSupportedProviderUrl,
        isChatGPTUrl,
        isGeminiUrl,
        isClaudeUrl,
        extensionApiPromise,
        CpoBrowserApi
    };
}
