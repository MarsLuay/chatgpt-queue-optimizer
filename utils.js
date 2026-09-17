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

function isGeminiUrl(url) {
    return getUrlProvider(url) === 'gemini';
}

function isClaudeUrl(url) {
    return getUrlProvider(url) === 'claude';
}

if (typeof globalThis !== 'undefined') {
    globalThis.extensionApiPromise = extensionApiPromise;
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
        extensionApiPromise
    };
}
