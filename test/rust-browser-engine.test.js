const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ChatGPTOptimizer } = require('../content.js');
const { CpoRustBrowserBridge } = require('../rust-browser-bridge.js');

const wasmPath = path.join(__dirname, '..', 'optimizer_browser.wasm');
const skip = !fs.existsSync(wasmPath) && 'Build WASM first using cargo run --release --manifest-path Installers/native/Cargo.toml -- build';

function owner() {
    const value = Object.create(ChatGPTOptimizer.prototype);
    value.nativeCore = null;
    value.config = {};
    value.mediaOriginals = new WeakMap();
    value.mediaStats = { imagesEvicted: 0, playbackEvicted: 0, restored: 0, estimatedImageBytes: 0 };
    return value;
}

async function engine(optimizer = owner()) {
    const bridge = new CpoRustBrowserBridge(optimizer);
    const result = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {
        cpo: { host: (op, a, b, c) => bridge.host(op >>> 0, a >>> 0, b >>> 0, c >>> 0) >>> 0 }
    });
    bridge.exports = result.instance.exports;
    assert.equal(bridge.exports.cpo_browser_abi(), 11);
    return bridge;
}

function treeWalker(nodes) {
    let i = 0;
    return { nextNode: () => nodes[i++] || null };
}

test('Rust traverses DOM resource samples within fixed limits and releases call-local references', { skip }, async () => {
    const bridge = await engine();
    const original = global.document;
    const text = { nodeType: 3, length: 129 };
    Object.defineProperty(text, 'textContent', { get() { throw new Error('No full text copy'); } });
    const root = { nodeType: 1, localName: 'article' };
    try {
        global.document = { createTreeWalker: () => treeWalker([text, {nodeType:1,localName:'img'},
            {nodeType:1,localName:'video'}, {nodeType:1,localName:'canvas'}]) };
        const sample = bridge.sample([root]);
        assert.equal(sample.sampledTurns, 1);
        assert.equal(sample.nodes, 5);
        assert.equal(sample.units, 295);
        assert.equal(sample.textChars, 129);
        assert.equal(bridge.context, null);
        global.document = { createTreeWalker: () => ({nextNode: () => root}) };
        const capped = bridge.sample(Array(100).fill(root));
        assert.equal(capped.sampledTurns, 32);
        assert.equal(capped.nodes, 16384);
        assert.equal(capped.truncatedTurns, 32);
        assert.equal(bridge.context, null);
    } finally {
        if (original === undefined) delete global.document;
        else global.document = original;
    }
});

function turn(order, tag, parent = null, text = 'hello') {
    return {
        order, tagName: tag, parentElement: parent, classList: {contains: () => false},
        closest: () => null, matches: selector => selector === '[marker]',
        querySelector: () => null, getAttribute: () => null,
        compareDocumentPosition(other) { return this.order < other.order ? 4 : this.order > other.order ? 2 : 0; },
        text
    };
}

test('Rust discovery deduplicates wrappers and sorts canonical turns', { skip }, async () => {
    const bridge = await engine();
    const wrapper = turn(0, 'DIV');
    const early = turn(1, 'ARTICLE', wrapper);
    const late = turn(2, 'ARTICLE');
    const empty = turn(3, 'ARTICLE', null, '   ');
    const doc = {
        querySelectorAll: () => [late, wrapper, early, early, empty],
        createTreeWalker: node => treeWalker([{length: node.text.length,
            substringData: (start, length) => node.text.slice(start, start + length)}])
    };
    const adapter = { selectors: { messages: ['[marker]'], composer: ['textarea'], fallbackMessages: ['article'] },
        compatibilitySignals: { turnContext: [], messageContext: ['[marker]'] },
        allowsFallbackMessageDiscovery: () => false, findMatchingSelector: () => '[marker]' };
    const result = bridge.discover(adapter, doc, { contains: () => true });
    assert.deepEqual(result.nodes, [early, late]);
    assert.equal(result.selector, '[marker]');
    assert.equal(result.fallback, false);
    assert.equal(bridge.context, null);
});

function element(attributes, extra = {}) {
    const values = new Map(Object.entries(attributes));
    return { getAttribute: name => values.get(name) ?? null,
        hasAttribute: name => values.has(name), setAttribute: (name, value) => values.set(name, value),
        removeAttribute: name => values.delete(name), querySelectorAll: () => [], ...extra };
}

test('Rust media execution releases and restores sources without retaining DOM handles', { skip }, async () => {
    const optimizer = owner();
    const bridge = await engine(optimizer);
    const src = element({srcset:'small.png 1x, large.png 2x'});
    const img = element({src:'small.png',srcset:'large.png 2x'}, {
        naturalWidth:100,naturalHeight:50,closest: () => ({querySelectorAll: () => [src]})
    });
    const root = {querySelectorAll: () => [img], contains: () => true};
    assert.equal(bridge.media(root, 0), 1);
    assert.equal(img.hasAttribute('src'), false);
    assert.equal(src.hasAttribute('srcset'), false);
    assert.equal(optimizer.mediaStats.estimatedImageBytes, 20000);
    assert.equal(bridge.media(root, 1), 1);
    assert.equal(img.getAttribute('src'), 'small.png');
    assert.equal(src.getAttribute('srcset'), 'small.png 1x, large.png 2x');
    let loads = 0;
    const paused = element({src:'video.mp4'}, {paused:true,currentTime:0,load: () => { loads++; }});
    const active = element({src:'active.mp4'}, {paused:false,currentTime:0});
    const playback = {querySelectorAll: () => [paused,active]};
    assert.equal(bridge.media(playback, 2), 1);
    assert.equal(paused.hasAttribute('src'), false);
    assert.equal(active.getAttribute('src'), 'active.mp4');
    assert.equal(bridge.media(playback, 3), 1);
    assert.equal(paused.getAttribute('src'), 'video.mp4');
    assert.equal(loads, 2);
    assert.equal(bridge.context, null);
});

test('browser bridge clears temporary references on a host failure', () => {
    const bridge = new CpoRustBrowserBridge(owner());
    bridge.exports = { cpo_execute_media: () => { throw new Error('host trap'); } };
    assert.equal(bridge.media({}, 0), null);
    assert.equal(bridge.context, null);
    assert.equal(bridge.status, 'unavailable');
});

test('Rust window execution hides, reveals, restores and protects recent turns', { skip }, async () => {
    const bridge = await engine();
    const turns = Array.from({ length: 12 }, () => {
        const classes = new Set();
        const image = element({ src: 'image.png' }, { naturalWidth: 10, naturalHeight: 10 });
        return { image, classList: { contains: key => classes.has(key),
            add: key => classes.add(key), remove: key => classes.delete(key) },
            querySelectorAll: selector => selector === 'img' ? [image] : [] };
    });
    assert.equal(bridge.applyWindow(turns, 10, true, false), true);
    assert.equal(turns[0].classList.contains('cpo-hidden'), true);
    assert.equal(turns[0].image.hasAttribute('src'), false);
    assert.equal(turns[2].classList.contains('cpo-offscreen'), true);
    assert.equal(turns[4].classList.contains('cpo-offscreen'), false);
    assert.equal(bridge.applyWindow(turns, 12, false, false), true);
    assert.equal(turns[0].image.getAttribute('src'), 'image.png');
    assert.equal(turns[0].classList.contains('cpo-hidden'), false);
    assert.equal(bridge.context, null);
});

test('Rust capture bounds text and excludes controls', { skip }, async () => {
    const bridge = await engine();
    const original = global.document;
    const node = { isConnected: true, matches: () => true, getAttribute: () => 'assistant' };
    const control = { length: 10, parentElement: { closest: () => ({}) },
        substringData() { throw new Error('must skip controls'); } };
    const long = { length: 40000, substringData: (_start, count) => 'x'.repeat(count) };
    try {
        global.document = { createTreeWalker: () => treeWalker([control, long]) };
        const result = bridge.captureHistory(Array(20).fill(node), 0);
        assert.equal(result.ok, true);
        assert.equal(result.next, 16);
        assert.equal(result.records.length, 16);
        assert.equal(result.records[0].role, 'assistant');
        assert.equal(result.records[0].text.length, 32768);
        assert.equal(result.records[0].truncated, true);
        assert.equal(bridge.captureHistory([{ isConnected: false }], 0).ok, false);
        assert.equal(bridge.context, null);
    } finally {
        if (original === undefined) delete global.document;
        else global.document = original;
    }
});

test('Rust cache validity checks expiry before touching nodes', { skip }, async () => {
    const bridge = await engine();
    const connected = { isConnected: true };
    const disconnected = { isConnected: false };
    const expired = { get isConnected() { throw new Error('expired cache must not be traversed'); } };
    assert.equal(bridge.cacheTtl(0), 800);
    assert.equal(bridge.cacheTtl(1), 8000);
    assert.equal(bridge.cacheNodesValid(0, 1000, [connected], 1799), true);
    assert.equal(bridge.cacheNodesValid(0, 1000, [expired], 1800), false);
    assert.equal(bridge.cacheNodesValid(1, 1000, [connected, disconnected], 1001), false);
    assert.equal(bridge.cacheNodesValid(1, 1000, [connected], 999), false);
    assert.equal(bridge.mutationDelay(), 700);
});

test('Rust mutation engine skips streaming and banner changes, invalidates provider ancestors', { skip }, async () => {
    const bridge = await engine();
    const parent = { parentElement: null };
    const target = { nodeType: 1, parentElement: parent, closest: () => target };
    const stream = { target, addedNodes: [{nodeType: 3}], removedNodes: [] };
    const banner = { target: parent, addedNodes: [{nodeType: 1, classList: {contains: () => true}}], removedNodes: [] };
    const turn = { target: parent, addedNodes: [{nodeType: 1, matches: () => true}], removedNodes: [] };
    const attr = { target, type: 'attributes', attributeName: 'data-message-id' };
    assert.equal(bridge.mutations([stream, banner], 0), false);
    assert.equal(bridge.mutations([stream, turn], 0), true);
    assert.equal(bridge.mutations([attr], 0), true);
    assert.equal(bridge.mutations([stream], 0, true), true);
    const cache = new WeakMap([[parent, 1], [target, 2]]);
    assert.equal(bridge.mutations([stream], 1, false, {_turnScanCache: cache}), false);
    assert.equal(cache.has(parent), false);
    assert.equal(cache.has(target), false);
    assert.equal(bridge.context, null);
});

test('Rust provider selector traversal preserves priority, deduplicates and supports early exit', {skip}, async () => {
    const bridge = await engine();
    const a = {}, b = {}, c = {};
    let queries = 0;
    const root = {
        querySelectorAll(selector) {
            queries++;
            if (selector === '.first') return [a,b];
            if (selector === '.second') return [a,c];
            throw new Error('bad selector');
        }
    };
    const selectors = ['.first','.second','.bad'];
    const matches = bridge.providerSelectors(root,selectors,'composer',(node,selector) => node !== b || selector === '.second');
    assert.deepEqual(matches,[{element:a,selector:'.first',signalKey:'composer'},{element:c,selector:'.second',signalKey:'composer'}]);
    assert.equal(queries,3);
    queries=0;
    assert.deepEqual(bridge.providerSelectors(root,selectors,'composer',null,true),[{element:a,selector:'.first',signalKey:'composer'}]);
    assert.equal(queries,1);
    assert.equal(bridge.context,null);
});

test('native composer operations and submission stages preserve draft and route guards', {skip}, async () => {
    const bridge=await engine();
    const actions=[];
    const input={tagName:'TEXTAREA',value:'draft',focus(){actions.push('focus');}};
    assert.equal(bridge.composerRead(1,input),'draft');
    assert.equal(bridge.composerWrite(1,input,'',0),true);
    assert.equal(input.value,'');
    assert.equal(bridge.composerWrite(1,input,'queued',1),true);
    assert.equal(input.value,'queued');
    assert.deepEqual(actions,['focus','focus']);
    assert.equal(bridge.submitStage(0,1|2|32|64),1);
    assert.equal(bridge.submitStage(1,1|4|8|16|32|64),6);
    assert.equal(bridge.submitStage(1,1|4|8|16|64),7);
    assert.equal(bridge.submitStage(2,4|64),3);
    let clicks=0;
    const button={isConnected:true,disabled:false,click(){clicks++;}};
    assert.equal(bridge.click(button),true);
    assert.equal(bridge.click({...button,disabled:true}),false);
    assert.equal(clicks,1);
    const latest={},old={},child={parentElement:old};
    assert.equal(bridge.activeSurface(child,new Set([old,latest]),latest),false);
    assert.equal(bridge.activeSurface({parentElement:latest},new Set([old,latest]),latest),true);
    assert.equal(bridge.context,null);
});

test('native UI builds detached history and prompt trees with safe text and native edit actions', {skip}, async()=>{
    const bridge=await engine();
    function element(tag){
        return {tag,children:[],style:{},className:'',textContent:'',
            classList:{add(){}},
            appendChild(child){this.children.push(child);return child;},
            replaceChildren(child){this.children=child.children.slice();},
            addEventListener(name,fn){this[name]=fn;}};
    }
    const doc={createElement:element,createDocumentFragment:()=>element('fragment')};
    const root=element('root');root.ownerDocument=doc;
    assert.equal(bridge.renderUI(6,root,[{fields:['1. assistant','<img src=x onerror=bad()>'],flags:1}]),true);
    assert.equal(root.children[0].tag,'article');
    assert.equal(root.children[0].children[1].textContent,'<img src=x onerror=bad()>');
    assert.equal(root.children[0].children[2].className,'notice');
    const actions=[];
    assert.equal(bridge.renderUI(0,root,[{fields:['1: prompt']},{fields:['','Show more']}],1,(a,i)=>actions.push([a,i])),true);
    assert.equal(root.children.length,2);
    root.children[0].children[1].children[0].click();
    root.children[1].click();
    assert.deepEqual(actions,[[1,0],[3,1]]);
    const messages=['first'];
    assert.equal(bridge.sequenceEdit(messages,1,0,'edited'),true);
    assert.equal(bridge.sequenceEdit(messages,0,0,'next'),true);
    assert.equal(bridge.sequenceEdit(messages,2,1),true);
    assert.deepEqual(messages,['edited']);
    assert.equal(bridge.sequenceEdit(messages,1,2,'invalid'),false);
    const saved={};
    assert.equal(bridge.savedSequence(0,saved,'test',messages).ok,true);
    assert.deepEqual(bridge.savedSequence(1,saved,'test',[]).messages,['edited']);
    assert.equal(bridge.savedSequence(0,saved,'__proto__',messages).ok,false);
    assert.equal(bridge.savedSequence(2,saved,'test',[]).ok,true);
    assert.deepEqual(saved,{});
    assert.deepEqual(bridge.variables('a {{name}} b {{other}}'),[[4,8],[15,20]]);
    assert.equal(bridge.context,null);
});

test('native sequence import and substitution preserve supported formats', {skip:skip||!fs.existsSync(path.join(__dirname,'..','optimizer_queue.wasm'))},async()=>{
    const queue=require('../rust-queue-bridge.js');
    const result=await WebAssembly.instantiate(fs.readFileSync(path.join(__dirname,'..','optimizer_queue.wasm')),{});
    queue.install(result.instance.exports);
    const bridge=await engine();
    const imported=bridge.importSequence('  ```json\n{"name":"  sequence  ","messages":[" one ","two \\uD83D\\uDE00","\\t","a\\n b"]}\n```  ');
    assert.deepEqual(imported,{name:'sequence',messages:['one','two 😀','a\n b']});
    assert.deepEqual(bridge.importSequence('["one","two"]'),{name:'',messages:['one','two']});
    assert.deepEqual(bridge.importSequence('[{"message":" a "},{"text":" b "},{"prompt":"c"}]'),{name:'',messages:['a','b','c']});
    assert.deepEqual(bridge.importSequence('1. first\n- second\n• third'),{name:'',messages:['first','second','third']});
    assert.equal(bridge.importSequence('   '),null);
    assert.equal(bridge.substitute('a {{x}} {{x}} {{y}}','x','$&{{y}}'),'a $&{{y}} $&{{y}} {{y}}');
    assert.equal(bridge.substitute('unchanged','x','v'),'unchanged');
    assert.equal(bridge.substitute('{{x}}','x',''),'');
    assert.equal(bridge.eventReady(1,true),true);
    assert.equal(bridge.eventReady(2,false),false);
    assert.equal(bridge.context,null);
});

test('native recovery reveals partially mutated turns and recovers moved media without overwriting new sources', {skip}, async()=>{
    const optimizer=owner();
    const bridge=await engine(optimizer);
    const classes=new Set(['cpo-hidden','cpo-offscreen']);
    const img=element({src:'old.png',srcset:'old2.png 2x'});
    const moved=element({src:'moved.png'});
    const changed=element({src:'original.png'});
    const turn={classList:{contains:key=>classes.has(key),add:key=>classes.add(key),remove:key=>classes.delete(key)},
        querySelectorAll:selector=>selector==='img'?[img]:[]};
    assert.equal(optimizer.stashSources(img,['src','srcset']),true);
    assert.equal(optimizer.stashSources(moved,['src']),true);
    assert.equal(optimizer.stashSources(changed,['src']),true);
    changed.setAttribute('src','application-new.png');
    assert.equal(bridge.restoreWindow([turn]),true);
    assert.equal(classes.size,0);
    assert.equal(img.getAttribute('src'),'old.png');
    assert.equal(img.getAttribute('srcset'),'old2.png 2x');
    assert.equal(bridge.restoreJournal([...optimizer.mediaJournal]),true);
    assert.equal(moved.getAttribute('src'),'moved.png');
    assert.equal(changed.getAttribute('src'),'application-new.png');
    assert.equal(optimizer.mediaJournal.size,0);
    assert.equal(bridge.context,null);
});

test('emergency journal rollback works with an unavailable WASM runtime',()=>{
    const optimizer=owner();
    const img=element({src:'old.png'});
    optimizer.stashSources(img,['src']);
    assert.equal(img.hasAttribute('src'),false);
    optimizer.restoreMediaJournal();
    assert.equal(img.getAttribute('src'),'old.png');
    assert.equal(optimizer.mediaJournal.size,0);
});

test('Rust intersection transition only expands on a newly armed visible edge',{skip},async()=>{
    const bridge=await engine();
    assert.equal(bridge.intersection(1|4|16),6);
    assert.equal(bridge.intersection(1|2|16),2);
    assert.equal(bridge.intersection(2),1);
    assert.equal(bridge.intersection(1|4|8|16),3);
    assert.equal(bridge.context,null);
});

test('native turn discovery uses DOM order and deduplicates selector fallback',{skip},async()=>{
    const bridge=await engine();
    const a={},b={};
    const root={querySelectorAll(selector){if(selector==='a,b')return [b,a];throw new Error('unexpected selector');}};
    assert.deepEqual(bridge.providerTurns(root,['a','b']),[b,a]);
    const fallback={querySelectorAll(selector){if(selector==='a,b')throw new Error('invalid combined query');return selector==='a'?[a,b]:[b];}};
    assert.deepEqual(bridge.providerTurns(fallback,['a','b']),[a,b]);
});
