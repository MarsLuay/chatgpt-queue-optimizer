const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const queue=require('../rust-queue-bridge.js');
const registry=require('../rust-browser-bridge.js');
function attach(adapter,owner={}){
    const bridge=new registry.CpoRustBrowserBridge(owner);
    const bindings=require('../rust-browser-bindings.js');
    bridge.exports=bindings.instantiateModule(new WebAssembly.Module(fs.readFileSync(path.join(root,'optimizer_browser.wasm'))),(op,a,b,c)=>bridge.host(op,a,b,c));
    bridge.status='Rust/WASM';
    adapter.setNativeSelectorEngine(bridge);
    adapter.setNativeLifecycle?.(bridge);
    adapter.setNativeMessageDiscovery?.((provider,doc,main)=>bridge.discover(provider,doc,main));
    return adapter;
}
function initializeQueue(){
    if(queue.status!=='Rust/WASM')queue.install(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(root,'optimizer_queue.wasm'))),{}).exports);
}
function initialize(){
    initializeQueue();
    for(const id of ['chatgpt','gemini','claude'])attach(registry.getProvider(id));
}
module.exports={initialize,initializeQueue,attach};

// Simulate extension resource URLs using only the checked-in build outputs.
const originalFetch=globalThis.fetch;
function resourceTransport(){
    if(!globalThis.chrome?.runtime)throw Error('Install browser API mock first');
    globalThis.chrome.runtime.getURL=name=>'https://cpo-test.invalid/'+name;
    globalThis.fetch=async(input,options)=>{
        const url=String(input);
        const prefix='https://cpo-test.invalid/';
        if(!url.startsWith(prefix))return originalFetch(input,options);
        const name=url.slice(prefix.length);
        if(!['optimizer_queue.wasm','optimizer_browser.wasm','optimizer_core.wasm','optimizer_history.wasm'].includes(name))throw Error('Unexpected fixture resource '+name);
        const bytes=fs.readFileSync(path.join(root,name));
        return {ok:true,status:200,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    };
    initializeQueue();
}
module.exports.resourceTransport=resourceTransport;
