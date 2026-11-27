//! Queue execution decisions and streaming legacy-compatible UTF-16 fingerprints.

#[no_mangle]
pub extern "C" fn cpo_queue_abi() -> u32 { 17 }

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

// The durable schema is native-owned. The browser receives only field names,
// conversion instructions and scalar results, never a retained copy of a job.
// Mode 0 projects a live job, mode 1 reconstructs a stored job.
struct DurableField { name: &'static str, project: u32, restore: u32 }
const DURABLE_FIELDS: &[DurableField] = &[
    DurableField { name: "tabId", project: 18, restore: 18 },
    DurableField { name: "provider", project: 8, restore: 8 },
    DurableField { name: "conversationId", project: 2, restore: 2 },
    DurableField { name: "conversationType", project: 9, restore: 9 },
    DurableField { name: "targetKey", project: 10, restore: 10 },
    DurableField { name: "queue", project: 6, restore: 6 },
    DurableField { name: "currentMessage", project: 7, restore: 7 },
    DurableField { name: "isRunning", project: 13, restore: 13 },
    DurableField { name: "isPaused", project: 4, restore: 3 },
    DurableField { name: "isStopped", project: 14, restore: 14 },
    DurableField { name: "pausedReason", project: 1, restore: 1 },
    DurableField { name: "lastError", project: 1, restore: 1 },
    DurableField { name: "runId", project: 11, restore: 11 },
    DurableField { name: "totalMessages", project: 17, restore: 17 },
    DurableField { name: "completedCount", project: 5, restore: 5 },
    DurableField { name: "currentCommandNumber", project: 5, restore: 5 },
    DurableField { name: "currentPhase", project: 12, restore: 12 },
    DurableField { name: "waitForIdleBeforeSend", project: 3, restore: 3 },
    DurableField { name: "deliveryTimeoutAttempts", project: 5, restore: 5 },
    DurableField { name: "retryAttemptCount", project: 5, restore: 5 },
    DurableField { name: "lastRetryableReason", project: 1, restore: 1 },
    DurableField { name: "retryClass", project: 1, restore: 1 },
    DurableField { name: "retryMode", project: 15, restore: 15 },
    DurableField { name: "nextRetryDelayMs", project: 5, restore: 5 },
    DurableField { name: "nextRetryAt", project: 5, restore: 5 },
    DurableField { name: "retryExhausted", project: 3, restore: 3 },
    DurableField { name: "waitStartedAt", project: 5, restore: 5 },
    DurableField { name: "lastResearchProgressAt", project: 5, restore: 5 },
    DurableField { name: "sawDeepResearch", project: 3, restore: 3 },
    DurableField { name: "sawGenerating", project: 3, restore: 3 },
    DurableField { name: "deliveryState", project: 1, restore: 1 },
    DurableField { name: "commandId", project: 1, restore: 1 },
    DurableField { name: "commandFingerprint", project: 1, restore: 1 },
    DurableField { name: "submittedUserTurnId", project: 2, restore: 2 },
    DurableField { name: "assistantTurnId", project: 2, restore: 2 },
    DurableField { name: "submissionAckSource", project: 1, restore: 1 },
    DurableField { name: "terminalAckSource", project: 1, restore: 1 },
    DurableField { name: "lastResponsePhase", project: 1, restore: 1 },
    DurableField { name: "rolloverInProgress", project: 3, restore: 3 },
    DurableField { name: "rolloverStage", project: 1, restore: 1 },
    DurableField { name: "rolloverReason", project: 1, restore: 1 },
    DurableField { name: "rolloverFromConversationId", project: 2, restore: 2 },
    DurableField { name: "rolloverToConversationId", project: 2, restore: 2 },
    DurableField { name: "rolloverNavigationStarted", project: 3, restore: 3 },
    DurableField { name: "rolloverRebindApplied", project: 3, restore: 3 },
    DurableField { name: "handoffSubmitted", project: 3, restore: 3 },
    DurableField { name: "handoffEstablished", project: 3, restore: 3 },
    DurableField { name: "handoffFingerprint", project: 1, restore: 1 },
    DurableField { name: "conversationGeneration", project: 5, restore: 5 },
    DurableField { name: "startedAt", project: 16, restore: 16 },
    DurableField { name: "updatedAt", project: 16, restore: 16 },
];
#[no_mangle]
pub extern "C" fn cpo_durable_field_count() -> u32 { DURABLE_FIELDS.len() as u32 }
#[no_mangle]
pub extern "C" fn cpo_durable_field_rule(index: u32, mode: u32) -> u32 {
    DURABLE_FIELDS.get(index as usize).map_or(0, |field| if mode == 0 { field.project } else { field.restore })
}
#[no_mangle]
pub extern "C" fn cpo_durable_field_name(index: u32, offset: u32) -> u32 {
    let Some(field) = DURABLE_FIELDS.get(index as usize) else { return 0; };
    let bytes = field.name.as_bytes();
    let mut value = 0;
    for i in 0..4 { if let Some(&byte) = bytes.get(offset as usize + i) { value |= u32::from(byte) << (i*8); } }
    value
}

// Defaults for missing text fields. 1 empty, 2 null, 3 chatgpt,
// 4 existing, 5 new, 6 unknown, 7 synthesized target, 8 new run ID,
// 9 queued, 10 waiting-for-idle, 11 waiting.
// flags: conversation ID=1, legacy chatgpt:new=2, wait for idle=4,
// current message=8.
#[no_mangle]
pub extern "C" fn cpo_durable_default(rule: u32, mode: u32, flags: u32) -> u32 {
    match rule {
        1 | 15 => 1,
        2 => 2,
        7 => if mode == 0 { 1 } else { 2 },
        8 => 3,
        9 => if flags & 1 != 0 { 4 } else if mode == 1 && flags & 2 != 0 { 5 } else { 6 },
        10 => 7,
        11 => if mode == 0 { 1 } else { 8 },
        12 => if mode == 1 && flags & 4 != 0 { 10 }
              else if mode == 1 && flags & 8 != 0 { 11 } else { 9 },
        _ => 0,
    }
}
#[no_mangle]
pub extern "C" fn cpo_durable_number(rule: u32, mode: u32, value: f64, now: f64) -> f64 {
    let v = if rule == 16 && mode == 1 && value == 0.0 { now } else { value };
    if !v.is_finite() || v < 0.0 || v > 9007199254740991.0 ||
        (v as u64) as f64 != v || (rule == 18 && v == 0.0) { f64::NAN } else { v }
}
// flags: exact true=1, exact false=2, truthy=4, paused=true=8.
#[no_mangle]
pub extern "C" fn cpo_durable_boolean(rule: u32, mode: u32, flags: u32) -> u32 {
    match rule {
        3 => (flags & 1 != 0) as u32,
        4 => (flags & 4 != 0) as u32,
        13 if mode == 1 => (flags & 10 == 0) as u32,
        13 => (flags & 4 != 0) as u32,
        14 if mode == 1 => 0,
        14 => (flags & 4 != 0) as u32,
        _ => 0,
    }
}
#[no_mangle]
pub extern "C" fn cpo_durable_retry_mode(mode: u32, value: u32) -> u32 {
    if mode == 0 || value <= 2 { value } else { 0 }
}
// Preserve the legacy ECMAScript trim semantics without allocating a
// normalized copy of a potentially enormous queued prompt in WASM.
fn trim_edges(input: &[u16]) -> (usize, usize) {
    let start = input.iter().position(|&c| !whitespace(c)).unwrap_or(input.len());
    let end = input.iter().rposition(|&c| !whitespace(c)).map_or(start, |i| i+1);
    (start,end)
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_durable_trim(len: u32) -> u32 {
    if len as usize > CHUNK { return u32::MAX; }
    let input=unsafe { core::slice::from_raw_parts(cpo_fingerprint_buffer() as *const u16,len as usize) };
    let (start,end)=trim_edges(input);
    (start as u32) | ((end as u32)<<11)
}

// Application policy, shared across popup, content and background realms.
// Settings 0 window, 1 batch, 2 resource budget, 3 inactive minutes.
#[no_mangle]
pub extern "C" fn cpo_setting_number(kind: u32, value: f64) -> u32 {
    match kind {
        0 => if value.is_finite() && value > 0.0 { (value as u32).clamp(10,500) } else { 50 },
        1 => if value.is_finite() && value > 0.0 { (value as u32).clamp(5,100) } else { 25 },
        2 => if value.is_finite() && value > 0.0 { (value as u32).clamp(1000,1000000) } else { 8000 },
        3 => if value == 15.0 || value == 30.0 || value == 60.0 { value as u32 } else { 0 },
        _ => 0,
    }
}
// tri-state: missing/invalid=0, false=1, true=2.
#[no_mangle]
pub extern "C" fn cpo_setting_bool(default: u32, value: u32) -> u32 {
    match value { 1 => 0, 2 => 1, _ => (default != 0) as u32 }
}
// Scheduled popup controls: cancel=1, retry=2, delete=4. Status codes
// match the scheduler's pending/firing/completed/failed/cancelled mapping.
#[no_mangle]
pub extern "C" fn cpo_popup_schedule_actions(state:u32)->u32 {
    match state {1=>5,2=>0,4|5=>6,_=>4}
}
// Priority order of popup statuses, lower bit wins.
#[no_mangle]
pub extern "C" fn cpo_popup_status(flags: u32) -> u32 {
    if flags == 0 { 10 } else { flags.trailing_zeros().min(10) }
}
#[no_mangle]
pub extern "C" fn cpo_popup_remaining(sum: f64, value: f64) -> f64 {
    let valid = |n:f64| if n.is_finite() && n >= 0.0 && n <= 9007199254740991.0 { n } else { 0.0 };
    (valid(sum)+valid(value)).min(9007199254740991.0)
}
#[no_mangle]
pub extern "C" fn cpo_log_duplicate(same: u32, elapsed: f64, interval: f64) -> u32 {
    (same != 0 && elapsed.is_finite() && elapsed >= 0.0 && elapsed < interval) as u32
}
#[no_mangle]
pub extern "C" fn cpo_log_keep_start(old: u32, added: u32, limit: u32) -> u32 {
    old.saturating_add(added).saturating_sub(limit)
}
#[no_mangle]
pub extern "C" fn cpo_log_limit(kind: u32, depth: u32, length: u32) -> u32 {
    match kind { 0 => if length > 700 { 697 } else { length },
        1 => if depth >= 2 { 0 } else { length.min(12) },
        2 => if depth >= 3 { 0 } else { length.min(30) }, _ => 0 }
}
fn sensitive_key(s: &[u16]) -> bool {
    const EXACT: &[&[u8]] = &[b"currentmessage",b"text",b"prompt",b"composertext",b"lastqueuedtext",
        b"errorsnippet",b"researchstatuspreview",b"recoveredturnpreview",b"assistantpreview",b"handofftext",
        b"handoff",b"title",b"url",b"href",b"location",b"conversationid",b"conversationkey",
        b"arguments",b"tool",b"tools",b"toolargs",b"token"];
    const PART: &[&[u8]] = &[b"preview",b"snippet",b"handofftext",b"path",b"filename",
        b"conversationcontent",b"conversationtext",b"transcript",b"assistanttext",b"usertext",
        b"toolargument",b"toolcall",b"toolinput",b"tooloutput",b"functionargument",b"secret",
        b"password",b"credential",b"authorization",b"cookie",b"apikey",b"privatekey"];
    EXACT.iter().any(|v| ascii_eq(s,v)) ||
        PART.iter().any(|v| s.windows(v.len()).any(|p| ascii_eq(p,v))) ||
        (s.len() >= 5 && ascii_eq(&s[s.len()-5..],b"token"))
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_log_sensitive(len:u32)->u32 {
    if len as usize > CHUNK { return 1; }
    sensitive_key(unsafe {core::slice::from_raw_parts(cpo_fingerprint_buffer() as *const u16,len as usize)}) as u32
}

// Browser message/API dispatch tables. Unknown names never authorize effects.
const CONTENT_EVENTS: &[&[u8]] = &[b"GET_NATIVE_SUBMISSION_CAPABILITY",b"NATIVE_SUBMIT_PROMPT",b"TOGGLE_OPTIMIZER",b"UPDATE_CONFIG",b"CPO_HISTORY_BATCH",b"CAN_DISCARD_INACTIVE_TAB",b"GET_STATUS",b"GET_CONVERSATION_IDENTITY",b"CHECK_GENERATION_STATE",b"GET_COMMAND_TURN_SNAPSHOT",b"GET_COMMAND_RESPONSE_STATE",b"INSPECT_GENERATION_STATE",b"CLICK_RETRY_BUTTON",b"RELOAD_PAGE",b"GET_ENTER_DIAGNOSTICS",b"DEBUG_MESSAGES"];
const BACKGROUND_EVENTS: &[&[u8]] = &[b"authorizeNativeQueueClick",b"discardHistorySource",b"startSequence",b"enqueueMessage",b"retryPausedJob",b"stopSequence",b"stopAllSequences",b"getRunningJobs",b"getQueueDebugLogs",b"clearQueueDebugLogs",b"logAutomationEvent",b"scheduleMessage",b"listScheduledMessages",b"cancelScheduledMessage",b"deleteScheduledMessage",b"retryScheduledMessage"];
const API_EVENTS: &[&[u8]] = &[b"localGet",b"localSet",b"syncGet",b"syncSet",b"tabGet",b"tabQuery",b"tabUpdate",b"tabCreate",b"tabSend",b"runtimeSend",b"tabDiscard",b"tabReload",b"scriptExecute",b"cssInsert",b"legacyScriptExecute",b"legacyCssInsert"];
fn event_code(domain:u32, input:&[u16])->u32 {
    let table=match domain {0=>CONTENT_EVENTS,1=>BACKGROUND_EVENTS,2=>API_EVENTS,_=>return 0};
    table.iter().position(|name|ascii_eq(input,name)).map_or(0,|i|i as u32+1)
}
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_event_code(domain:u32,len:u32)->u32 {
    if len as usize>CHUNK{return 0;}
    event_code(domain,unsafe{core::slice::from_raw_parts(cpo_fingerprint_buffer() as *const u16,len as usize)})
}
// Content event capability: 0 bootstrap/read-only, 1 observation,
// 2 action, 3 snapshot, 4 safety.
#[no_mangle]
pub extern "C" fn cpo_content_event_kind(code:u32)->u32 {
    match code {2|13=>2,5=>3,6=>4,9..=12=>1,_=>0}
}
// API selection: promise API first, callback API second. Refuse unknown
// operation/argument count and never retry a mutating operation.
#[no_mangle]
pub extern "C" fn cpo_api_mode(code:u32,argc:u32,flags:u32)->u32 {
    let expected=match code{1..=6|8|10..=14=>1,7|9|15|16=>2,_=>return 0};
    if argc!=expected{return 0;}
    if flags&1!=0{1}else if flags&2!=0{2}else{0}
}

// Platform method paths are owned by Rust. Host resolves each component
// against browser/chrome, preserving the original receiver.
const API_PATHS: &[&[u8]] = &[
    b"storage.local.get",b"storage.local.set",b"storage.sync.get",b"storage.sync.set",
    b"tabs.get",b"tabs.query",b"tabs.update",b"tabs.create",b"tabs.sendMessage",
    b"runtime.sendMessage",b"tabs.discard",b"tabs.reload",b"scripting.executeScript",
    b"scripting.insertCSS",b"tabs.executeScript",b"tabs.insertCSS",
];
#[no_mangle]
pub extern "C" fn cpo_api_path(code:u32,offset:u32)->u32 {
    let Some(path)=code.checked_sub(1).and_then(|i|API_PATHS.get(i as usize)) else{return 0;};
    let mut packed=0;
    for i in 0..4 {if let Some(&ch)=path.get(offset as usize+i){packed|=u32::from(ch)<<(i*8);}}
    packed
}
// Injection selection occurs before any effect: modern API takes precedence.
// Legacy accepts one file or one function; CSS accepts only one file.
// flags: modern available=1, legacy available=2, single file=4,
// function=8, valid tab=16. Return a single API opcode.
#[no_mangle]
pub extern "C" fn cpo_injection_route(css:u32,flags:u32)->u32 {
    if flags&16==0{return 0;}
    if flags&1!=0{return if css==0{13}else{14};}
    if flags&2==0{return 0;}
    if flags&4!=0 || (css==0&&flags&8!=0){if css==0{15}else{16}}else{0}
}
// Completion state is call-local, not a persistent global handle table.
// 0 pending, 1 fulfilled, 2 rejected. A second completion is ignored.
// event: 1 successful callback/promise, 2 rejection or thrown exception.
#[no_mangle]
pub extern "C" fn cpo_async_transition(state:u32,event:u32)->u32 {
    if state==0 && matches!(event,1|2){event}else{0}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_transport_contract() {
        assert_eq!(cpo_api_path(1,0),u32::from_le_bytes(*b"stor"));
        assert_eq!(cpo_api_path(16,0),u32::from_le_bytes(*b"tabs"));
        assert_eq!(cpo_api_path(0,0),0);
        assert_eq!(cpo_injection_route(0,1|2|4|16),13);
        assert_eq!(cpo_injection_route(1,2|4|16),16);
        assert_eq!(cpo_injection_route(1,2|8|16),0);
        assert_eq!(cpo_async_transition(0,1),1);
        assert_eq!(cpo_async_transition(0,2),2);
        assert_eq!(cpo_async_transition(1,2),0);
        assert_eq!(cpo_async_transition(2,1),0);
    }
    #[test]
    fn browser_event_dispatch() {
        assert_eq!(event_code(0,&"CPO_HISTORY_BATCH".encode_utf16().collect::<Vec<_>>()),5);
        assert_eq!(event_code(1,&"stopSequence".encode_utf16().collect::<Vec<_>>()),6);
        assert_eq!(event_code(2,&"tabSend".encode_utf16().collect::<Vec<_>>()),9);
        assert_eq!(event_code(2,&"constructor".encode_utf16().collect::<Vec<_>>()),0);
        assert_eq!(cpo_content_event_kind(5),3);
        assert_eq!(cpo_api_mode(9,2,3),1);
        assert_eq!(cpo_api_mode(9,2,2),2);
        assert_eq!(cpo_api_mode(9,1,3),0);
    }
    #[test]
    fn application_policies() {
        assert_eq!(cpo_setting_number(0,900.0),500);
        assert_eq!(cpo_setting_number(1,f64::NAN),25);
        assert_eq!(cpo_setting_number(3,16.0),0);
        assert_eq!(cpo_popup_status(1|4),0);
        assert_eq!(cpo_popup_status(0),10);
        assert_eq!(cpo_log_keep_start(299,10,300),9);
        assert_eq!(cpo_log_limit(0,0,701),697);
        assert!(sensitive_key(&"accesstoken".encode_utf16().collect::<Vec<_>>()));
        assert!(!sensitive_key(&"commandnumber".encode_utf16().collect::<Vec<_>>()));
    }
    #[test]
    fn durable_schema_and_defaults() {
        assert_eq!(cpo_durable_field_count(),51);
        assert_eq!(cpo_durable_field_name(0,0),u32::from_le_bytes(*b"tabI"));
        assert_eq!(cpo_durable_field_rule(8,0),4);
        assert_eq!(cpo_durable_field_rule(8,1),3);
        assert_eq!(cpo_durable_default(9,1,2),5);
        assert_eq!(cpo_durable_default(9,0,2),6);
        assert_eq!(cpo_durable_default(12,1,12),10);
        assert_eq!(cpo_durable_default(12,1,8),11);
        assert_eq!(cpo_durable_boolean(13,1,8),0);
        assert_eq!(cpo_durable_boolean(13,1,0),1);
        assert_eq!(cpo_durable_number(16,1,0.0,1800000000000.0),1800000000000.0);
        assert!(cpo_durable_number(5,1,-1.0,0.0).is_nan());
        assert!(cpo_durable_number(18,1,0.0,0.0).is_nan());
        assert_eq!(trim_edges(&[0xfeff,32,97,0xd800,32]),(2,4));
        assert_eq!(trim_edges(&[32,10]),(2,2));
    }
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


 // Live queue state is isolated to the background worker's WASM instance.
 // JSON scalar bytes preserve JS number/string semantics (including lone surrogates).
 // The pending prompts are a real deque; the host only holds opaque handles.
mod live_state {
    use std::{cell::RefCell, collections::{BTreeMap, VecDeque}};
    const QUEUE: usize = 5;
    const MAX_INPUT: usize = 64 * 1024 * 1024;
    const METADATA: u32 = u32::MAX;
    struct Job {
        fields: Vec<Option<Vec<u8>>>,
        queue: VecDeque<Vec<u8>>,
        revision: u64,
        metadata: Option<(u64, Vec<u8>)>,
    }
    // Field indices are obtained from the canonical durable schema.
    fn field(name:&str)->usize{super::DURABLE_FIELDS.iter().position(|f|f.name==name).expect("known job field")}
    const EMPTY:&[u8]=b"\"\"";
    const NULL:&[u8]=b"null";
    const ZERO:&[u8]=b"0";
    const FALSE:&[u8]=b"false";
    const TRUE:&[u8]=b"true";
    fn json_len(bytes:&[u8])->usize{
        // JSON.stringify emits UTF-8 with escaped control/lone surrogate
        // units; count the original UTF-16 length without decoding a prompt.
        if bytes.first()!=Some(&b'"')||bytes.last()!=Some(&b'"'){return 0;}
        let mut i=1;let mut count=0;
        while i+1<bytes.len(){
            let c=bytes[i];count+=1;
            if c==b'\\'{i+=if bytes.get(i+1)==Some(&b'u'){6}else{2};}
            else if c<128{i+=1;}
            else if c<224{i+=2;}
            else if c<240{i+=3;}
            else{i+=4;count+=1;}
        }
        count
    }
    fn present(bytes:&[u8])->bool{!bytes.is_empty()&&bytes!=NULL&&bytes!=EMPTY&&bytes!=FALSE&&bytes!=ZERO}
    fn number(bytes:&[u8])->u32{std::str::from_utf8(bytes).ok().and_then(|v|v.parse::<u32>().ok()).unwrap_or(0)}
    fn quoted(text:&str)->Vec<u8>{let mut v=Vec::with_capacity(text.len()+2);v.push(b'"');v.extend_from_slice(text.as_bytes());v.push(b'"');v}
    // Patch wire: repeated field index, byte length, JSON scalar bytes.
    // Parse the entire frame before any state mutation.
    fn patch(input:&[u8])->Option<Vec<(usize,Option<Vec<u8>>)>>{
        let mut at=0;let mut out=Vec::new();
        while at<input.len(){
            let idx=u32::from_le_bytes(input.get(at..at+4)?.try_into().ok()?) as usize;
            let len=u32::from_le_bytes(input.get(at+4..at+8)?.try_into().ok()?) as usize;
            at+=8;let end=at.checked_add(len)?;
            if idx==QUEUE||idx>super::DURABLE_FIELDS.len(){return None;}
            let value=input.get(at..end)?;
            out.push((idx,if len==0{None}else{Some(value.to_vec())}));at=end;
        }
        Some(out)
    }
    impl Job {
        fn get(&self,name:&str)->&[u8]{self.fields[field(name)].as_deref().unwrap_or(NULL)}
        fn set(&mut self,name:&str,value:&[u8]){self.fields[field(name)]=Some(value.to_vec());}
        fn num(&self,name:&str)->u32{number(self.get(name))}
        fn truth(&self,name:&str)->bool{present(self.get(name))}
        fn confirmed(&self)->bool{self.truth("submittedUserTurnId")||[b"\"confirmed-submission\"".as_slice(),b"\"active-response\"",b"\"terminal-awaiting-bookkeeping\""].contains(&self.get("deliveryState"))}
        fn remaining(&self)->u32{(self.queue.len() as u32).saturating_add(self.truth("currentMessage") as u32)}
        fn total(&self)->u32{super::cpo_queue_total(self.num("totalMessages"),self.num("completedCount"),self.remaining())}
        fn reset(&mut self,mask:u32){
            if mask&1!=0{
                for n in ["retryAttemptCount","nextRetryDelayMs","nextRetryAt"]{self.set(n,ZERO);}
                for n in ["lastRetryableReason","retryClass","retryMode"]{self.set(n,EMPTY);}
                self.set("retryExhausted",FALSE);
            }
            if mask&2!=0{
                for n in ["waitStartedAt","lastResearchProgressAt"]{self.set(n,ZERO);}
                for n in ["sawDeepResearch","sawGenerating"]{self.set(n,FALSE);}
            }
            if mask&4!=0{
                for n in ["deliveryState","commandId","commandFingerprint","submissionAckSource","terminalAckSource","lastResponsePhase"]{self.set(n,EMPTY);}
                for n in ["submittedUserTurnId","assistantTurnId"]{self.set(n,NULL);}
            }
        }
        fn requeue(&mut self){
            if self.truth("currentMessage"){
                let current=self.fields[field("currentMessage")].take().unwrap();
                self.queue.push_front(current);
            }
            self.set("currentMessage",NULL);self.set("currentCommandNumber",ZERO);
        }
        fn snapshot(&self)->Vec<u8>{
            let mut out=vec![b'{'];
            fn emit(out:&mut Vec<u8>,key:&str,val:&[u8]){
                if out.len()>1{out.push(b',');}
                out.extend(quoted(key));out.push(b':');out.extend_from_slice(val);
            }
            // No current/pending prompt contents cross the snapshot boundary.
            for n in ["tabId","provider","conversationId","conversationType","targetKey","isRunning","isPaused","isStopped","pausedReason","lastError","runId","completedCount","currentCommandNumber","currentPhase","waitForIdleBeforeSend","deliveryTimeoutAttempts","retryAttemptCount","lastRetryableReason","retryClass","retryMode","nextRetryDelayMs","nextRetryAt","retryExhausted","waitStartedAt","lastResearchProgressAt","sawDeepResearch","sawGenerating","deliveryState","commandId","commandFingerprint","submittedUserTurnId","assistantTurnId","submissionAckSource","terminalAckSource","lastResponsePhase","rolloverInProgress","rolloverStage","rolloverReason","rolloverFromConversationId","rolloverToConversationId","rolloverNavigationStarted","rolloverRebindApplied","handoffSubmitted","handoffEstablished","handoffFingerprint","conversationGeneration","startedAt","updatedAt"]{
                let raw=self.get(n);
                let fallback=match n{
                    "provider"=>b"\"chatgpt\"".as_slice(),
                    "conversationType"=>if self.truth("conversationId"){b"\"existing\""}else{b"\"unknown\""},
                    "conversationId"|"submittedUserTurnId"|"assistantTurnId"|"rolloverFromConversationId"|"rolloverToConversationId"=>NULL,
                    "isRunning"|"isPaused"|"isStopped"|"waitForIdleBeforeSend"|"retryExhausted"|"sawDeepResearch"|"sawGenerating"|"rolloverInProgress"|"rolloverNavigationStarted"|"rolloverRebindApplied"|"handoffSubmitted"|"handoffEstablished"=>FALSE,
                    "tabId"|"completedCount"|"currentCommandNumber"|"deliveryTimeoutAttempts"|"retryAttemptCount"|"nextRetryDelayMs"|"nextRetryAt"|"waitStartedAt"|"lastResearchProgressAt"|"conversationGeneration"|"startedAt"|"updatedAt"=>ZERO,
                    _=>EMPTY
                };
                if n=="targetKey"&&!present(raw){
                    // Reconstruct the canonical key from already escaped JSON
                    // string fragments, preserving Unicode and lone surrogates.
                    let provider=self.get("provider");
                    let provider=if present(provider){provider}else{b"\"chatgpt\""};
                    let kind=self.get("conversationType");
                    let kind=if present(kind){kind}else{if self.truth("conversationId"){b"\"existing\""}else{b"\"unknown\""}};
                    let id=self.get("conversationId");
                    let body=|v:&[u8]|if v.first()==Some(&b'"')&&v.last()==Some(&b'"')&&v.len()>=2{Some(1..v.len()-1)}else{None};
                    let mut key=vec![b'"'];
                    if let Some(range)=body(provider){key.extend_from_slice(&provider[range]);}
                    key.push(b':');
                    if present(id){key.extend_from_slice(b"c:");if let Some(range)=body(id){key.extend_from_slice(&id[range]);}}
                    else if let Some(range)=body(kind){key.extend_from_slice(&kind[range]);}
                    key.push(b'"');emit(&mut out,n,&key);
                }else{emit(&mut out,n,if present(raw){raw}else{fallback});}
            }
            let status=if self.truth("isPaused"){"paused"}else if self.truth("isRunning"){"running"}else if self.truth("isStopped"){"stopped"}else{"idle"};
            emit(&mut out,"status",&quoted(status));
            for (name,value) in [("remaining",self.remaining() as usize),("pending",self.queue.len()),("totalMessages",self.total() as usize),("currentMessageLength",json_len(self.get("currentMessage"))),("nextMessageLength",self.queue.front().map_or(0,|v|json_len(v)))]{
                emit(&mut out,name,value.to_string().as_bytes());
            }
            emit(&mut out,"hasCurrentMessage",if self.truth("currentMessage"){TRUE}else{FALSE});
            out.push(b'}');out
        }
        fn new() -> Self {
            Self { fields: vec![None; super::DURABLE_FIELDS.len()+1], queue: VecDeque::new(), revision: 0, metadata: None }
        }
        fn dirty(&mut self, revision: u64) { self.revision = revision; self.metadata = None; }
    }
    #[derive(Default)]
    struct Store {
        jobs: BTreeMap<u32, Job>,
        next: u32,
        epoch: u64,
        input: Vec<u8>,
        output: Vec<u8>,
    }
    impl Store {
        fn advance(&mut self) -> u64 { self.epoch += 1; self.epoch }
        fn changed(&mut self, id: u32) {
            let revision = self.advance();
            self.jobs.get_mut(&id).unwrap().dirty(revision);
        }
        fn create(&mut self) -> u32 {
            let Some(id) = self.next.checked_add(1) else { return 0; };
            self.next = id;
            self.jobs.insert(id, Job::new());
            self.changed(id);
            id
        }
        fn mutate(&mut self, id: u32, field: u32, op: u32, index: u32) -> bool {
            let input = std::mem::take(&mut self.input);
            let Some(job) = self.jobs.get_mut(&id) else { return false; };
            let changed = match op {
                0 if field as usize != QUEUE && (field as usize) < job.fields.len() => {
                    let slot = &mut job.fields[field as usize];
                    let next = if input.is_empty() { None } else { Some(input) };
                    if *slot == next { return true; }
                    *slot = next;
                    // isProcessing is ephemeral; never invalidate durable snapshots.
                    (field as usize) < super::DURABLE_FIELDS.len()
                },
                1 if !input.is_empty() => { job.queue.push_back(input); true },
                2 if !input.is_empty() => { job.queue.push_front(input); true },
                3 if !input.is_empty() && index as usize <= job.queue.len() => {
                    job.queue.insert(index as usize, input); true
                },
                4 => { if job.queue.pop_front().is_none() { return false; } true },
                5 if !input.is_empty() => { job.metadata = Some((job.revision, input)); false },
                _ => return false,
            };
            if changed { self.changed(id); }
            true
        }

        // A complete transition validates its frame and preconditions before
        // changing the deque or fields, then advances the revision once.
        fn transaction(&mut self,id:u32,op:u32,arg:u32,now:f64)->bool{
            let input=std::mem::take(&mut self.input);
            let Some(job)=self.jobs.get_mut(&id) else{return false;};
            if !now.is_finite()||now<0.0{return false;}
            let time=now.to_string();
            let Some(fields)=patch(&input) else{return false;};
            let value=|name:&str|fields.iter().find(|(i,_)|*i==field(name)).and_then(|(_,v)|v.as_deref());
            match op{
                0=>{}, // generic atomic field patch
                1=>{if arg&!7!=0{return false;}job.reset(arg);},
                2=>{ // insert prompt, keeping paused next-insertion semantics
                    let Some(prompt)=value("currentMessage") else{return false;};
                    if !present(prompt)||prompt.first()!=Some(&b'"'){return false;}
                    let paused=job.truth("isPaused");
                    if !paused&&!job.truth("isRunning"){return false;}
                    if arg&1!=0||paused&&job.queue.is_empty(){job.queue.push_back(prompt.to_vec());}
                    else if paused{job.queue.insert(1,prompt.to_vec());}
                    else{job.queue.push_front(prompt.to_vec());}
                    // total is measured before insertion to avoid double counting.
                    let total=job.num("totalMessages").max(job.num("completedCount").saturating_add(job.remaining().saturating_sub(1))).saturating_add(1);
                    job.set("totalMessages",total.to_string().as_bytes());
                },
                3=>{ // completion bookkeeping
                    if !job.truth("currentMessage"){return false;}
                    let completed=job.num("completedCount").saturating_add(1);
                    job.set("completedCount",completed.to_string().as_bytes());
                    job.set("currentMessage",NULL);job.set("currentCommandNumber",ZERO);
                    job.set("currentPhase",b"\"queued\"");job.set("deliveryTimeoutAttempts",ZERO);job.reset(7);
                },
                4=>{ // pause: never requeue acknowledged submissions
                    let reason=value("pausedReason").unwrap_or(b"\"Queue paused because ChatGPT failed.\"");
                    if !job.confirmed(){if job.truth("currentMessage"){job.requeue();job.reset(4);}job.set("currentCommandNumber",ZERO);}
                    job.set("isRunning",FALSE);job.set("isPaused",TRUE);job.set("isStopped",FALSE);
                    job.set("pausedReason",reason);job.set("lastError",reason);job.set("currentPhase",b"\"paused\"");job.reset(2);
                },
                5=>{ // resume paused queue
                    if !job.truth("isPaused")||job.remaining()==0{return false;}
                    let confirmed=job.confirmed()&&job.truth("currentMessage");
                    job.set("isPaused",FALSE);job.set("isRunning",TRUE);job.set("isStopped",FALSE);
                    job.set("pausedReason",EMPTY);job.set("lastError",EMPTY);
                    job.set("currentPhase",if confirmed{b"\"awaiting-response\""}else{b"\"queued\""});job.reset(3);
                },
                6=>{ // retry settlement after delay, preserving confirmed sends
                    if !job.truth("isRunning")||job.truth("isPaused")||job.truth("isStopped"){return false;}
                    if job.truth("currentMessage")&&job.confirmed(){
                        job.set("currentPhase",b"\"awaiting-response\"");job.set("deliveryState",b"\"confirmed-submission\"");job.reset(2);
                    }else{job.requeue();job.set("currentPhase",b"\"queued\"");job.reset(4);}
                    job.set("nextRetryAt",ZERO);
                },
                7=>{ // claim next command; fingerprint supplied for exact peek
                    if !job.truth("isRunning")||job.truth("isPaused")||job.truth("isStopped")||job.truth("currentMessage"){return false;}
                    let Some(expected)=value("currentMessage") else{return false;};
                    if job.queue.front().map(Vec::as_slice)!=Some(expected)||value("commandFingerprint").is_none(){return false;}
                    let prompt=job.queue.pop_front().unwrap();
                    job.fields[field("currentMessage")]=Some(prompt);
                    let n=job.num("completedCount").saturating_add(1);
                    job.set("currentCommandNumber",n.to_string().as_bytes());
                    job.set("lastError",EMPTY);job.set("currentPhase",b"\"sending\"");job.reset(6);
                    job.set("deliveryState",b"\"pre-click\"");
                    if let Some(fp)=value("commandFingerprint"){job.set("commandFingerprint",fp);}
                    // run ID and number are generated by the host only for JSON
                    // string escaping; command numbering is owned here.
                    if let Some(cid)=value("commandId"){job.set("commandId",cid);}
                },
                8=>{ // arm retry atomically after asynchronous settings lookup
                    if !job.truth("isRunning")||job.truth("isPaused")||job.truth("isStopped")||!job.truth("currentMessage"){return false;}
                    let delay=arg.max(1);
                    let n=job.num("retryAttemptCount").saturating_add(1);
                    job.set("retryAttemptCount",n.to_string().as_bytes());job.set("retryExhausted",FALSE);
                    job.set("nextRetryDelayMs",delay.to_string().as_bytes());
                    job.set("nextRetryAt",(now+f64::from(delay)).to_string().as_bytes());job.set("currentPhase",b"\"retry-wait\"");job.reset(2);
                    for name in ["retryMode","lastError","retryClass","lastRetryableReason"]{if let Some(v)=value(name){job.set(name,v);}}
                },
                9=>{ // authorized rollover rebind, generation advances once
                    if !job.truth("rolloverInProgress"){return false;}
                    for name in ["provider","conversationId","conversationType","targetKey"]{if value(name).is_none(){return false;}}
                    let target_id=value("conversationId").unwrap();
                    let kind=match value("conversationType").unwrap(){b"\"existing\""=>1,b"\"new\""=>2,_=>0};
                    let flags=(value("provider")==Some(b"\"chatgpt\"".as_slice())) as u32
                        |((present(target_id) as u32)<<1)|(((target_id!=job.get("rolloverFromConversationId")) as u32)<<2)
                        |((job.truth("rolloverFromConversationId") as u32)<<3)|((job.truth("rolloverNavigationStarted") as u32)<<4);
                    if super::cpo_rollover_fresh(kind,flags)!=1{return false;}
                    for name in ["provider","conversationId","conversationType","targetKey"]{job.set(name,value(name).unwrap());}
                    let id=job.get("conversationId").to_vec();job.set("rolloverToConversationId",&id);
                    if !job.truth("rolloverRebindApplied"){let n=job.num("conversationGeneration").saturating_add(1);job.set("conversationGeneration",n.to_string().as_bytes());job.set("rolloverRebindApplied",TRUE);}
                    job.set("rolloverStage",b"\"identity-confirmed\"");
                },
                10=>{ // recovered unconfirmed command
                    if job.confirmed()||!job.truth("currentMessage"){return false;}
                    job.requeue();job.set("currentPhase",b"\"queued\"");
                },
                11=>{ // reconcile decoded checkpoint after publication
                    match arg{
                        1 if job.confirmed()=>{job.set("currentPhase",b"\"awaiting-response\"");if job.get("deliveryState")!=b"\"active-response\""{job.set("deliveryState",b"\"confirmed-submission\"");}},
                        2=>{job.set("currentPhase",b"\"terminal\"");job.set("deliveryState",b"\"terminal-awaiting-bookkeeping\"");},
                        3 if !job.confirmed()&&job.truth("currentMessage")=>{job.requeue();job.set("currentPhase",b"\"queued\"");job.reset(6);},
                        _=>return false
                    }
                },
                _=>return false
            }
            if op==0{for (i,v) in fields{job.fields[i]=v;}}
            if op!=1&&op!=11{job.set("updatedAt",time.as_bytes());}
            self.changed(id);true
        }
        fn read(&mut self, id: u32, field: u32, index: u32) -> u32 {
            self.output.clear();
            let Some(job) = self.jobs.get(&id) else { return 0; };
            if field == u32::MAX-1 { self.output=job.snapshot(); }
            else if field == METADATA {
                let Some((revision, bytes)) = &job.metadata else { return 0; };
                if *revision != job.revision { return 0; }
                self.output.extend_from_slice(bytes);
            } else if field as usize == QUEUE {
                if index == u32::MAX {
                    self.output.push(b'[');
                    for (i, item) in job.queue.iter().enumerate() {
                        if i != 0 { self.output.push(b','); }
                        self.output.extend_from_slice(item);
                    }
                    self.output.push(b']');
                } else {
                    let Some(bytes) = job.queue.get(index as usize) else { return 0; };
                    self.output.extend_from_slice(bytes);
                }
            } else {
                let Some(Some(bytes)) = job.fields.get(field as usize) else { return 0; };
                self.output.extend_from_slice(bytes);
            }
            u32::try_from(self.output.len()).ok().and_then(|n| n.checked_add(1)).unwrap_or(0)
        }
    }
    thread_local! { static STORE: RefCell<Store> = RefCell::new(Store::default()); }
    #[no_mangle]
    pub extern "C" fn cpo_live_new() -> u32 { STORE.with(|s| s.borrow_mut().create()) }
    #[no_mangle]
    pub extern "C" fn cpo_live_delete(id: u32) -> u32 {
        STORE.with(|s| {
            let mut s = s.borrow_mut();
            if s.jobs.remove(&id).is_none() { return 0; }
            s.advance(); 1
        })
    }
    #[no_mangle]
    pub extern "C" fn cpo_live_epoch() -> f64 { STORE.with(|s| s.borrow().epoch as f64) }
    #[no_mangle]
    pub extern "C" fn cpo_live_len(id: u32) -> u32 {
        STORE.with(|s| s.borrow().jobs.get(&id).map_or(0, |j| j.queue.len() as u32))
    }
    #[no_mangle]
    pub extern "C" fn cpo_live_input(len: u32) -> usize {
        if len as usize > MAX_INPUT { return 0; }
        STORE.with(|s| {
            let mut s = s.borrow_mut();
            s.input.resize(len as usize, 0);
            s.input.as_mut_ptr() as usize
        })
    }
    #[no_mangle]
    pub extern "C" fn cpo_live_write(id: u32, field: u32, op: u32, index: u32) -> u32 {
        STORE.with(|s| s.borrow_mut().mutate(id,field,op,index) as u32)
    }
    #[no_mangle]
    pub extern "C" fn cpo_live_transaction(id:u32,op:u32,arg:u32,now:f64)->u32{
        STORE.with(|s|s.borrow_mut().transaction(id,op,arg,now) as u32)
    }
    #[no_mangle]
    pub extern "C" fn cpo_live_read(id: u32, field: u32, index: u32) -> u32 {
        STORE.with(|s| s.borrow_mut().read(id,field,index))
    }
    #[no_mangle]
    pub extern "C" fn cpo_live_output() -> usize {
        STORE.with(|s| s.borrow().output.as_ptr() as usize)
    }
    #[no_mangle]
    pub extern "C" fn cpo_live_wipe() {
        STORE.with(|s| {
            let mut s = s.borrow_mut();
            s.output.fill(0);
            s.output.clear();
        })
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn deque_order_and_checkpoint_invalidation() {
            let mut s = Store::default();
            let id = s.create();
            for (op, index, value) in [(1,0,b"\"b\"".as_slice()),(2,0,b"\"a\""),(3,1,b"\"next\"")] {
                s.input = value.to_vec();
                assert!(s.mutate(id,QUEUE as u32,op,index));
            }
            s.read(id,QUEUE as u32,u32::MAX);
            assert_eq!(s.output,b"[\"a\",\"next\",\"b\"]");
            s.input = b"{}".to_vec();
            assert!(s.mutate(id,0,5,0));
            let epoch = s.epoch;
            s.input = b"true".to_vec();
            assert!(s.mutate(id,super::super::DURABLE_FIELDS.len() as u32,0,0));
            assert_eq!(s.epoch,epoch);
            assert_ne!(s.read(id,METADATA,0),0);
            assert!(s.mutate(id,QUEUE as u32,4,0));
            assert_eq!(s.read(id,METADATA,0),0);
            s.read(id,QUEUE as u32,u32::MAX);
            assert_eq!(s.output,b"[\"next\",\"b\"]");
        }
    }
}

// Canonical ordered provider selector and compatibility catalogs.
const CATALOG_1: &[(&str, &[&str])] = &[
    ("composer", &["#prompt-textarea", "[data-testid=\"prompt-textarea\"]", "textarea", "[contenteditable=\"true\"][role=\"textbox\"]", "div[contenteditable=\"true\"]", "[contenteditable=\"true\"]"]),
    ("sendButton", &["button[data-testid=\"send-button\"]", "button[data-testid=\"fruitjuice-send-button\"]", "button[aria-label=\"Send prompt\"]", "button[aria-label=\"Send message\"]", "button[type=\"submit\"]"]),
    ("stopButton", &["button[data-testid=\"stop-button\"]", "button[data-testid*=\"stop\"]", "button[aria-label*=\"stop\"]", "button[aria-label*=\"Stop\"]"]),
    ("streaming", &[".result-streaming", "[data-testid*=\"conversation-turn\"] .result-streaming", "[data-message-streaming=\"true\"]", "[data-is-streaming=\"true\"]", "[data-testid*=\"streaming\"]"]),
    ("status", &["[role=\"status\"]", "[aria-live]", "[data-testid*=\"status\"]", "[data-testid*=\"progress\"]", "[data-testid*=\"research\"]", "[data-testid*=\"thinking\"]", "[data-testid*=\"reasoning\"]", "[data-testid*=\"thought\"]", "[data-testid*=\"tool-progress\"]", ".result-thinking"]),
    ("spinner", &["svg.animate-spin", "[class*=\"animate-spin\"]", "[data-testid*=\"loading-spinner\"]"]),
    ("errorAlerts", &["[role=\"alert\"]", "[data-testid*=\"error\"]", ".text-red-500", ".border-red-500", ".text-token-text-error", "[class*=\"error-message\"]"]),
    ("messages", &["[data-testid^=\"conversation-turn\"]", "[data-testid*=\"conversation-turn\"]", "article", "[data-message-author-role]", "[data-message-id]", "[data-testid=\"conversation-turn\"]"]),
    ("fallbackMessages", &["main article", "main [data-message-author-role]", "main [data-message-id]", "main div[class*=\"group\"]", "[role=\"main\"] article", "[role=\"main\"] [data-message-author-role]", "[role=\"main\"] div[class*=\"group\"]"]),
    ("mainRoot", &["main", "[role=\"main\"]", "#__next", "body"]),
];
const CATALOG_2: &[(&str, &[&str])] = &[
    ("composer", &[".ql-editor[contenteditable=\"true\"]", "rich-textarea .ql-editor", ".ql-editor", "[contenteditable=\"true\"][role=\"textbox\"]", "div[contenteditable=\"true\"]"]),
    ("sendButton", &["button.send-button[aria-label=\"Send message\"]", "button.send-button", "button[aria-label=\"Send message\"]", "button[aria-label*=\"Send\"]"]),
    ("stopButton", &["button[aria-label=\"Stop response\"]", "button[aria-label*=\"Stop\"]", "button.stop-button", "button[data-test-id*=\"stop\"]"]),
    ("streaming", &["[class*=\"response-streaming\"]", "[data-is-streaming=\"true\"]", ".model-response-text[aria-busy=\"true\"]"]),
    ("status", &["[role=\"status\"]", "[aria-live]", "[class*=\"thinking\"]", "[class*=\"loading\"]", "[data-test-id*=\"loading\"]", "[data-test-id*=\"progress\"]"]),
    ("spinner", &["[class*=\"loading\"]", "[class*=\"spinner\"]", "mat-progress-spinner", "circular-progress"]),
    ("errorAlerts", &["[role=\"alert\"]", "[matsnackbarlabel]", ".mat-mdc-snack-bar-label", ".mdc-snackbar__label", "[class*=\"error\"]"]),
    ("messages", &[]),
    ("fallbackMessages", &[]),
    ("mainRoot", &["main", "[role=\"main\"]", "chat-window", "body"]),
];
const CATALOG_3: &[(&str, &[&str])] = &[
    ("composer", &["[data-testid=\"chat-input\"]", "div.ProseMirror[contenteditable=\"true\"]", "div.ProseMirror", "[contenteditable=\"true\"][role=\"textbox\"]", "div[contenteditable=\"true\"]", "fieldset textarea", "textarea"]),
    ("sendButton", &["button[aria-label=\"Send Message\"]", "button[aria-label=\"Send message\"]", "button[data-testid=\"send-button\"]", "button[aria-label*=\"Send\"]", "button[type=\"submit\"]"]),
    ("stopButton", &["button[aria-label=\"Stop generating\"]", "button[aria-label*=\"Stop\"]", "button[aria-label*=\"stop\"]", "button[data-testid*=\"stop\"]"]),
    ("streaming", &["[data-is-streaming=\"true\"]", "[data-is-streaming]", ".font-claude-response[data-is-streaming]"]),
    ("status", &["[role=\"status\"]", "[aria-live]", "[class*=\"thinking\"]", "[class*=\"loading\"]", "[data-testid*=\"thinking\"]", "[data-testid*=\"progress\"]", "[data-testid*=\"status\"]"]),
    ("spinner", &["[class*=\"loading\"]", "[class*=\"spinner\"]", "[class*=\"animate-spin\"]", "svg.animate-spin"]),
    ("errorAlerts", &["[role=\"alert\"]", "[data-testid*=\"error\"]", "[class*=\"error\"]"]),
    ("messages", &[]),
    ("fallbackMessages", &[]),
    ("mainRoot", &["main", "[role=\"main\"]", "body"]),
];
const CATALOG_4: &[(&str, &[&str])] = &[
    ("composerContext", &["[data-testid*=\"composer\"]", "[data-testid*=\"prompt\"]", "[id*=\"prompt\"]", "form"]),
    ("messageContext", &["[data-testid^=\"conversation-turn\"]", "[data-testid*=\"conversation-turn\"]", "article", "[data-message-author-role]", "[data-message-id]"]),
    ("turnContext", &["[data-testid^=\"conversation-turn\"]", "[data-testid*=\"conversation-turn\"]", "article"]),
    ("assistantContentSelectors", &[".markdown", "[data-testid*=\"copy\"]", "[aria-label*=\"Copy\"]"]),
    ("weakComposerSelectors", &["textarea", "[contenteditable=\"true\"][role=\"textbox\"]", "div[contenteditable=\"true\"]", "[contenteditable=\"true\"]"]),
    ("weakSendButtonSelectors", &["button[type=\"submit\"]"]),
    ("stopLabels", &["stop generating", "stop streaming", "stop response", "interrupt", "stop"]),
    ("retryLabels", &["retry", "try again", "regenerate", "regenerate response"]),
    ("researchMarkers", &["deep research", "researching", "searching the web", "searching sources", "reading sources", "analyzing sources", "gathering sources", "checking sources", "synthesizing", "creating report", "writing report", "thinking", "working"]),
    ("deliveryTimeoutMarkers", &["message delivery timed out", "delivery timed out", "message delivery timeout", "delivery timeout", "timed out. please try again"]),
    ("errorMarkers", &["something went wrong", "there was an error", "error generating a response", "network error", "failed to generate", "try again later"]),
    ("waitingForUserMarkers", &["waiting for you", "waiting for your response", "waiting for your reply", "need more information from you", "reply when you are ready"]),
    ("interruptedMarkers", &["stopped generating", "response interrupted", "generation stopped", "you stopped this response"]),
    ("conversationCapacityMarkers", &["you've reached the maximum length for this conversation", "maximum length for this conversation", "keep talking by starting a new chat"]),
];

fn catalog(id:u32)-> &'static [(&'static str, &'static [&'static str])] {
    match id {1=>CATALOG_1,2=>CATALOG_2,3=>CATALOG_3,4=>CATALOG_4,_=>&[]}
}
#[no_mangle]
pub extern "C" fn cpo_catalog_len(id:u32)->u32 {catalog(id).len() as u32}
#[no_mangle]
pub extern "C" fn cpo_catalog_items(id:u32,group:u32)->u32 {
    catalog(id).get(group as usize).map_or(0,|(_,items)|items.len() as u32)
}
#[no_mangle]
pub extern "C" fn cpo_catalog_word(id:u32,group:u32,item:u32,offset:u32)->u32 {
    let Some((name,items))=catalog(id).get(group as usize) else{return 0;};
    let text=if item==u32::MAX {*name} else {match items.get(item as usize){Some(s)=>*s,None=>return 0}};
    text.as_bytes().iter().skip(offset as usize).take(4).enumerate().fold(0,|n,(i,b)|n|(u32::from(*b)<<(i*8)))
}
// Enter=1; shift/alt/ctrl/meta/composing/IME=2..64.
#[no_mangle]
pub extern "C" fn cpo_enter_eligible(flags:u32)->u32 {(flags&127==1) as u32}
#[no_mangle]
pub extern "C" fn cpo_enter_action(flags:u32,elapsed:f64)->u32 {
    if flags&1==0 {0} else if flags&2!=0 {1}
    else if flags&4!=0 && elapsed<1200.0 {2} else {3}
}
// Raw facts: textarea=1, contenteditable=2, clickable=4, editor
// class=8, Claude chat-input=16, excluded message ancestor=32.
#[no_mangle]
pub extern "C" fn cpo_provider_predicate(provider:u32,mode:u32,flags:u32)->u32 {
    if !(1..=3).contains(&provider){return 0;}
    match mode {
        0=>(flags&3!=0) as u32, 1=>(flags&4!=0) as u32,
        2=>((flags&32==0) && match provider{2=>flags&11!=0,3=>flags&27!=0,_=>flags&3!=0}) as u32,
        _=>0
    }
}
// Native recursive traversal policy. Action in low byte, bound above it.
// Host never visits children of redacted or truncated nodes.
#[no_mangle]
pub extern "C" fn cpo_log_plan(kind:u32,depth:u32,len:u32,flags:u32)->u32 {
    let length=len.min(0x00ff_ffff);
    if kind==0{return 0;}
    if flags&1!=0{return if flags&2!=0 {8} else if kind==1||kind==3 {6|(length<<8)} else {7};}
    match kind {
        1=>1|(cpo_log_limit(0,depth,length)<<8), 2=>0,
        3=>if depth>=2 {4} else {2|(length.min(12)<<8)},
        4=>if depth>=3 {5} else {3|(length.min(30)<<8)},
        5=>9, _=>10
    }
}
#[no_mangle]
pub extern "C" fn cpo_diag_pick(mask:u32)->u32 {if mask==0 {0} else {mask.trailing_zeros()+1}}
#[cfg(target_arch="wasm32")]
mod diagnostic_text {
    use std::cell::RefCell;
    struct State { units:Vec<u16>, pending:bool, limit:usize, overflow:bool }
    thread_local! {static STATE:RefCell<State>=RefCell::new(State{units:Vec::new(),pending:false,limit:0,overflow:false});}
    #[no_mangle]
    pub extern "C" fn cpo_diag_reset(limit:u32)->u32 {
        STATE.with(|s|{let mut s=s.borrow_mut();s.units.fill(0);s.units.clear();s.units.reserve(1024);s.pending=false;s.overflow=false;s.limit=limit.min(1024) as usize;});
        1
    }
    #[no_mangle]
    pub extern "C" fn cpo_diag_update(len:u32)->u32 {
        if len as usize>super::CHUNK{return 2;}
        let input=unsafe{core::slice::from_raw_parts(super::cpo_fingerprint_buffer() as *const u16,len as usize)};
        STATE.with(|s|{
            let mut s=s.borrow_mut();
            for &ch in input{
                if super::whitespace(ch){if !s.units.is_empty(){s.pending=true;}continue;}
                if s.pending {s.pending=false;if s.units.len()<s.limit{s.units.push(32);}else{s.overflow=true;break;}}
                if s.units.len()<s.limit{s.units.push(ch);}else{s.overflow=true;break;}
            }
            s.overflow as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn cpo_diag_finish()->u32{
        STATE.with(|s|{
            let mut s=s.borrow_mut();
            if s.overflow&&s.limit>0 {let keep=s.limit.saturating_sub(1).max(1);s.units.truncate(keep);s.units.push(0x2026);}
            let count=s.units.len().min(super::CHUNK);
            unsafe{core::ptr::copy_nonoverlapping(s.units.as_ptr(),super::cpo_fingerprint_buffer() as *mut u16,count);}
            s.units.fill(0);s.units.clear();s.pending=false;s.overflow=false;
            count as u32
        })
    }
}

 // Native traversal cursor: the host cannot exceed the Rust depth or child
 // bounds. Only the currently visited browser values live on the host stack.
mod diagnostic_walk {
    use std::cell::RefCell;
    #[derive(Default)]
    struct Walk { base:u32, depth:usize, frames:[(u32,u32);4] }
    thread_local! {static WALK:RefCell<Walk>=RefCell::new(Walk::default());}
    #[no_mangle]
    pub extern "C" fn cpo_log_walk_begin(depth:u32)->u32 {
        WALK.with(|w|*w.borrow_mut()=Walk{base:depth,..Walk::default()});1
    }
    #[no_mangle]
    pub extern "C" fn cpo_log_walk_plan(kind:u32,len:u32,flags:u32)->u32 {
        WALK.with(|w|{
            let mut w=w.borrow_mut();
            let plan=super::cpo_log_plan(kind,w.base.saturating_add(w.depth as u32),len,flags);
            if matches!(plan&255,2|3){
                let index=w.depth;
                if index>=w.frames.len(){return u32::MAX;}
                w.frames[index]=(0,plan>>8);w.depth+=1;
            }
            plan
        })
    }
    #[no_mangle]
    pub extern "C" fn cpo_log_walk_next()->u32 {
        WALK.with(|w|{
            let mut w=w.borrow_mut();
            if w.depth==0{return 0;}
            let index=w.depth-1;
            let frame=&mut w.frames[index];
            if frame.0>=frame.1{return 0;}
            frame.0+=1;frame.0
        })
    }
    #[no_mangle]
    pub extern "C" fn cpo_log_walk_close()->u32 {
        WALK.with(|w|{
            let mut w=w.borrow_mut();
            if w.depth==0{return 0;}
            w.depth-=1;1
        })
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn native_walk_limits_and_depth(){
            cpo_log_walk_begin(0);
            assert_eq!(cpo_log_walk_plan(3,100,0),2|(12<<8));
            assert_eq!(cpo_log_walk_next(),1);
            assert_eq!(cpo_log_walk_plan(4,100,0),3|(30<<8));
            assert_eq!(cpo_log_walk_next(),1);
            assert_eq!(cpo_log_walk_plan(3,100,0),4);
            assert_eq!(cpo_log_walk_close(),1);
            for i in 2..=12{assert_eq!(cpo_log_walk_next(),i);}
            assert_eq!(cpo_log_walk_next(),0);
            assert_eq!(cpo_log_walk_close(),1);
        }
    }
}

 // Batched UTF-16 messages retain browser string semantics, including
 // isolated surrogates. The host only marshals flat fields and object indices.
mod presentation_batch {
    use std::{cell::RefCell, collections::BTreeSet};
    const MAX_UNITS: usize=32*1024*1024;
    #[derive(Default)]
    struct Buffer { input:Vec<u16>, output:Vec<u16> }
    thread_local!{static BUFFER:RefCell<Buffer>=RefCell::new(Buffer::default());}
    fn put(out:&mut Vec<u16>,value:&[u16]){
        let n=value.len() as u32;out.push(n as u16);out.push((n>>16) as u16);out.extend_from_slice(value);
    }
    fn fields(input:&[u16])->Option<Vec<&[u16]>>{
        let mut pos=0;let mut out=Vec::new();
        while pos<input.len(){
            let lo=*input.get(pos)? as usize;let hi=*input.get(pos+1)? as usize;pos+=2;
            let end=pos.checked_add(lo|(hi<<16))?;out.push(input.get(pos..end)?);pos=end;
        }
        Some(out)
    }
    fn ascii(s:&str)->Vec<u16>{s.encode_utf16().collect()}
    fn append(out:&mut Vec<u16>,s:&str){out.extend(s.encode_utf16());}
    fn eq(s:&[u16],v:&str)->bool{s.iter().copied().eq(v.encode_utf16())}
    fn number(s:&[u16])->f64 {String::from_utf16_lossy(s).parse::<f64>().unwrap_or(f64::NAN)}
    fn normalize(s:&[u16])->Vec<u16>{
        let mut out=Vec::with_capacity(s.len());let mut space=false;
        for &ch in s {
            if super::whitespace(ch){space=!out.is_empty();continue;}
            if space{out.push(32);space=false;}
            out.push(ch);
        }
        out
    }
    fn trim(s:&[u16])->&[u16]{
        let start=s.iter().position(|&x|!super::whitespace(x)).unwrap_or(s.len());
        let end=s.iter().rposition(|&x|!super::whitespace(x)).map_or(start,|i|i+1);&s[start..end]
    }
    fn lower_ascii(s:&[u16])->Vec<u16>{s.iter().map(|&c|if (65..=90).contains(&c){c+32}else{c}).collect()}
    fn starts_ignore_case(s:&[u16],word:&str)->bool{
        s.get(..word.len()).map_or(false,|x|lower_ascii(x)==ascii(word))
    }
    fn clean_title(mut s:&[u16])->Vec<u16>{
        for word in ["chatgpt","gemini","claude"]{
            if starts_ignore_case(s,word){
                let rest=&s[word.len()..];let n=rest.iter().take_while(|&&c|super::whitespace(c)).count();
                if matches!(rest.get(n),Some(45|0x2013)){
                    let rest=&rest[n+1..];let n=rest.iter().take_while(|&&c|super::whitespace(c)).count();s=&rest[n..];
                }
            }
            if s.len()>=word.len()&&starts_ignore_case(&s[s.len()-word.len()..],word){
                let rest=&s[..s.len()-word.len()];let end=rest.iter().rposition(|&c|!super::whitespace(c));
                if let Some(i)=end{if matches!(rest[i],45|0x2013){let prefix=&rest[..i];let end=prefix.iter().rposition(|&c|!super::whitespace(c)).map_or(0,|n|n+1);s=&prefix[..end];}}
            }
        }
        let s=trim(s);if s.is_empty(){ascii("Supported tab")}else{s.to_vec()}
    }
    fn format_identity(f:&[&[u16]])->Option<Vec<u16>>{
        if f.len()!=4{return None;}if !f[3].is_empty(){return Some(f[3].to_vec());}
        let mut out=f[0].to_vec();append(&mut out,":");
        if !f[2].is_empty(){append(&mut out,"c:");out.extend_from_slice(f[2]);}else{out.extend_from_slice(f[1]);}
        Some(out)
    }
    fn handoff(f:&[&[u16]])->Option<Vec<u16>>{
        if f.len()!=6{return None;}
        let mut run=normalize(f[0]);run.truncate(80);
        let mut out=ascii("Continuation handoff for an automated ChatGPT Queue Optimizer run. The previous conversation reached ChatGPT maximum length. Logical run id: ");
        if run.is_empty(){append(&mut out,"unknown");}else{out.extend(run);}
        for (label,value) in [(". Conversation segment: ",f[1]),(". Completed original commands: ",f[2]),(". Current original command number: ",f[3]),(". Remaining original commands after this one: ",f[4])]{append(&mut out,label);out.extend_from_slice(value);}
        append(&mut out,". ");
        if number(f[5])>0.0{append(&mut out,"The next original queued command is pending (length ");out.extend_from_slice(f[5]);append(&mut out,") and must be treated as the next user task.");}
        else{append(&mut out,"Resume the remaining original queued commands in order.");}
        append(&mut out," Do not treat this handoff as one of the original queued commands. Preserve prior workflow constraints and continue in FIFO order.");
        out.truncate(1200);Some(out)
    }
    fn scheduled_status(s:&[u16])->&'static str{
        let lower=lower_ascii(trim(s));
        for (key,label) in [("pending","Pending"),("firing","Sending"),("completed","Completed"),("failed","Failed"),("cancelled","Cancelled")]{
            if eq(&lower,key){return label;}
        }
        "Unknown"
    }
    fn popup_status(f:&[&[u16]])->Option<Vec<u16>>{
        if f.len()!=3{return None;}
        let status=lower_ascii(trim(f[0]));let phase=lower_ascii(trim(f[1]));let flags=number(f[2]) as u32;
        let either=|values:&[&str]|values.iter().any(|v|eq(&status,v)||eq(&phase,v));
        let phase_is=|values:&[&str]|values.iter().any(|v|eq(&phase,v));
        let mask=(either(&["complete","completed","done","finished"]) as u32)
            |((either(&["failed","error"]) as u32)<<1)
            |((((flags&1!=0)||eq(&status,"paused")) as u32)<<2)
            |((either(&["retrying","retry-wait","retry_wait"]) as u32)<<3)
            |((((flags&2!=0)||phase_is(&["rollover-in-progress","rollover","conversation-rollover"])) as u32)<<4)
            |((((flags&4!=0)||phase_is(&["waiting-for-idle","wait-for-idle","waiting_idle"])) as u32)<<5)
            |((phase_is(&["waiting","wait"]) as u32)<<6)|((phase_is(&["sending","send"]) as u32)<<7)
            |((eq(&phase,"queued") as u32)<<8)|((eq(&status,"stopped") as u32)<<9);
        let labels=["Complete","Failed","Paused","Retrying","New conversation","Waiting for idle","Waiting","Sending","Queued","Stopped","Running"];
        Some(ascii(labels[super::cpo_popup_status(mask) as usize]))
    }
    fn running_label(f:&[&[u16]])->Option<Vec<u16>>{
        if f.len()!=8{return None;}let mut out=f[0].to_vec();
        append(&mut out," | ");out.extend_from_slice(f[1]);
        if number(f[3])>0.0{append(&mut out," | Done: ");out.extend_from_slice(f[2]);append(&mut out,"/");out.extend_from_slice(f[3]);
            if number(f[4])>0.0{append(&mut out," | Command: ");out.extend_from_slice(f[4]);append(&mut out,"/");out.extend_from_slice(f[3]);}}
        append(&mut out," | Remaining: ");out.extend_from_slice(f[5]);
        if number(f[6])>0.0{append(&mut out," | Next length: ");out.extend_from_slice(f[6]);}
        if !f[7].is_empty(){append(&mut out," | Error: ");out.extend_from_slice(f[7]);}
        Some(out)
    }
    fn scheduled_label(f:&[&[u16]])->Option<Vec<u16>>{
        if f.len()!=5{return None;}let mut out=f[0].to_vec();
        append(&mut out," | ");append(&mut out,scheduled_status(f[1]));append(&mut out," | ");out.extend_from_slice(f[2]);
        append(&mut out," | ");out.extend(normalize(f[3]));if !f[4].is_empty(){append(&mut out," | ");out.extend_from_slice(f[4]);}Some(out)
    }
    // Native statistics templates. The host supplies exact ECMAScript string
    // values and locale-dependent numbers; all line assembly happens here.
    fn stats(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
        if f.len()!=12&&f.len()!=30{return None;}
        let mut result=Vec::new();
        let patterns=["Target: ","Total messages: ","Optimizer engine: ","Browser execution engine: ","Hidden: ","Visible: ","Container: ","Initialized: ","DOM scans: ","Last scan: ","Last window: ","Streaming mutation batches skipped: "];
        for (i,label) in patterns.iter().enumerate(){let mut line=ascii(label);line.extend_from_slice(f[i]);if i==9||i==10{append(&mut line," ms");}result.push(line);}
        if f.len()==30{
            result.push(ascii("Resource sample (recent turns only):"));
            let specs:&[&[(&str,usize)]]=&[
                &[("Sampled: ",12),("/",13),("; capped turns: ",14)],
                &[("Sampled DOM nodes: ",15),("; text characters: ",16)],
                &[("Images: ",17),("; audio/video: ",18),("; canvas/frames: ",19)],
                &[("Resource units (estimate): ",20)],
                &[("Adaptive budget: ",21)],
                &[("Manual history expansion: ",22)],
                &[("Extension cached message references: ",23)],
                &[("Image eviction actions: ",24)],
                &[("Paused playback eviction actions: ",25)],
                &[("Source restoration actions: ",26)],
                &[("Estimated image surface bytes targeted (cumulative): ",27)],
                &[("WASM linear memory: ",28)],
                &[("Browser JS heap (not tab RAM): ",29)],
            ];
            for spec in specs{let mut line=Vec::new();for &(label,index) in *spec{append(&mut line,label);line.extend_from_slice(f[index]);}result.push(line);}
        }
        Some(result)
    }

    fn valid_sequence_name(name:&[u16])->bool{
        !name.is_empty() && !["__proto__","constructor","prototype","__edit_selected_sequence__"].iter().any(|v|eq(name,v))
    }
    fn unique_sequence_name(f:&[&[u16]])->Option<Vec<u16>>{
        let (base,existing)=f.split_first()?;
        let base=trim(base);
        let base=if base.is_empty(){ascii("Imported sequence")}else{base.to_vec()};
        let names:BTreeSet<&[u16]>=existing.iter().copied().collect();
        if valid_sequence_name(&base)&&!names.contains(base.as_slice()){return Some(base);}
        // Each collision consumes a distinct existing name, so this is
        // bounded by the number of saved names, even for hostile imports.
        for n in 2..=names.len().saturating_add(3){
            let mut candidate=base.clone();append(&mut candidate," ");append(&mut candidate,&n.to_string());
            if valid_sequence_name(&candidate)&&!names.contains(candidate.as_slice()){return Some(candidate);}
        }
        None
    }
    fn collect_variables(f:&[&[u16]])->Vec<Vec<u16>>{
        let mut seen=BTreeSet::new();let mut result=Vec::new();
        for &text in f{
            let mut pos=0;let mut opened=None;
            while pos<text.len(){
                let ch=text[pos];let next=text.get(pos+1).copied().unwrap_or(0);
                if matches!(ch,10|13|0x2028|0x2029){opened=None;pos+=1;continue;}
                if let Some(start)=opened{
                    if ch==125&&next==125{
                        let name=trim(&text[start..pos]);
                        if !name.is_empty()&&seen.insert(name){result.push(name.to_vec());}
                        opened=None;pos+=2;continue;
                    }
                }else if ch==123&&next==123{opened=Some(pos+2);pos+=2;continue;}
                pos+=1;
            }
        }
        result
    }
    fn valid_local_date(y:u32,m:u32,d:u32,h:u32,min:u32)->bool{
        if !(100..=9999).contains(&y)||!(1..=12).contains(&m)||h>23||min>59{return false;}
        let leap=y%4==0&&(y%100!=0||y%400==0);
        let days=match m{2=>if leap{29}else{28},4|6|9|11=>30,_=>31};
        d>=1&&d<=days
    }
    fn parse_local_date(text:&[u16])->Option<Vec<Vec<u16>>>{
        let s=trim(text);
        if s.len()!=16||s[4]!=45||s[7]!=45||s[10]!=84||s[13]!=58{return None;}
        let mut values=[0u32;5];
        for (i,(start,end)) in [(0,4),(5,7),(8,10),(11,13),(14,16)].into_iter().enumerate(){
            for &c in &s[start..end]{if !(48..=57).contains(&c){return None;}values[i]=values[i]*10+u32::from(c-48);}
        }
        if !valid_local_date(values[0],values[1],values[2],values[3],values[4]){return None;}
        Some(values.iter().map(|v|ascii(&v.to_string())).collect())
    }
    fn format_local_date(f:&[&[u16]])->Option<String>{
        if f.len()!=5{return None;}
        let mut v=[0i64;5];
        for (i,s) in f.iter().enumerate(){v[i]=String::from_utf16_lossy(s).parse().ok()?;}
        // Match the existing browser formatter, including years outside the
        // input parser's accepted four-digit range.
        Some(format!("{}-{:02}-{:02}T{:02}:{:02}",v[0],v[1],v[2],v[3],v[4]))
    }

    fn failure_class(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
        if f.len()!=4{return None;}
        let flags=number(f[3]) as u32;let text=lower_ascii(f[1]);
        let contains=|s:&str|{let needle=ascii(s);text.windows(needle.len()).any(|v|v==needle.as_slice())};
        let mut class=if !f[2].is_empty(){f[2].to_vec()}else{ascii(
            if flags&1!=0||contains("conversation-max-length")||contains("maximum length for this conversation"){"conversation-max-length"}
            else if flags&2!=0||contains("queue was stopped"){"user-stop"}
            else if flags&4!=0||contains("compatibility failure"){"compatibility"}
            else if flags&8!=0||contains("stalled deep research"){"stalled-research"}
            else if flags&16!=0{"retry-visible"}
            else if flags&32!=0||contains("delivery time"){"timeout"}
            else if flags&64!=0||contains("waiting for the user"){"waiting-for-user"}
            else if flags&128!=0||contains("response was interrupted"){"interrupted"}
            else if contains("not acknowledged as a new user turn"){"submission-unconfirmed"}
            else if flags&256!=0||contains("chatgpt showed an error")||contains("error or retry state"){"generation-error"}
            else if contains("timed out waiting"){"timeout"}
            else if contains("could not read")||contains("could not inspect")||contains("could not send"){"transient"}
            else if contains("queue was paused"){"non-retryable"}
            else if eq(f[0],"send")||eq(f[0],"wait"){"transient"}else{"non-retryable"})};
        if flags&16!=0&&(eq(&class,"generation-error")||eq(&class,"retry-visible")){class=ascii("retry-visible");}
        let retry=["transient","generation-error","retry-visible","timeout","stalled-research","submission-unconfirmed"].iter().any(|v|eq(&class,v));
        Some(vec![class,ascii(if retry{"1"}else{"0"})])
    }
    // Native state transition returns only the authorized field mutation.
    // Browser storage keeps the record and lock; no prompt text is transferred.
    fn scheduled_patch(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
        if f.len()!=6{return None;}
        let op=number(f[0]) as u32;let state=number(f[1]) as u32;
        let due=number(f[2]);let now=number(f[3]);let next=number(f[4]);
        if !now.is_finite()||now<=0.0{return None;}
        let (status,reason)=match op{
            1 if super::cpo_schedule_action(1,state,due,now)==1=>("cancelled",Vec::new()),
            3 if super::cpo_schedule_action(3,state,due,now)==1&&super::cpo_timestamp_valid(next)==1=>("pending",Vec::new()),
            4 if super::cpo_schedule_action(4,state,due,now)==1=>("firing",Vec::new()),
            5 if state==2=>("failed",ascii("Delivery interrupted by background restart. Retry only if the message is not already queued.")),
            6 if state==2=>("failed",if f[5].is_empty(){ascii("Scheduled delivery failed.")}else{f[5].to_vec()}),
            7 if state==2=>("completed",Vec::new()),
            _=>return None
        };
        Some(vec![ascii(status),reason,f[3].to_vec(),if op==3{f[4].to_vec()}else{Vec::new()},if op==4||op==7{f[3].to_vec()}else{Vec::new()}])
    }

    fn catalog_signal(key:&str)->&'static [&'static str]{
        super::CATALOG_4.iter().find(|(name,_)|*name==key).map_or(&[],|(_,values)|*values)
    }
    fn contains_units(hay:&[u16],needle:&[u16])->bool{
        !needle.is_empty()&&hay.windows(needle.len()).any(|v|v==needle)
    }
    fn marker_present(text:&[u16],key:&str)->bool{
        let text=lower_ascii(text);
        catalog_signal(key).iter().any(|marker|contains_units(&text,&ascii(marker)))
    }
    fn assistant_error_prefix(f:&[&[u16]])->Option<Vec<u16>>{
        if f.len()!=1{return None;}
        let text=lower_ascii(f[0]);
        for marker in catalog_signal("errorMarkers"){
            let m=ascii(marker);
            if text.starts_with(&m)&&(text.len()==m.len()||matches!(text.get(m.len()),Some(32|46|33|63))){return Some(m);}
        }
        Some(Vec::new())
    }
    // Per-turn metadata only. Host supplies DOM attributes and exact normalized
    // text equality; Rust owns ordering, IDs, association, completion and match
    // precedence. Prompt bodies never enter the aggregation buffer.
    // input: expected fingerprint, exact-text-present, repeated role/ID/testID/
    // fingerprint/flags/error. output: latest user, latest assistant, matched,
    // followed by fixed-width rows (role,index,id,following,fp,flags,error).
    fn turn_snapshot(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
        if f.len()<2||(f.len()-2)%6!=0{return None;}
        let expected=f[0];let exact_required=eq(f[1],"1");
        let mut latest_user=Vec::new();let mut latest_assistant=Vec::new();let mut matched=Vec::new();
        let mut rows:Vec<Vec<u16>>=Vec::new();
        let mut first_fingerprint=None;
        for (index,v) in f[2..].chunks_exact(6).enumerate(){
            let role=number(v[0]) as u32;let flags=number(v[4]) as u32;
            let exact=flags&1!=0;
            if role!=1&&role!=2&&!(role==0&&exact){continue;}
            let mut id=if !v[1].is_empty(){v[1].to_vec()}else{v[2].to_vec()};
            if id.is_empty(){
                id=ascii(&format!("turn:{index}:{}:",if role==1{"user"}else if role==2{"assistant"}else{"unknown"}));
                if v[3].is_empty(){append(&mut id,"0");}else{id.extend_from_slice(v[3]);}
            }
            let user=role!=2;
            let following=if user{Vec::new()}else{latest_user.clone()};
            let result_flags=if user{u32::from(exact)}else{(flags&14)|if flags&6==0&&flags&16!=0{16}else{0}};
            if user{
                latest_user=id.clone();
                if exact{matched=id.clone();}
                if first_fingerprint.is_none()&&!expected.is_empty()&&v[3]==expected{first_fingerprint=Some(rows.len());}
            }else{latest_assistant=id.clone();}
            rows.extend([ascii(if user{"1"}else{"2"}),ascii(&index.to_string()),id,following,v[3].to_vec(),ascii(&result_flags.to_string()),v[5].to_vec()]);
        }
        // A fingerprint-only observation can locate a candidate, but when
        // exact text is supplied, a collision must never upgrade a match.
        if matched.is_empty()&&!exact_required{
            if let Some(at)=first_fingerprint{matched=rows[at+2].clone();rows[at+5]=ascii("1");}
        }
        let mut out=vec![latest_user,latest_assistant,matched];out.extend(rows);Some(out)
    }
    // Bind a response to the first assistant following the selected user,
    // then apply the native response-state priority and presentation policy.
    // Input: explicit/matched/latest user, explicit/snapshot conversation ID,
    // generation bits, status text, user count, user rows, assistant rows.
    fn bound_response(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
        if f.len()<8{return None;}
        let user=[f[0],f[1],f[2]].into_iter().find(|v|!v.is_empty()).unwrap_or(&[]);
        let conversation=if f[3].is_empty(){f[4]}else{f[3]};
        let generation=number(f[5]) as u32;let count=number(f[7]) as usize;
        let end=8usize.checked_add(count.checked_mul(2)?)?;
        if end>f.len()||(f.len()-end)%5!=0{return None;}
        let bound=f[8..end].chunks_exact(2).find(|v|v[0]==user).map(|v|number(v[1]) as u32);
        let assistants=&f[end..];
        let following=assistants.chunks_exact(5).find(|v|v[1]==user)
            .or_else(||bound.and_then(|idx|assistants.chunks_exact(5).find(|v|number(v[2]) as u32>idx)));
        let a=following.map_or(0,|v|number(v[3]) as u32);
        let error=following.map_or(&[][..],|v|v[4]);
        let id=following.map_or(&[][..],|v|v[0]);
        let mut flags=generation;
        if a&4!=0{flags|=2;}if !error.is_empty(){flags|=32;}
        if marker_present(f[6],"waitingForUserMarkers"){flags|=64;}
        if marker_present(f[6],"interruptedMarkers"){flags|=128;}
        if a&16!=0{flags|=256;}if a&2!=0{flags|=2048;}if a&8!=0{flags|=4096;}
        let code=super::cpo_response_class(flags);
        let (phase,source)=match code{
            1=>("error","conversation-max-length"),2|6=>("error","assistant-error-stop"),
            3=>("error","delivery-timeout"),4=>("error","retry-visible"),5=>("error","generation-error"),
            7=>("waiting-for-user","waiting-for-user"),8=>("interrupted","interrupted"),
            9=>("active","incomplete-tool-turn"),10=>("active","deep-research"),11=>("active","streaming"),12=>("active","generating"),
            13=>("terminal","bound-assistant-turn"),_=>("transient-idle","transient-idle")
        };
        let active=matches!(code,9..=12);
        let deep=(active||matches!(code,3..=5))&&generation&1024!=0;
        let result_flags=u32::from(active&&generation&512!=0)|(u32::from(deep)<<1)|(u32::from(code==13)<<2)|(u32::from(active)<<3)|(u32::from(a&8!=0)<<4);
        Some(vec![ascii(phase),ascii(source),user.to_vec(),id.to_vec(),conversation.to_vec(),ascii(&result_flags.to_string()),if code==6{error.to_vec()}else{Vec::new()}])
    }
    // Return index of first eligible semantic button in requested order.
    fn semantic_button(f:&[&[u16]])->Option<Vec<u16>>{
        if f.is_empty()||(f.len()-1)%4!=0{return None;}
        let retry=eq(f[0],"1");
        for (index,v) in f[1..].chunks_exact(4).enumerate(){
            if !eq(v[0],"1"){continue;}
            let test_id=lower_ascii(v[1]);let label=lower_ascii(trim(v[2]));let text=lower_ascii(trim(v[3]));
            if retry&&(contains_units(&test_id,&ascii("retry"))||contains_units(&test_id,&ascii("regenerate"))){return Some(ascii(&index.to_string()));}
            let matched=catalog_signal(if retry{"retryLabels"}else{"stopLabels"}).iter().any(|m|{
                let units=ascii(m);
                contains_units(&label,&units)||if retry{contains_units(&text,&units)}else{contains_units(&test_id,&ascii(&m.replace(' ',"-")))}
            });
            if matched{return Some(ascii(&index.to_string()));}
        }
        Some(Vec::new())
    }
    include!("provider_observation.rs");
    fn execute(op:u32,f:&[&[u16]])->Option<Vec<Vec<u16>>>{
        let single=|v:Vec<u16>|Some(vec![v]);
        match op{
            1=>{ // stable due-time sort, then creation time
                if f.len()%2!=0{return None;}
                let mut rows:Vec<_>=f.chunks_exact(2).enumerate().map(|(i,v)|(i,number(v[0]),number(v[1]))).collect();
                if rows.iter().any(|r|!r.1.is_finite()||!r.2.is_finite()){return None;}
                rows.sort_by(|a,b|match super::cpo_schedule_compare(a.1,b.1,a.2,b.2){0=>std::cmp::Ordering::Less,2=>std::cmp::Ordering::Greater,_=>std::cmp::Ordering::Equal});
                Some(rows.iter().map(|r|ascii(&r.0.to_string())).collect())
            },
            2|3=>{ // lookup first ID or all indices other than that ID
                let (id,items)=f.split_first()?;
                let indices=items.iter().enumerate().filter(|(_,v)|if op==2{*v==id}else{*v!=id});
                Some(if op==2{indices.take(1).map(|(i,_)|ascii(&i.to_string())).collect()}else{indices.map(|(i,_)|ascii(&i.to_string())).collect()})
            },
            4=>{ // due selection with optional specific ID, revalidated by claim
                if f.len()<2||(f.len()-2)%3!=0{return None;}
                let now=number(f[0]);let id=f[1];
                Some(f[2..].chunks_exact(3).enumerate().filter(|(_,v)|(id.is_empty()||id==v[0])&&super::cpo_schedule_action(4,number(v[1]) as u32,number(v[2]),now)==1).map(|(i,_)|ascii(&i.to_string())).collect())
            },
            5=>single(format_identity(f)?),
            6=>single(handoff(f)?),
            7=>{ // deduplicate first tab ID, then filter supported providers
                if f.len()%3!=0{return None;}
                let mut seen=BTreeSet::new();let mut active=Vec::new();let mut other=Vec::new();
                for (i,row) in f.chunks_exact(3).enumerate(){
                    if row[0].is_empty()||!seen.insert(row[0])||!eq(row[1],"1"){continue;}
                    if eq(row[2],"1"){active.push(ascii(&i.to_string()));}else{other.push(ascii(&i.to_string()));}
                }
                active.extend(other);Some(active)
            },
            8=>single(clean_title(*f.first()?)),
            9=>single(popup_status(f)?),
            10=>single(running_label(f)?),
            11=>single(ascii(scheduled_status(*f.first()?))),
            12=>single(scheduled_label(f)?),
            13=>stats(f),
            14=>single(normalize(*f.first()?)),
            15=>single(unique_sequence_name(f)?),
            16=>Some(collect_variables(f)),
            17=>parse_local_date(*f.first()?),
            18=>format_local_date(f).map(|s|vec![ascii(&s)]),
            19=>single(if valid_sequence_name(*f.first()?){ascii("1")}else{ascii("0")}),
            20=>failure_class(f),
            21=>scheduled_patch(f),
            22=>single(assistant_error_prefix(f)?),
            23=>turn_snapshot(f),
            24=>bound_response(f),
            25=>single(semantic_button(f)?),
            26=>provider_marker(f),
            27=>provider_buttons(f),
            28=>provider_generation_text(f),
            29=>provider_diagnostics(f),
            30=>provider_generation_state(f),
            31=>turn_metadata_finish(f),
            32=>turn_metadata_lookup(f),
            33=>last_assistant_observation(f),
            _=>None
        }
    }
    #[no_mangle]
    pub extern "C" fn cpo_batch_input(len:u32)->usize{
        if len as usize>MAX_UNITS{return 0;}
        BUFFER.with(|b|{let mut b=b.borrow_mut();b.input.resize(len as usize,0);b.input.as_mut_ptr() as usize})
    }
    #[no_mangle]
    pub extern "C" fn cpo_batch_run(op:u32)->u32{
        BUFFER.with(|b|{
            let mut b=b.borrow_mut();
            let result=fields(&b.input).and_then(|f|execute(op,&f));
            b.input.fill(0);b.input.clear();b.output.fill(0);b.output.clear();
            let Some(result)=result else{return 0;};
            for row in result{put(&mut b.output,&row);}
            u32::try_from(b.output.len()).ok().and_then(|n|n.checked_add(1)).unwrap_or(0)
        })
    }
    #[no_mangle]
    pub extern "C" fn cpo_batch_output()->usize{BUFFER.with(|b|b.borrow().output.as_ptr() as usize)}
    #[no_mangle]
    pub extern "C" fn cpo_batch_wipe(){
        BUFFER.with(|b|{let mut b=b.borrow_mut();b.input.fill(0);b.input.clear();b.output.fill(0);b.output.clear();
            // Do not retain unusually large transfer buffers in the allocator.
            if b.input.capacity()>65536{b.input.shrink_to(65536);}
            if b.output.capacity()>65536{b.output.shrink_to(65536);}
        });
    }
    #[cfg(test)]
    mod tests{
        use super::*;
        #[test]fn stable_order_and_identity(){
            let rows=["10","5","1","9","10","5"].map(ascii);
            let refs:Vec<_>=rows.iter().map(Vec::as_slice).collect();
            assert_eq!(execute(1,&refs).unwrap(),["1","0","2"].map(ascii));
            let values=["chatgpt","existing","abc",""].map(ascii);
            let refs:Vec<_>=values.iter().map(Vec::as_slice).collect();
            assert_eq!(execute(5,&refs).unwrap(),vec![ascii("chatgpt:c:abc")]);
        }
        #[test]fn title_and_whitespace(){
            assert_eq!(clean_title(&ascii("ChatGPT - Example – Claude")),ascii("Example"));
            assert_eq!(normalize(&ascii("  a\t b  ")),ascii("a b"));
        }
    }
}

 // Raw browser event facts: shift/alt/ctrl/meta/composing/IME=bits 0..5.
 // Key identity and modifier eligibility are evaluated in native code.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_keyboard_event(len:u32,modifiers:u32,key_code:u32)->u32{
    if len as usize>CHUNK{return 0;}
    let key=unsafe{core::slice::from_raw_parts(cpo_fingerprint_buffer() as *const u16,len as usize)};
    keyboard_event(key,modifiers,key_code)
}
fn keyboard_event(key:&[u16],modifiers:u32,key_code:u32)->u32{
    (ascii_eq(key,b"Enter")&&modifiers&31==0&&key_code!=229) as u32
}
// Calendar interpretation uses the browser's local timezone and DST rules;
// native code validates the observed civil-time round trip.
#[no_mangle]
pub extern "C" fn cpo_local_date_match(y:u32,m:u32,d:u32,h:u32,min:u32,ay:f64,am:f64,ad:f64,ah:f64,amin:f64)->u32{
    (ay==y as f64&&am==m as f64&&ad==d as f64&&ah==h as f64&&amin==min as f64) as u32
}
#[no_mangle]
pub extern "C" fn cpo_timestamp_valid(value:f64)->u32{
    (value.is_finite()&&value>0.0) as u32
}
// 0 deadline addition, 1 elapsed, 2 nonnegative remaining, 3 round up
// to next minute after a delay, 4 retry fallback, 5 alarm time,
// 6 strictly future, 7 inclusive expiry check.
#[no_mangle]
pub extern "C" fn cpo_timestamp_math(op:u32,a:f64,b:f64,c:f64)->f64{
    match op{
        0=>a+b,1=>a-b,2=>if (a-b).is_nan(){f64::NAN}else{(a-b).max(0.0)},
        3=>((a+b)/60000.0).ceil()*60000.0,
        4=>if a.is_finite()&&a>b{a}else{b+c},
        5=>if a.is_nan()||a==0.0{b}else{a.max(b)},
        6=>(a>b) as u32 as f64,
        7=>(a<=b) as u32 as f64,
        _=>f64::NAN
    }
}
#[cfg(test)]
mod final_native_policy_tests{
    use super::*;
    #[test]
    fn keyboard_and_epoch_math(){
        let enter:Vec<_>="Enter".encode_utf16().collect();
        assert_eq!(keyboard_event(&enter,0,13),1);
        for i in 0..5{assert_eq!(keyboard_event(&enter,1<<i,13),0);}
        assert_eq!(keyboard_event(&enter,0,229),0);
        assert_eq!(cpo_timestamp_math(3,1800000000001.0,300000.0,0.0),1800000360000.0);
        assert_eq!(cpo_timestamp_math(4,0.0,1800000000000.0,60000.0),1800000060000.0);
        assert_eq!(cpo_timestamp_valid(f64::NAN),0);
    }
}

 // Binding decisions: 0 allow, 1 provider mismatch, 2 unsupported,
 // 3 bind new to existing, 4 new mismatch, 5 existing mismatch,
 // 6 existing to new, 7 existing to other, 8 bind previously unknown.
 #[no_mangle]
 pub extern "C" fn cpo_job_binding(stored:u32,current:u32,flags:u32)->u32{
    if flags&1!=0{return 1;}
    if current==3{return 2;}
    if stored==2{return if current==1&&flags&4!=0{3}else if current==2{0}else{4};}
    if stored==1&&flags&2!=0{return if current==1{if flags&8!=0{0}else{5}}else if current==2{6}else{7};}
    if (stored==0||flags&2==0)&&(current==1||current==2){return 8;}
    0
 }

#[no_mangle]
pub extern "C" fn cpo_turn_cache_eligible(enabled:u32,index:u32,total:u32)->u32{
    (enabled!=0&&index<total.saturating_sub(2)) as u32
}
