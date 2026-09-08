const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

function isChatGPTUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }

    try {
        const parsed = new URL(url);

        return parsed.protocol === 'https:' && CHATGPT_HOSTS.has(parsed.hostname.toLowerCase());
    } catch {
        return false;
    }
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
