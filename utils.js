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
