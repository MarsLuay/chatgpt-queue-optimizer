//! Shared browser transport policy and build-time binding descriptors.
//! Operation IDs are stable and one-based. Only the first six support
//! emergency bootstrap when the queue WASM is unavailable.
pub const API_EVENTS: &[&[u8]] = &[b"localGet",b"localSet",b"syncGet",b"syncSet",b"tabGet",b"tabQuery",b"tabUpdate",b"tabCreate",b"tabSend",b"runtimeSend",b"tabDiscard",b"tabReload",b"scriptExecute",b"cssInsert",b"legacyScriptExecute",b"legacyCssInsert"];
pub const API_PATHS: &[&[u8]] = &[
    b"storage.local.get",b"storage.local.set",b"storage.sync.get",b"storage.sync.set",
    b"tabs.get",b"tabs.query",b"tabs.update",b"tabs.create",b"tabs.sendMessage",
    b"runtime.sendMessage",b"tabs.discard",b"tabs.reload",b"scripting.executeScript",
    b"scripting.insertCSS",b"tabs.executeScript",b"tabs.insertCSS",
];
#[allow(dead_code)]
pub const EMERGENCY_COUNT: usize = 6;

// Promise API first; callback API second. Unknown operations fail closed.
#[no_mangle]
pub extern "C" fn cpo_api_mode(code:u32,argc:u32,flags:u32)->u32 {
    let expected=match code{1..=6|8|10..=14=>1,7|9|15|16=>2,_=>return 0};
    if argc!=expected{return 0;}
    if flags&1!=0{1}else if flags&2!=0{2}else{0}
}

// Packed ASCII path for the native bridge.
#[no_mangle]
pub extern "C" fn cpo_api_path(code:u32,offset:u32)->u32 {
    let Some(path)=code.checked_sub(1).and_then(|i|API_PATHS.get(i as usize)) else{return 0;};
    let mut packed=0;
    for i in 0..4 {if let Some(&ch)=path.get(offset as usize+i){packed|=u32::from(ch)<<(i*8);}}
    packed
}

// Modern injection takes precedence. Legacy accepts a single file or,
// for scripts only, a function. Invalid tab identities fail closed.
#[no_mangle]
pub extern "C" fn cpo_injection_route(css:u32,flags:u32)->u32 {
    if flags&16==0{return 0;}
    if flags&1!=0{return if css==0{13}else{14};}
    if flags&2==0{return 0;}
    if flags&4!=0 || (css==0&&flags&8!=0){if css==0{15}else{16}}else{0}
}

// Call-local completion: only the first success or failure is accepted.
#[no_mangle]
pub extern "C" fn cpo_async_transition(state:u32,event:u32)->u32 {
    if state==0 && matches!(event,1|2){event}else{0}
}
