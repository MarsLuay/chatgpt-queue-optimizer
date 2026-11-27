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
    invoke(operation, ...args) {
        const operations = {
            localGet:['storage','local','get'], localSet:['storage','local','set'],
            syncGet:['storage','sync','get'], syncSet:['storage','sync','set'],
            tabGet:['tabs','get'], tabQuery:['tabs','query'], tabUpdate:['tabs','update'],
            tabCreate:['tabs','create'], tabSend:['tabs','sendMessage'],
            runtimeSend:['runtime','sendMessage']
        };
        const path=operations[operation];
        if(!path)return Promise.reject(new Error('Unknown browser API operation'));
        const parent=path.slice(0,-1).reduce((value,key)=>value?.[key],globalThis.chrome);
        const method=parent?.[path[path.length-1]];
        if(typeof method!=='function')return Promise.reject(new Error('Browser API unavailable: '+operation));
        // Firefox's Promise-only API is selected before invocation. Never
        // repeat a potentially mutating request after an uncertain failure.
        const browserParent=path.slice(0,-1).reduce((value,key)=>value?.[key],globalThis.browser);
        const browserMethod=browserParent?.[path[path.length-1]];
        if(typeof browserMethod==='function'){
            try{return Promise.resolve(browserMethod.apply(browserParent,args));}
            catch(error){return Promise.reject(error);}
        }
        return extensionApiPromise(done=>method.apply(parent,[...args,done]));
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
