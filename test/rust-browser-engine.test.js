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
    const bindings=require('../rust-browser-bindings.js');
    bridge.exports=await bindings.instantiate(fs.readFileSync(wasmPath),(op,a,b,c)=>bridge.host(op,a,b,c));
    assert.equal(bridge.exports.cpo_browser_abi(),bindings.abi);
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
    assert.equal(bridge.mutations([stream], 1, false, {invalidateNativeTurn: node=>cache.delete(node)}), false);
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

test('native exact text comparison normalizes streamed UTF-16 without hash-only acknowledgement',{skip},async()=>{
    const bridge=await engine();
    assert.equal(bridge.providerExactText('  a\n\t b  ','a b'),true);
    assert.equal(bridge.providerExactText('a b','ab'),false);
    assert.equal(bridge.providerExactText('same prefix','same prefix extra'),false);
    const prefix='a'.repeat(1023);
    assert.equal(bridge.providerExactText(prefix+'  \n b',prefix+' b'),true);
    assert.equal(bridge.providerExactText(prefix+'  \n b',prefix+' c'),false);
    assert.equal(bridge.providerExactText('\ud800 \udc00','\ud800\t\udc00'),true);
    assert.equal(bridge.providerExactText('\ud800','\ufffd'),false);
    assert.equal(bridge.context,null);
});
test('native provider traversal collects rows and skips assistant-only inspection on users',{skip},async()=>{
    const bridge=await engine();
    const queue=require('../rust-queue-bridge.js');
    const {instance}=await WebAssembly.instantiate(fs.readFileSync(path.join(__dirname,'..','optimizer_queue.wasm')),{});
    queue.install(instance.exports);
    const expected='hello world';
    const node={innerText:' hello\n world ',getAttribute:k=>k==='data-message-author-role'?'user':k==='data-message-id'?'u1':null,querySelector:()=>null};
    const adapter={_turnScanCacheEnabled:false};
    const rows=bridge.providerScanTurns(adapter,[node],expected,queue.fingerprint(expected),true);
    const snapshot=queue.providerTurnSnapshot(rows,queue.fingerprint(expected),true);
    assert.equal(snapshot.matchedUserTurnId,'u1');
    assert.equal(bridge.context,null);
});

test('native observation orders canonical generation signals before fallback',{skip},async()=>{
    const bridge=await engine();
    const calls=[];
    const adapter={id:'chatgpt',isActiveResponseNode:()=>true,getSelectorMatch(_doc,key){calls.push(key);return {element:key==='stopButton'?{}:null,selector:key==='stopButton'?'canonical-stop':''};},getSelectorNodes(_doc,key){calls.push(key);return [];},getRetryButtonMatch(){calls.push('retry');return {element:null};}};
    const doc={querySelectorAll(){throw new Error('canonical stop must skip semantic button scan');}};
    const result=bridge.providerObserveGeneration(adapter,doc,[]);
    assert.equal(result.flags,1);
    assert.equal(result.signals.stopButton,'canonical-stop');
    assert.deepEqual(calls,['stopButton','streaming','status','spinner','errorAlerts','retry']);
    assert.equal(bridge.context,null);
});

test('native retry traversal prefers newest latest-turn match and avoids scanning alerts',{skip},async()=>{
    const bridge=await engine();
    const queue=require('../rust-queue-bridge.js');
    queue.install(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'..','optimizer_queue.wasm'))),{}).exports);
    const button=(label)=>({getAttribute:key=>key==='aria-label'?label:null,innerText:label});
    const first=button('Retry'),last=button('Try again');
    const latest={querySelectorAll:()=>[first,last]};
    const adapter={getSelectorNodes(){throw Error('alert scan unnecessary');},isActiveResponseNode(){throw Error('fallback scan unnecessary');}};
    const doc={querySelectorAll(){throw Error('document scan unnecessary');}};
    assert.deepEqual(bridge.providerRetry(adapter,doc,[latest]),{element:last,selector:'retryButton.latestTurn',signalKey:'retryButton'});
    assert.equal(bridge.context,null);
});
test('native retry traversal checks ordered alerts and rejects historical fallback buttons',{skip},async()=>{
    const bridge=await engine();
    const queue=require('../rust-queue-bridge.js');
    queue.install(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'..','optimizer_queue.wasm'))),{}).exports);
    const button=()=>({innerText:'Retry',getAttribute:()=>null});
    const old=button(),live=button();
    const doc={querySelectorAll:()=>[live,old]};
    const empty={querySelectorAll:()=>[]};
    let alerts=[{element:empty,selector:'first'},{element:{querySelectorAll:()=>[live]},selector:'second'}];
    const adapter={getSelectorNodes:()=>alerts,isActiveResponseNode:node=>node===live};
    assert.equal(bridge.providerRetry(adapter,doc,[empty]).selector,'second');
    alerts=[];
    assert.equal(bridge.providerRetry(adapter,doc,[empty]).element,live);
    assert.equal(bridge.context,null);
});
test('native diagnostic scheduler observes required controls then discovery and route',{skip},async()=>{
    const bridge=await engine();
    const calls=[];
    const root={};
    const adapter={getSelectorMatch(){calls.push('root');return {element:root};},getComposerMatch(){calls.push('composer');return {element:null};},getSendActionMatch(){calls.push('send');return {element:{}};},getMessageDiscovery(_doc,element){assert.equal(element,root);calls.push('discovery');return {nodes:[]};},getConversationIdentity(){calls.push('identity');return {type:'new'};}};
    const result=bridge.providerDiagnostics(adapter,{},true);
    assert.equal(result.flags,5);
    assert.equal(result.valid,true);
    assert.deepEqual(calls,['root','composer','send','discovery','identity']);
    calls.length=0;
    assert.equal(bridge.providerDiagnostics(adapter,{},false).flags,5);
    assert.deepEqual(calls,['root','composer','send']);
});

test('native deduplication retains canonical descendants and avoids text extraction',{skip},async()=>{
    const bridge=await engine();
    const parent={tagName:'DIV',parentElement:null,getAttribute:()=>null};
    const child={tagName:'ARTICLE',parentElement:parent,getAttribute:()=>null};
    const other={tagName:'DIV',parentElement:null,getAttribute:()=>null};
    Object.defineProperty(child,'textContent',{get(){throw Error('unexpected text read');}});
    assert.deepEqual(bridge.deduplicateTurns([parent,child,parent,other]),[child,other]);
    const generic={tagName:'DIV',parentElement:parent,getAttribute:()=>null};
    assert.deepEqual(bridge.deduplicateTurns([generic,parent,generic,other]),[parent,other]);
});

test('generated browser bindings match the compiled native export contract',{skip},async()=>{
    const bindings=require('../rust-browser-bindings.js');
    const module=new WebAssembly.Module(fs.readFileSync(wasmPath));
    const names=WebAssembly.Module.exports(module).filter(x=>x.name.startsWith('cpo_')).map(x=>x.name).sort();
    assert.deepEqual(bindings.signatures.map(([name])=>name),names);
    const core=bindings.instantiateModule(module,()=>0);
    for(const [name,arity] of bindings.signatures)assert.equal(core[name].length,arity);
    assert.throws(()=>bindings.instantiateModule(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)),()=>0),/import mismatch/);
    assert.equal(core.cpo_browser_abi(),bindings.abi);
});

test('native DOM error markers and tool attributes use raw facts and streamed text',{skip},async()=>{
    const bridge=await engine();
    const queue=require('../rust-queue-bridge.js');
    queue.install(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'..','optimizer_queue.wasm'))),{}).exports);
    const facts=queue.providerCatalog(5);
    const error=(value,attribute='data-message-status')=>element({[attribute]:value});
    assert.equal(bridge.assistantError(error('  ERROR_STOP  '),facts.assistantErrorAttributes),true);
    assert.equal(bridge.assistantError(error('errorish'),facts.assistantErrorAttributes),false);
    assert.equal(bridge.assistantError(error('yes','data-error'),facts.assistantErrorAttributes),true);
    assert.equal(bridge.assistantError(error('yes'),facts.assistantErrorAttributes),false);
    const tool=element({'data-tool-state':'pending'},{matches:s=>s==='[data-tool-state]',innerText:'tool work'});
    const turn=element({}, {innerText:'response text',matches:()=>false,querySelectorAll:()=>[tool]});
    assert.equal(bridge.incompleteTool(turn,facts.toolTurnSelectors,facts.toolAttributes),true);
    tool.setAttribute('data-tool-state','complete');
    assert.equal(bridge.incompleteTool(turn,facts.toolTurnSelectors,facts.toolAttributes),false);
    turn.innerText='  tool\n work  ';
    assert.equal(bridge.incompleteTool(turn,facts.toolTurnSelectors,facts.toolAttributes),true);
    assert.equal(bridge.context,null);
});
test('generated host primitives perform only scoped browser operations',{skip},()=>{
    const bindings=require('../rust-browser-bindings.js');
    const ctx={accepted:[2,3],output:[],redundant:new Set(),spans:[],value:'ab'};
    assert.equal(bindings.dispatchHostPrimitive(16,0,0,0,ctx),2);
    bindings.dispatchHostPrimitive(23,0,1,0,ctx);
    assert.deepEqual(ctx.accepted,[3,2]);
    bindings.dispatchHostPrimitive(5,0,42,0,ctx);
    assert.deepEqual(ctx.output,[42]);
    assert.equal(bindings.dispatchHostPrimitive(124,1,0,0,ctx),98);
    assert.throws(()=>bindings.dispatchHostPrimitive(999,0,0,0,ctx),/Unknown Rust browser host operation/);
});

test('native media protection and conflict decisions preserve application sources',{skip},async()=>{
    const optimizer=owner(),bridge=await engine(optimizer);
    for(const value of ['blob:local','a.png 1x, DATA:image/png;base64,x','x'.repeat(8193),'a.png, '+' '.repeat(250)+'mediasource:x']){
        const img=element({srcset:value});
        const root={querySelectorAll:()=>[img],contains:()=>true};
        assert.equal(bridge.media(root,0),0);
        assert.equal(img.getAttribute('srcset'),value);
        assert.equal(optimizer.mediaOriginals.has(img),false);
    }
    const img=element({src:'https://example.test/blob:x',srcset:'ordinary.png 2x'});
    const root={querySelectorAll:()=>[img],contains:()=>true};
    assert.equal(bridge.media(root,0),1);
    img.setAttribute('src','replacement.png');
    assert.equal(bridge.media(root,1),0);
    assert.equal(img.getAttribute('src'),'replacement.png');
    assert.equal(img.hasAttribute('srcset'),false);
    assert.equal(optimizer.mediaOriginals.has(img),false);
    const legacy=element({'data-cpo-original-src':'old.png'});
    assert.equal(bridge.media({querySelectorAll:()=>[legacy]},1),0);
    assert.equal(legacy.getAttribute('src'),'old.png');
    assert.equal(legacy.hasAttribute('data-cpo-original-src'),false);
});
test('native journal restoration retains new application attributes',{skip},async()=>{
    const optimizer=owner(),bridge=await engine(optimizer);
    const first=element({src:'one.png'}),second=element({src:'two.png'});
    assert.equal(bridge.media({querySelectorAll:()=>[first,second]},0),2);
    second.setAttribute('src','new.png');
    assert.equal(bridge.restoreJournal([new WeakRef(first),new WeakRef(second)]),true);
    assert.equal(first.getAttribute('src'),'one.png');
    assert.equal(second.getAttribute('src'),'new.png');
    assert.equal(optimizer.mediaOriginals.has(first),false);
    assert.equal(optimizer.mediaOriginals.has(second),false);
});


test('native content controller rejects concurrent submissions and stale bind generations',{skip},async()=>{
    const bridge=await engine();
    const first=bridge.contentControl(0),second=bridge.contentControl(0);
    assert.equal(bridge.contentControl(1,first),0);
    assert.equal(bridge.contentControl(1,second),1);
    assert.equal(bridge.contentControl(5),1);
    assert.equal(bridge.contentControl(5),0);
    assert.equal(bridge.contentControl(6),1);
    assert.equal(bridge.contentControl(7),1);
    assert.equal(bridge.contentControl(8),3);
    assert.equal(bridge.contentControl(9),1);
    bridge.contentControl(2);
    assert.equal(bridge.contentControl(1,second),0);
    assert.equal(bridge.contentRoute(1|4|16|32),0);
    assert.equal(bridge.contentRoute(1|4|8|16|32),2);
});


test('native popup generations and bounded rendering reject stale UI results',{skip},async()=>{
    const bridge=await engine();
    const a=bridge.popupControl(0,3),b=bridge.popupControl(0,2);
    assert.equal(bridge.popupControl(1,3,a),1);
    const newer=bridge.popupControl(0,3);
    assert.notEqual(a,newer);assert.equal(bridge.popupControl(1,3,a),0);
    assert.equal(bridge.popupControl(1,2,b),1);
    assert.equal(bridge.popupControl(2,800),100);
    assert.equal(bridge.popupControl(3,800),200);
    assert.equal(bridge.popupTarget(7),1);
    assert.equal(bridge.popupScheduleGuard(3),3);
    assert.equal(bridge.popupSendAction(3),1);
    assert.equal(bridge.popupQueueView(7),3);
});
