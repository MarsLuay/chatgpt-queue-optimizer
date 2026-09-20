const globals = require('globals');

const sharedExtensionGlobals = {
    chrome: 'readonly',
    browser: 'readonly',
    extensionApiPromise: 'readonly',
    getProvider: 'readonly',
    getProviderForUrl: 'readonly',
    getConversationIdentity: 'readonly',
    isChatGPTUrl: 'readonly',
    isGeminiUrl: 'readonly',
    isClaudeUrl: 'readonly',
    isSupportedProviderUrl: 'readonly',
    getUrlProvider: 'readonly',
    ProviderAdapter: 'readonly',
    ProviderAdapterRegistry: 'readonly',
    ProviderAdapters: 'readonly',
    ChatGPTAdapter: 'readonly',
    GeminiAdapter: 'readonly',
    ClaudeAdapter: 'readonly',
    CHATGPT_HOSTS: 'readonly',
    GEMINI_HOSTS: 'readonly',
    CLAUDE_HOSTS: 'readonly',
    PROVIDER_HOSTS: 'readonly',
    CHATGPT_SELECTORS: 'readonly',
    GEMINI_SELECTORS: 'readonly',
    CLAUDE_SELECTORS: 'readonly',
    globalThis: 'readonly'
};

const extensionGlobals = {
    ...globals.browser,
    ...globals.webextensions,
    ...sharedExtensionGlobals,
    module: 'readonly',
    process: 'readonly',
    require: 'readonly'
};

const utilsGlobals = {
    ...globals.browser,
    ...globals.webextensions,
    chrome: 'readonly',
    browser: 'readonly',
    module: 'readonly',
    require: 'readonly'
};

const backgroundGlobals = {
    ...globals.serviceworker,
    ...globals.webextensions,
    ...sharedExtensionGlobals,
    document: 'readonly',
    importScripts: 'readonly',
    InputEvent: 'readonly',
    module: 'readonly',
    require: 'readonly',
    window: 'readonly'
};

const testGlobals = {
    ...globals.node,
    ...globals.browser,
    ...globals.webextensions,
    chrome: 'readonly',
    browser: 'readonly',
    globalThis: 'readonly'
};

const correctnessRules = {
    'constructor-super': 'error',
    'for-direction': 'error',
    'getter-return': 'error',
    'no-async-promise-executor': 'error',
    'no-case-declarations': 'error',
    'no-class-assign': 'error',
    'no-const-assign': 'error',
    'no-constant-binary-expression': 'error',
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-control-regex': 'error',
    'no-debugger': 'error',
    'no-dupe-args': 'error',
    'no-dupe-class-members': 'error',
    'no-dupe-else-if': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-fallthrough': 'error',
    'no-func-assign': 'error',
    'no-import-assign': 'error',
    'no-loss-of-precision': 'error',
    'no-new-native-nonconstructor': 'error',
    'no-obj-calls': 'error',
    'no-promise-executor-return': 'error',
    'no-redeclare': 'error',
    'no-self-assign': 'error',
    'no-self-compare': 'error',
    'no-setter-return': 'error',
    'no-shadow-restricted-names': 'error',
    'no-sparse-arrays': 'error',
    'no-this-before-super': 'error',
    'no-undef': 'error',
    'no-unexpected-multiline': 'error',
    'no-unreachable': 'error',
    'no-unsafe-finally': 'error',
    'no-unsafe-negation': 'error',
    'no-with': 'error'
};

module.exports = [
    {
        ignores: [
            'build/**',
            'node_modules/**',
            'chatgpt-queue-optimizer.crx',
            'chatgpt-queue-optimizer.pem'
        ]
    },
    {
        files: ['background.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'script',
            globals: backgroundGlobals
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error'
        },
        rules: correctnessRules
    },
    {
        files: ['content.js', 'popup.js', 'provider-adapter.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'script',
            globals: extensionGlobals
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error'
        },
        rules: correctnessRules
    },
    {
        files: ['utils.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'script',
            globals: utilsGlobals
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error'
        },
        rules: correctnessRules
    },
    {
        files: [
            '*.test.js',
            'test/**/*.js',
            'tests/**/*.js',
            'eslint.config.js'
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: testGlobals
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error'
        },
        rules: correctnessRules
    }
];
