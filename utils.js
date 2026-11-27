const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const GEMINI_HOSTS = new Set(['gemini.google.com']);
const CLAUDE_HOSTS = new Set(['claude.ai']);

const PROVIDER_HOSTS = {
    chatgpt: CHATGPT_HOSTS,
    gemini: GEMINI_HOSTS,
    claude: CLAUDE_HOSTS
};

function getUrlProvider(url) {
    if (typeof url !== 'string') {
        return null;
    }

    try {
        const parsed = new URL(url);

        if (parsed.protocol !== 'https:') {
            return null;
        }

        const hostname = parsed.hostname.toLowerCase();

        for (const [providerId, hosts] of Object.entries(PROVIDER_HOSTS)) {
            if (hosts.has(hostname)) {
                return providerId;
            }
        }

        return null;
    } catch {
        return null;
    }
}

function isSupportedProviderUrl(url) {
    return getUrlProvider(url) !== null;
}

function isChatGPTUrl(url) {
    return getUrlProvider(url) === 'chatgpt';
}

function extensionApiPromise(callWithCallback, callWithoutCallback) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const settleResolve = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const settleReject = (error) => {
            if (settled) return;
            settled = true;
            reject(error instanceof Error ? error : new Error(String(error || 'Extension API call failed.')));
        };

        const finishFromCallback = (value) => {
            if (settled) return;

            const lastError = chrome.runtime.lastError;

            if (lastError) {
                settleReject(new Error(lastError.message || 'Extension API call failed.'));
                return;
            }

            settleResolve(value);
        };

        let maybePromise;

        try {
            maybePromise = callWithCallback(finishFromCallback);
        } catch (callbackError) {
            if (!callWithoutCallback) {
                settleReject(callbackError);
                return;
            }

            try {
                maybePromise = callWithoutCallback();
            } catch (promiseError) {
                settleReject(promiseError);
                return;
            }
        }

        if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(settleResolve, settleReject);
        }
    });
}

// Shared host ABI for browser API effects. Keep method access on the
// browser side; WASM owns decisions and never receives privileged API objects.
const CpoBrowserApi = Object.freeze({
    // Exactly one reply, including rejected asynchronous handlers.
    listen(handler) {
        chrome.runtime.onMessage.addListener((message,sender,reply)=>{
            let settled=false;
            const respond=value=>{if(!settled){settled=true;reply(value);}};
            try{
                const result=handler(message,sender,respond);
                if(result&&typeof result.then==='function')result.catch(error=>respond({ok:false,error:String(error?.message||error)}));
            }catch(error){respond({ok:false,error:String(error?.message||error)});}
            return true;
        });
    },
    async invoke(operation, ...args) {
        // The platform bindings contain paths, not routing or retry policy.
        const paths = [null,['storage','local','get'],['storage','local','set'],
            ['storage','sync','get'],['storage','sync','set'],['tabs','get'],
            ['tabs','query'],['tabs','update'],['tabs','create'],['tabs','sendMessage'],
            ['runtime','sendMessage'],['tabs','discard'],['tabs','reload']];
        const engine=globalThis.CpoQueueEngine;
        const ready=await engine?.load();
        let code=ready?engine.eventCode(2,operation):null;
        // Storage reads/writes and read-only tab inspection must survive a
        // missing engine so that a failed upgrade cannot destroy saved jobs.
        // No tab navigation, submission, reload or discard is authorized here.
        if(code==null)code=({localGet:1,localSet:2,syncGet:3,syncSet:4,tabGet:5,tabQuery:6})[operation]||0;
        const path=paths[code];
        if(!path)throw new Error('Browser operation unavailable: '+operation);
        const find=root=>{
            const parent=path.slice(0,-1).reduce((value,key)=>value?.[key],root);
            return [parent,parent?.[path[path.length-1]]];
        };
        const [promiseParent,promiseMethod]=find(globalThis.browser);
        const [callbackParent,callbackMethod]=find(globalThis.chrome);
        const flags=Number(typeof promiseMethod==='function')|(Number(typeof callbackMethod==='function')<<1);
        const mode=ready?engine.call('cpo_api_mode',[code,args.length,flags]):args.length===1?(flags&1?1:flags&2?2:0):0;
        if(mode===1)return promiseMethod.apply(promiseParent,args);
        if(mode===2)return extensionApiPromise(done=>callbackMethod.apply(callbackParent,[...args,done]));
        throw new Error('Browser API not authorized or unavailable: '+operation);
    }

});

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
