//! Queue execution decisions and streaming legacy-compatible UTF-16 fingerprints.
#![cfg_attr(target_arch = "wasm32", no_std)]
#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { core::arch::wasm32::unreachable() }

#[no_mangle]
pub extern "C" fn cpo_queue_abi() -> u32 { 4 }

const OFFSET: u32 = 2166136261;
const PRIME: u32 = 16777619;
const CHUNK: usize = 1024;

// ECMAScript WhiteSpace and LineTerminator code units (not Rust's Unicode
// whitespace definition). Keep persisted FNV fingerprints bit-for-bit stable.
fn whitespace(c: u16) -> bool {
    matches!(c, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 |
        0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
struct Fingerprint { hash: u32, len: u32, pending: bool }
impl Fingerprint {
    const fn new() -> Self { Self { hash: OFFSET, len: 0, pending: false } }
    fn push(&mut self, unit: u16) {
        self.hash = (self.hash ^ u32::from(unit)).wrapping_mul(PRIME);
        self.len = self.len.saturating_add(1);
    }
    fn update(&mut self, units: &[u16]) {
        for &unit in units {
            if whitespace(unit) {
                if self.len != 0 { self.pending = true; }
            } else {
                if self.pending { self.push(32); self.pending = false; }
                self.push(unit);
            }
        }
    }
}
#[cfg(target_arch = "wasm32")]
static mut INPUT: [u16; CHUNK] = [0; CHUNK];
#[cfg(target_arch = "wasm32")]
static mut STATE: Fingerprint = Fingerprint::new();

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_fingerprint_buffer() -> usize { core::ptr::addr_of_mut!(INPUT) as *mut u16 as usize }
#[no_mangle]
pub extern "C" fn cpo_fingerprint_capacity() -> u32 { CHUNK as u32 }
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_fingerprint_reset() {
    unsafe { core::ptr::write(core::ptr::addr_of_mut!(STATE), Fingerprint::new()); }
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_fingerprint_update(len: u32) -> u32 {
    if len as usize > CHUNK { return 0; }
    unsafe {
        let ptr = cpo_fingerprint_buffer() as *mut u16;
        let input = core::slice::from_raw_parts(ptr, len as usize);
        (*core::ptr::addr_of_mut!(STATE)).update(input);
        for i in 0..len as usize { core::ptr::write_volatile(ptr.add(i), 0); }
    }
    1
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_fingerprint_hash() -> u32 { unsafe { (*core::ptr::addr_of!(STATE)).hash } }
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_fingerprint_len() -> u32 { unsafe { (*core::ptr::addr_of!(STATE)).len } }

// Flags: running=1 paused=2 stopped=4 current=8 confirmed=16 rollover=32
// idle-before-send=64. Phases: terminal=1 waiting=2 retry-wait=3 rollover=4.
// Actions: stop=0 rollover=1 settle=2 wait=3 retry-wait=4 resume-wait=5
// recover unconfirmed=6 exhausted=7 validate+idle=8 validate+send=9.
#[no_mangle]
pub extern "C" fn cpo_queue_next(flags: u32, phase: u32, queued: u32) -> u32 {
    if flags & 1 == 0 || flags & 6 != 0 { return 0; }
    if flags & 32 != 0 || phase == 4 { return 1; }
    if flags & 8 != 0 {
        return match phase { 1 => 2, 2 => 3, 3 => 4, _ if flags & 16 != 0 => 5, _ => 6 };
    }
    if queued == 0 { 7 } else if flags & 64 != 0 { 8 } else { 9 }
}

// Recovery must never resubmit a command whose user turn was acknowledged.
#[no_mangle]
pub extern "C" fn cpo_queue_retry_action(current: u32, confirmed: u32) -> u32 {
    if current == 0 { 0 } else if confirmed != 0 { 1 } else { 2 }
}
#[no_mangle]
pub extern "C" fn cpo_queue_confirmed(turn_id: u32, state: u32) -> u32 {
    (turn_id != 0 || (1..=3).contains(&state)) as u32
}
#[no_mangle]
pub extern "C" fn cpo_queue_remaining(queued: u32, current: u32) -> u32 { queued.saturating_add((current != 0) as u32) }
#[no_mangle]
pub extern "C" fn cpo_queue_total(declared: u32, completed: u32, remaining: u32) -> u32 {
    declared.max(completed.saturating_add(remaining))
}
#[no_mangle]
pub extern "C" fn cpo_queue_can_retry(attempts: u32, limit: u32, unlimited: u32) -> u32 {
    (unlimited != 0 || attempts < limit) as u32
}
// Use host-configured policy constants, not a second hard-coded policy.
#[no_mangle]
pub extern "C" fn cpo_queue_backoff(attempt: u32, base: u32, factor: u32, cap: u32) -> u32 {
    let mut value = base.min(cap);
    for _ in 0..attempt.min(32) {
        let next = value.saturating_mul(factor).min(cap);
        if next == value { break; }
        value = next;
    }
    value.max(1)
}

// Submission acknowledgement: 0 wait, 1 exact new turn, 2 generation
// fallback. A fingerprint alone is never a new-turn acknowledgement.
#[no_mangle]
pub extern "C" fn cpo_submission_ack(flags: u32) -> u32 {
    if flags & 1 != 0 {
        if flags & 2 != 0 && flags & 4 == 0 && flags & 8 != 0 { 1 } else { 0 }
    } else if flags & 16 != 0 { 2 } else { 0 }
}

// Polling, cancellation and effects are split so the browser never performs
// a native decision on stale asynchronous observations.
#[no_mangle]
pub extern "C" fn cpo_submission_poll(elapsed: f64, timeout: f64, cancelled: u32) -> u32 {
    if cancelled != 0 { 2 }
    else if !elapsed.is_finite() || !timeout.is_finite() || elapsed > timeout { 0 }
    else { 1 }
}

// Submit stage: 0 before click, 1 after click, 2 acknowledgement.
// Flags: owned/running=1, baseline valid=2, click succeeded=4, ack=8.
// Baseline is advisory for providers without native turn acknowledgements.
#[no_mangle]
pub extern "C" fn cpo_submission_stage(stage: u32, flags: u32) -> u32 {
    if flags & 1 == 0 { return 0; }
    match stage {
        0 => 1, // browser effect: attempt click
        1 if flags & 4 != 0 => 2, // wait for acknowledgement
        2 if flags & 8 != 0 => 3, // confirmed
        _ => 0,
    }
}

// Delivery timeout recovery stages: 0 initial, 1 after reload,
// 2 after optional generation wait, 3 final recovery.
// Flags: active=1, retry available=2, generating=4, completed text=8,
// confirmed submission=16, current message=32, unlimited=64.
// Results: stop=0, in-page retry=1, reload=2, await=3, complete=4,
// retry button=5, resume confirmed=6, requeue=7, fail=8.
#[no_mangle]
pub extern "C" fn cpo_delivery_recovery(stage: u32, flags: u32, attempt: u32, limit: u32) -> u32 {
    if flags & 1 == 0 { return 0; }
    match stage {
        0 if flags & 64 == 0 && attempt > limit => 8,
        0 if flags & 2 != 0 => 1,
        0 => 2,
        1 if flags & 4 != 0 => 3,
        1 | 2 if flags & 8 != 0 => 4,
        1 | 2 if flags & 2 != 0 => 5,
        1..=3 if flags & 16 != 0 => 6,
        1..=3 if flags & 32 != 0 => 7,
        _ => 8,
    }
}

// Durable job restore: 0 keep, 1 resume wait, 2 terminal bookkeeping,
// 3 requeue unconfirmed. Phases: waiting=1, sending/ack=2, terminal=3.
// Flags: confirmed=1, terminal delivery=2, pre-click/unknown=4,
// current message=8. Preserve legacy durable schema and phase semantics.
#[no_mangle]
pub extern "C" fn cpo_restore_action(phase: u32, flags: u32) -> u32 {
    if phase == 3 || flags & 2 != 0 { 2 }
    else if flags & 1 != 0 && (phase == 1 || phase == 2) { 1 }
    else if flags & 8 != 0 && (phase == 2 || flags & 4 != 0) { 3 }
    else { 0 }
}
#[no_mangle]
pub extern "C" fn cpo_restore_eligible(tab: f64, queued: u32, current: u32, stopped: u32) -> u32 {
    (tab.is_finite() && tab > 0.0 && tab <= 9007199254740991.0 &&
        (tab as u64) as f64 == tab && (queued > 0 || current != 0) && stopped == 0) as u32
}
#[no_mangle]
pub extern "C" fn cpo_restore_command_number(current: u32, number: u32, completed: u32) -> u32 {
    if current != 0 && number == 0 { completed.saturating_add(1) } else { number }
}

// Persistence decision: equal pending=1, equal in-flight=2, equal durable=4,
// no in-flight=8, force=16, timer active=32.
// 0 await existing, 1 cancel redundant pending, 2 queue flush, 3 queue timer,
// 4 replace pending (existing timer). Forced identical pending must flush.
#[no_mangle]
pub extern "C" fn cpo_persist_action(flags: u32) -> u32 {
    if flags & 1 != 0 { if flags & 16 != 0 { 2 } else { 0 } }
    else if flags & 2 != 0 || flags & 12 == 12 { 1 }
    else if flags & 16 != 0 { 2 }
    else if flags & 32 == 0 { 3 } else { 4 }
}

// Scheduled states: unknown=0 pending=1 firing=2 completed=3 failed=4
// cancelled=5. Actions: cancel=1 delete=2 retry=3 claim=4 recover=5.
// 0 deny/no-op; 1 allow; 2 completed; 3 firing; 4 re-arm; 5 mark failed.
#[no_mangle]
pub extern "C" fn cpo_schedule_action(action: u32, state: u32, due: f64, now: f64) -> u32 {
    match action {
        1 | 3 if state == 3 => 2,
        1..=3 if state == 2 => 3,
        1..=3 => 1,
        4 if state == 1 && due.is_finite() && due > 0.0 && now.is_finite() => {
            if due <= now { 1 } else { 4 }
        }
        5 if state == 2 => 5,
        5 if state == 1 => 4,
        _ => 0,
    }
}
#[no_mangle]
pub extern "C" fn cpo_schedule_compare(a_due: f64, b_due: f64, a_created: f64, b_created: f64) -> u32 {
    let a = if a_due.is_finite() { a_due } else { 0.0 };
    let b = if b_due.is_finite() { b_due } else { 0.0 };
    if a < b { 0 } else if a > b { 2 }
    else if a_created < b_created { 0 } else if a_created > b_created { 2 } else { 1 }
}
#[no_mangle]
pub extern "C" fn cpo_schedule_identity(stored: u32, current: u32, flags: u32) -> u32 {
    // types: unknown=0, existing=1, new=2, unsupported=3, other=4.
    // provider mismatch=1, stored ID present=2, ID equal=4, keys equal=8.
    if flags & 1 != 0 || stored == 3 || current == 3 { return 0; }
    if stored == 1 && flags & 2 != 0 { return (current == 1 && flags & 4 != 0) as u32; }
    if stored == 2 { return (current == 1 || current == 2) as u32; }
    if stored == 0 || current == 0 { return 0; }
    (flags & 8 != 0) as u32
}

// Provider routing and marker matching use the bounded UTF-16 input buffer.
// Browser URL parsing stays with the platform; Rust classifies parsed hosts
// and paths. Packed route: kind in low 2 bits, ID start in bits 2..12,
// ID length in bits 13..23. 0 unsupported, 1 new, 2 existing.
fn ascii_eq(s: &[u16], text: &[u8]) -> bool {
    s.len() == text.len() && s.iter().zip(text).all(|(&a,&b)| a == u16::from(b))
}
fn provider_host(s: &[u16]) -> u32 {
    if ascii_eq(s,b"chatgpt.com") || ascii_eq(s,b"chat.openai.com") { 1 }
    else if ascii_eq(s,b"gemini.google.com") { 2 }
    else if ascii_eq(s,b"claude.ai") { 3 }
    else { 0 }
}
fn id_char(c: u16) -> bool { matches!(c, 45 | 48..=57 | 65..=90 | 95 | 97..=122) }
fn id_end(s: &[u16], start: usize) -> usize {
    let mut end = start;
    while end < s.len() && id_char(s[end]) { end += 1; }
    end
}
fn route_id(start: usize, end: usize) -> u32 {
    if end <= start { 0 } else { 2 | ((start as u32)<<2) | (((end-start) as u32)<<13) }
}
fn route(provider: u32, s: &[u16]) -> u32 {
    let slash = 47;
    if provider == 1 {
        for i in 0..s.len().saturating_sub(1) {
            if (i == 0 || s[i-1] == slash) && s[i] == 99 && s[i+1] == slash {
                let start = i+2;
                let end = id_end(s,start);
                if end > start { return route_id(start,end); }
            }
        }
        if s.is_empty() || s == [slash] { return 1; }
        if s.starts_with(&[slash,103,slash]) {
            let end = id_end(s,3);
            if end > 3 && (end == s.len() || (end+1 == s.len() && s[end] == slash)) { return 1; }
        }
    } else if provider == 2 {
        if s.is_empty() || s == [slash] { return 1; }
        let mut start = 0;
        if s.starts_with(&[slash]) { start = 1; }
        // Preserve the old suffix match for app/ID and anchored new routes.
        for i in 0..s.len() {
            if (i == 0 || s[i-1] == slash) && s[i..].starts_with(&[97,112,112,slash]) {
                let begin = i+4;
                let end = id_end(s,begin);
                let is_app = end-begin == 3 && s[begin..end].iter().zip(b"app").all(|(&a,&b)| a == b as u16 || a == (b-32) as u16);
                if end > begin && !is_app && (end == s.len() || (end+1 == s.len() && s[end] == slash)) { return route_id(begin,end); }
            }
        }
        if s[start..].starts_with(&[117,slash]) {
            start += 2;
            let begin = start;
            while start < s.len() && matches!(s[start],48..=57) { start += 1; }
            if start == begin || s.get(start) != Some(&slash) { return 0; }
            start += 1;
        }
        if ascii_eq(&s[start..],b"app") || ascii_eq(&s[start..],b"app/") { return 1; }
    } else if provider == 3 {
        if s.is_empty() || ascii_eq(s,b"/") || ascii_eq(s,b"/new") || ascii_eq(s,b"/new/") ||
            ascii_eq(s,b"/chat") || ascii_eq(s,b"/chat/") { return 1; }
        if s.starts_with(&[slash,99,104,97,116,slash]) {
            let end = id_end(s,6);
            if end > 6 && (end == s.len() || (end+1 == s.len() && s[end] == slash)) { return route_id(6,end); }
        }
    }
    0
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_host(len: u32) -> u32 {
    if len as usize > CHUNK { return 0; }
    provider_host(unsafe { core::slice::from_raw_parts(cpo_fingerprint_buffer() as *const u16,len as usize) })
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_route(provider: u32, len: u32) -> u32 {
    if len as usize > CHUNK { return 0; }
    route(provider,unsafe { core::slice::from_raw_parts(cpo_fingerprint_buffer() as *const u16,len as usize) })
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_marker_contains(hay: u32, needle: u32) -> u32 {
    let h = hay as usize; let n = needle as usize;
    if h > CHUNK || n > CHUNK-h { return 0; }
    if n == 0 { return 1; }
    let data = unsafe { core::slice::from_raw_parts(cpo_fingerprint_buffer() as *const u16,h+n) };
    data[..h].windows(n).any(|part| part == &data[h..]) as u32
}

// Generation observations: stop=1 streaming=2 tool=4 error=8 retry=16
// deep marker=32 capacity=64. Output generating=1 deep=2 unknown=4
// error=8 retry=16 active compatibility=32.
#[no_mangle]
pub extern "C" fn cpo_generation_state(flags: u32) -> u32 {
    let working = flags & 7 != 0;
    let error = flags & (8|64) != 0;
    let retry = flags & 16 != 0 && flags & 64 == 0;
    let active = !error && working;
    (active as u32) | (((active && flags & 32 != 0) as u32)<<1) |
        (((!error && !retry && !working) as u32)<<2) |
        ((error as u32)<<3) | ((retry as u32)<<4) |
        (((working && !error && !retry) as u32)<<5)
}

// Response classification priority matches provider adapter branches.
// flags: capacity=1 error-stop=2 general error=4 timeout=8 retry=16
// assistant error marker=32 waiting user=64 interrupted=128 completed=256
// generating=512 deep=1024 streaming=2048 incomplete tool=4096.
#[no_mangle]
pub extern "C" fn cpo_response_class(flags: u32) -> u32 {
    if flags & 1 != 0 { 1 }
    else if flags & 2 != 0 { 2 }
    else if flags & 8 != 0 { 3 }
    else if flags & 16 != 0 { 4 }
    else if flags & 4 != 0 { 5 }
    else if flags & 32 != 0 { 6 }
    else if flags & 64 != 0 { 7 }
    else if flags & 128 != 0 && flags & 256 == 0 { 8 }
    else if flags & 4096 != 0 { 9 }
    else if flags & 1024 != 0 { 10 }
    else if flags & 2048 != 0 { 11 }
    else if flags & 512 != 0 { 12 }
    else if flags & 256 != 0 { 13 }
    else { 0 }
}

// Queue wait: failure precedence and terminal confirmation classification.
#[no_mangle]
pub extern "C" fn cpo_wait_failure(flags: u32) -> u32 {
    if flags & 1 != 0 { 1 } else if flags & 2 != 0 { 2 }
    else if flags & 4 != 0 { 3 } else if flags & 8 != 0 { 4 }
    else if flags & 16 != 0 { 5 } else { 0 }
}
// flags: waiting existing=1, active=2, transient idle=4, bound=8,
// phase terminal=16, bound IDs compatible=32, saw activity=64,
// phase absent=128, incomplete tool=256.
#[no_mangle]
pub extern "C" fn cpo_wait_settle(flags: u32) -> u32 {
    if flags & 1 != 0 { if flags & 2 != 0 { 1 } else { 2 } }
    else if flags & 256 == 0 && (flags & 4 != 0 ||
        (flags & (8|128) == (8|128) && flags & (2|64) == 0)) { 3 }
    else if flags & (8|16|32) == (8|16|32) && flags & (2|256) == 0 { 4 }
    else if flags & 8 == 0 && flags & 64 != 0 && flags & 2 == 0 { 5 }
    else { 0 }
}

// Rollover execution stages. flags: owned=1 supported=2 started=4
// identity checkpoint=8 rebound=16 fresh=32 navigation issued=64
// handoff submitted=128 established=256 handoff present=512.
// 0 stop, 1 unsupported, 2 initialize, 3 inspect identity, 4 navigate,
// 5 await identity, 6 rebind, 7 inspect handoff, 8 submit handoff,
// 9 checkpoint handoff, 10 wait handoff, 11 resume.
#[no_mangle]
pub extern "C" fn cpo_rollover_next(stage: u32, flags: u32) -> u32 {
    if flags & 1 == 0 { return 0; }
    if flags & 2 == 0 { return 1; }
    match stage {
        0 if flags & 4 == 0 => 2,
        0 | 1 if flags & (8|16) != (8|16) => 3,
        2 if flags & 32 == 0 && flags & 64 == 0 => 4,
        2 if flags & 32 == 0 => 5,
        2 if flags & 16 == 0 => 6,
        3 if flags & 256 != 0 => 11,
        3 if flags & 128 == 0 => 7,
        4 if flags & 512 == 0 => 8,
        4 => 9,
        0..=4 => 10,
        _ => 11,
    }
}
// existing=1, new=2, other=0; flags provider correct=1, new ID present=2,
// ID differs=4, old ID present=8, navigation started=16.
#[no_mangle]
pub extern "C" fn cpo_rollover_fresh(kind: u32, flags: u32) -> u32 {
    (flags & 1 != 0 && ((kind == 1 && flags & 6 == 6) ||
        (kind == 2 && flags & (8|16) != 0))) as u32
}
#[no_mangle]
pub extern "C" fn cpo_rollover_generation(generation: u32, rebound: u32) -> u32 {
    generation.saturating_add((rebound == 0) as u32)
}

// JSON string serialization uses UTF-16 to preserve JavaScript strings,
// including lone surrogates. The host supplies bounded chunks without
// splitting surrogate pairs. Output matches well-formed JSON.stringify.
const JSON_OUTPUT_CAP: usize = CHUNK * 6;
fn escape_json(input: &[u16], output: &mut [u16]) -> usize {
    let mut i = 0;
    let mut n = 0;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    while i < input.len() {
        let unit = input[i];
        let short = match unit { 34 => 34, 92 => 92, 8 => 98, 9 => 116,
            10 => 110, 12 => 102, 13 => 114, _ => 0 };
        if short != 0 {
            output[n] = 92; output[n+1] = short; n += 2;
        } else if (0xd800..=0xdbff).contains(&unit) &&
            input.get(i+1).is_some_and(|v| (0xdc00..=0xdfff).contains(v)) {
            output[n] = unit; output[n+1] = input[i+1]; n += 2; i += 1;
        } else if unit < 32 || (0xd800..=0xdfff).contains(&unit) {
            output[n] = 92; output[n+1] = 117;
            for j in 0..4 { output[n+2+j] = HEX[((unit >> (12-j*4)) & 15) as usize] as u16; }
            n += 6;
        } else {
            output[n] = unit; n += 1;
        }
        i += 1;
    }
    n
}
#[cfg(target_arch = "wasm32")]
static mut JSON_OUTPUT: [u16; JSON_OUTPUT_CAP] = [0; JSON_OUTPUT_CAP];
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_json_output() -> usize { core::ptr::addr_of_mut!(JSON_OUTPUT) as *mut u16 as usize }
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_json_escape(len: u32) -> u32 {
    if len as usize > CHUNK { return 0; }
    let input = unsafe { core::slice::from_raw_parts(cpo_fingerprint_buffer() as *const u16,len as usize) };
    let out = unsafe { core::slice::from_raw_parts_mut(cpo_json_output() as *mut u16,JSON_OUTPUT_CAP) };
    escape_json(input,out) as u32
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_json_wipe(len: u32) {
    let p = cpo_json_output() as *mut u16;
    for i in 0..(len as usize).min(JSON_OUTPUT_CAP) { unsafe { core::ptr::write_volatile(p.add(i),0) }; }
}
// Syntax tokens: object/array begin/end, separator, colon, quote, null,
// true, false. Returning a packed ASCII token keeps the transport small.
#[no_mangle]
pub extern "C" fn cpo_json_token(kind: u32) -> u32 {
    match kind { 0=>123,1=>125,2=>91,3=>93,4=>44,5=>58,6=>34,
        7=>u32::from_le_bytes(*b"null"),8=>u32::from_le_bytes(*b"true"),_=>0 }
}

// Tabs: flags 1 valid id, 2 inactive, 4 complete, 8 ChatGPT,
// 16 protected (highlighted/pinned/audible/private/etc), 32 queue work,
// 64 unchanged identity/access, 128 content confirmed safe.
// Stage 0 candidate, stage 1 final authorization; mode 0 automatic,
// mode 1 explicitly requested. Never discard without the final safety checks.
#[no_mangle]
pub extern "C" fn cpo_tab_discard(stage: u32, mode: u32, flags: u32, minutes: u32, elapsed: f64) -> u32 {
    if flags & 15 != 15 || flags & 48 != 0 { return 0; }
    if mode == 0 && (!matches!(minutes,15|30|60) || !elapsed.is_finite() || elapsed < f64::from(minutes)*60000.0) { return 0; }
    if stage == 1 && flags & 192 != 192 { return 0; }
    (stage <= 1 && mode <= 1) as u32
}
#[no_mangle]
pub extern "C" fn cpo_tab_alarm(minutes: u32) -> u32 { matches!(minutes,15|30|60) as u32 }
// Reload effects: 1 content request, 2 tabs.reload, 3 script injection,
// 4 success, 0 unavailable. Each effect is attempted at most once.
#[no_mangle]
pub extern "C" fn cpo_tab_reload_next(stage: u32, flags: u32) -> u32 {
    if flags & 1 != 0 { return 4; }
    if stage == 0 { return 1; }
    if stage <= 1 && flags & 2 != 0 { return 2; }
    if stage <= 2 && flags & 4 != 0 { return 3; }
    0
}
#[no_mangle]
pub extern "C" fn cpo_tab_recover_poll(elapsed: f64, limit: f64, flags: u32) -> u32 {
    if flags & 2 != 0 { return 0; }
    if flags & 1 != 0 { return 2; }
    (elapsed.is_finite() && limit.is_finite() && elapsed < limit) as u32
}
#[no_mangle]
pub extern "C" fn cpo_tab_close_action(flags: u32) -> u32 {
    // A removed live job must be cancelled and checkpointed.
    (flags & 1 != 0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_escape_and_tab_lifecycle() {
        let input = [34,92,10,0,0xd800,0xd83d,0xde00,0xdc00];
        let mut out = [0;48];
        let n = escape_json(&input,&mut out);
        let expected = "\\\"\\\\\\n\\u0000\\ud800😀\\udc00".encode_utf16().collect::<Vec<_>>();
        assert_eq!(&out[..n],expected.as_slice());
        assert_eq!(cpo_tab_discard(0,0,15,15,900000.0),1);
        assert_eq!(cpo_tab_discard(0,0,15,15,899999.0),0);
        assert_eq!(cpo_tab_discard(1,1,15|192,0,0.0),1);
        assert_eq!(cpo_tab_discard(1,1,15|192|32,0,0.0),0);
        assert_eq!(cpo_tab_reload_next(1,6),2);
        assert_eq!(cpo_tab_reload_next(2,6),3);
        assert_eq!(cpo_tab_recover_poll(10.0,20.0,2),0);
    }
    #[test]
    fn provider_routes_and_response_priority() {
        let units = |s: &str| s.encode_utf16().collect::<Vec<_>>();
        assert_eq!(provider_host(&units("chatgpt.com")),1);
        assert_eq!(route(1,&units("/g/tool/c/abc")),route_id(10,13));
        assert_eq!(route(2,&units("/u/2/app/abc")),route_id(9,12));
        assert_eq!(route(2,&units("/u/2/app/")),1);
        assert_eq!(route(3,&units("/chat/abc")),route_id(6,9));
        assert_eq!(route(3,&units("/chat/abc/extra")),0);
        assert_eq!(cpo_response_class(1|512|256),1);
        assert_eq!(cpo_response_class(4096|256),9);
        assert_eq!(cpo_response_class(256),13);
        assert_eq!(cpo_generation_state(1|32),35);
        assert_eq!(cpo_wait_settle(8|16|32|256),0);
        assert_eq!(cpo_rollover_next(2,1|2|4),4);
        assert_eq!(cpo_rollover_next(4,1|2|512),9);
        assert_eq!(cpo_rollover_fresh(1,1|2),0);
        assert_eq!(cpo_rollover_generation(4,1),4);
    }
    #[test]
    fn fingerprint_chunks_and_ecmascript_whitespace() {
        let mut a = Fingerprint::new();
        a.update(&[0xfeff, 97, 0x2003]);
        a.update(&[0x000a, 98, 0x0020]);
        let mut b = Fingerprint::new();
        b.update(&[97,32,98]);
        assert_eq!((a.hash,a.len),(b.hash,3));
        assert!(!whitespace(0x0085));
        assert!(!whitespace(0x180e));
        assert!(!whitespace(0xd800));
    }
    #[test]
    fn submission_recovery_and_durable_policy() {
        assert_eq!(cpo_submission_ack(1|2|8),1);
        assert_eq!(cpo_submission_ack(1|2|4|8),0);
        assert_eq!(cpo_submission_ack(1|16),0);
        assert_eq!(cpo_submission_ack(16),2);
        assert_eq!(cpo_submission_poll(8000.0,8000.0,0),1);
        assert_eq!(cpo_submission_poll(8001.0,8000.0,0),0);
        assert_eq!(cpo_delivery_recovery(3,1|16|32,1,3),6);
        assert_eq!(cpo_delivery_recovery(3,1|32,1,3),7);
        assert_eq!(cpo_delivery_recovery(0,1|2,4,3),8);
        assert_eq!(cpo_restore_action(2,1|8),1);
        assert_eq!(cpo_restore_action(2,4|8),3);
        assert_eq!(cpo_restore_action(2,2|8),2);
        assert_eq!(cpo_restore_eligible(12.0,1,0,1),0);
        assert_eq!(cpo_persist_action(1|16),2);
        assert_eq!(cpo_persist_action(4|8),1);
    }
    #[test]
    fn scheduler_never_fires_early() {
        let now = 1_800_000_000_000.0;
        assert_eq!(cpo_schedule_action(4,1,now+1.0,now),4);
        assert_eq!(cpo_schedule_action(4,1,now,now),1);
        assert_eq!(cpo_schedule_action(4,2,now,now),0);
        assert_eq!(cpo_schedule_action(5,2,now,now),5);
        assert_eq!(cpo_schedule_action(1,3,now,now),2);
        assert_eq!(cpo_schedule_identity(1,1,2|4),1);
        assert_eq!(cpo_schedule_identity(1,1,2),0);
    }
    #[test]
    fn queue_priority_and_delivery_safety() {
        assert_eq!(cpo_queue_next(1|8|16, 3, 5),4);
        assert_eq!(cpo_queue_next(1|8|16, 0, 5),5);
        assert_eq!(cpo_queue_next(1|8, 0, 5),6);
        assert_eq!(cpo_queue_next(1|8|32, 1, 5),1);
        assert_eq!(cpo_queue_next(1|2|32, 1, 5),0);
        assert_eq!(cpo_queue_next(1|64, 0, 5),8);
        assert_eq!(cpo_queue_next(1, 0, 0),7);
        assert_eq!(cpo_queue_retry_action(1,1),1);
        assert_eq!(cpo_queue_retry_action(1,0),2);
        assert_eq!(cpo_queue_backoff(100,2000,2,30000),30000);
        assert_eq!(cpo_queue_can_retry(3,3,0),0);
    }
}
