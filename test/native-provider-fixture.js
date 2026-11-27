const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const queue=require('../rust-queue-bridge.js');
const registry=require('../rust-browser-bridge.js');
function attach(adapter,owner={}){
    const bridge=new registry.CpoRustBrowserBridge(owner);
    bridge.exports=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(root,'optimizer_browser.wasm'))),{cpo:{host:(op,a,b,c)=>bridge.host(op>>>0,a>>>0,b>>>0,c>>>0)>>>0}}).exports;
    bridge.status='Rust/WASM';
    adapter.setNativeSelectorEngine(bridge);
    adapter.setNativeLifecycle?.(bridge);
    adapter.setNativeMessageDiscovery?.((provider,doc,main)=>bridge.discover(provider,doc,main));
    return adapter;
}
function initialize(){
    if(queue.status!=='Rust/WASM')queue.install(new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(root,'optimizer_queue.wasm'))),{}).exports);
    for(const id of ['chatgpt','gemini','claude'])attach(registry.getProvider(id));
}
module.exports={initialize,attach};
