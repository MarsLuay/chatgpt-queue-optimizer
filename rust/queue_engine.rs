//! Queue execution decisions and streaming legacy-compatible UTF-16 fingerprints.
#![cfg_attr(target_arch = "wasm32", no_std)]
#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { core::arch::wasm32::unreachable() }

#[no_mangle]
pub extern "C" fn cpo_queue_abi() -> u32 { 2 }

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

#[cfg(test)]
mod tests {
    use super::*;
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
