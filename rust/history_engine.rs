//! Local snapshot codec and asynchronous IndexedDB command state machine.
//! Loaded only in the extension history reader. JS executes IDB requests
//! and supplies their results; Rust determines the next transaction command.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

const HEADER: usize = 16;
const MAX_TEXT: usize = 111_000;
const MAX_ROW: usize = HEADER + MAX_TEXT;
const MAX_BYTES: u32 = 8 * 1024 * 1024;
const MAX_TURNS: u32 = 4096;
const PAGE: u32 = 16;

#[no_mangle]
pub extern "C" fn cpo_history_abi() -> u32 { 1 }

// Snapshot row framing: magic, index, role, truncation flag, reserved bytes,
// UTF-8 length, UTF-8 text. UTF-8 is validated on both encode and decode.
fn frame(buf: &mut [u8], index: u32, role: u32, truncated: u32, len: usize) -> bool {
    if index >= MAX_TURNS || !(1..=3).contains(&role) || truncated > 1 ||
        len > MAX_TEXT || buf.len() < HEADER + len ||
        core::str::from_utf8(&buf[HEADER..HEADER + len]).is_err() { return false; }
    buf[..4].copy_from_slice(b"CPO1");
    buf[4..8].copy_from_slice(&index.to_le_bytes());
    buf[8] = role as u8;
    buf[9] = truncated as u8;
    buf[10] = 0; buf[11] = 0;
    buf[12..16].copy_from_slice(&(len as u32).to_le_bytes());
    true
}

fn parse(buf: &[u8], index: u32) -> Option<u32> {
    if buf.len() < HEADER || buf.len() > MAX_ROW || index >= MAX_TURNS ||
        &buf[..4] != b"CPO1" || buf[10] != 0 || buf[11] != 0 { return None; }
    let stored = u32::from_le_bytes([buf[4],buf[5],buf[6],buf[7]]);
    let len = u32::from_le_bytes([buf[12],buf[13],buf[14],buf[15]]) as usize;
    let role = buf[8];
    let truncated = buf[9];
    if stored != index || !(1..=3).contains(&role) || truncated > 1 ||
        len != buf.len() - HEADER || core::str::from_utf8(&buf[HEADER..]).is_err() { return None; }
    Some(u32::from(role) | (u32::from(truncated) << 8))
}

// A bounded scratch buffer, not a cache. The reader wipes it after each row.
// No text is passed to the optimizer/browser modules' linear memory.
#[cfg(target_arch = "wasm32")]
static mut SCRATCH: [u8; MAX_ROW] = [0; MAX_ROW];

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_buffer() -> usize {
    core::ptr::addr_of_mut!(SCRATCH) as *mut u8 as usize
}

#[no_mangle]
pub extern "C" fn cpo_history_capacity() -> u32 { MAX_ROW as u32 }

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_encode(index: u32, role: u32, truncated: u32, len: u32) -> u32 {
    if len as usize > MAX_TEXT { return 0; }
    let size = HEADER + len as usize;
    let buf = unsafe { core::slice::from_raw_parts_mut(cpo_history_buffer() as *mut u8, size) };
    if frame(buf, index, role, truncated, len as usize) { size as u32 } else { 0 }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_decode(index: u32, size: u32) -> u32 {
    if size as usize > MAX_ROW { return 0; }
    let buf = unsafe { core::slice::from_raw_parts(cpo_history_buffer() as *const u8, size as usize) };
    parse(buf, index).unwrap_or(0)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_wipe(size: u32) {
    let size = (size as usize).min(MAX_ROW);
    // Volatile stores ensure that an optimizer cannot remove the wipe.
    let ptr = cpo_history_buffer() as *mut u8;
    for i in 0..size { unsafe { core::ptr::write_volatile(ptr.add(i), 0) }; }
}

// 0 malformed row; 1 accepted; 2 snapshot cap reached.
#[no_mangle]
pub extern "C" fn cpo_history_row_decision(index: u32, expected: u32, role: u32,
    chars: u32, used: u32, bytes: u32) -> u32 {
    if index != expected || !(1..=3).contains(&role) || chars > 37_000 ||
        bytes as usize > MAX_TEXT || used > MAX_BYTES { return 0; }
    if index >= MAX_TURNS || bytes.saturating_add(128) > MAX_BYTES - used { 2 } else { 1 }
}

#[no_mangle]
pub extern "C" fn cpo_history_page_start(total: u32, requested: u32) -> u32 {
    requested.min(total.saturating_sub(1) / PAGE * PAGE)
}

#[no_mangle]
pub extern "C" fn cpo_history_page_size(total: u32, start: u32) -> u32 {
    total.saturating_sub(start).min(PAGE)
}

// The host reports identity equality and completion flags, Rust owns all
// count/byte/transition invariants. 0 read, 1 replace, 2 append, 3 finalize,
// 4 read page, 5 delete. Flags: exists=1, identity matches=2,
// stored complete=4, updated complete=8.
#[no_mangle]
pub extern "C" fn cpo_history_meta_valid(kind: u32, flags: u32, old_count: u32,
    new_count: u32, old_bytes: u32, new_bytes: u32, rows: u32, first: u32) -> u32 {
    let matches = flags & 3 == 3;
    let incomplete = flags & 4 == 0;
    let bounded = new_count <= MAX_TURNS && new_bytes <= MAX_BYTES;
    match kind {
        1 => (flags & 8 == 0 && new_count == 0 && new_bytes == 0) as u32,
        2 => (matches && incomplete && flags & 8 == 0 && bounded &&
            rows > 0 && rows <= PAGE && first == old_count &&
            old_count.checked_add(rows) == Some(new_count) && new_bytes >= old_bytes) as u32,
        3 => (matches && incomplete && flags & 8 != 0 && bounded &&
            new_count > 0 && old_count == new_count && old_bytes == new_bytes) as u32,
        5 => matches as u32,
        _ => 0,
    }
}

// Commands: 0 reject; 1 read metadata; 2 clear rows; 3 put next row;
// 4 put metadata; 5 clear metadata; 6 get page; 7 complete.
// The host calls this after each awaited request, within one IDB transaction.
#[no_mangle]
pub extern "C" fn cpo_history_next(kind: u32, previous: u32, valid: u32, remaining: u32) -> u32 {
    match (kind, previous) {
        (0 | 2 | 3 | 4 | 5, 0) => 1,
        (1, 0) if valid == 1 => 2,
        (0, 1) => 7,
        (1, 2) => 4,
        (2, 1) if valid == 1 && remaining > 0 => 3,
        (2, 3) if remaining > 0 => 3,
        (2, 3) => 4,
        (3, 1) if valid == 1 => 4,
        (1 | 2 | 3, 4) => 7,
        (4, 1) if valid == 1 && remaining > 0 => 6,
        (4, 1 | 6) => 7,
        (5, 1) if valid == 1 => 2,
        (5, 2) => 5,
        (5, 5) => 7,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn row_roundtrip_and_corruption() {
        let mut buf = [0; HEADER + 5];
        buf[HEADER..].copy_from_slice(b"hello");
        assert!(frame(&mut buf, 7, 2, 1, 5));
        assert_eq!(parse(&buf, 7), Some(258));
        assert_eq!(parse(&buf, 8), None);
        buf[HEADER] = 255;
        assert_eq!(parse(&buf, 7), None);
    }
    #[test]
    fn row_limits_and_page() {
        assert_eq!(cpo_history_row_decision(0,0,1,1,MAX_BYTES-129,1),1);
        assert_eq!(cpo_history_row_decision(0,0,1,1,MAX_BYTES-128,1),2);
        assert_eq!(cpo_history_row_decision(1,0,1,1,0,1),0);
        assert_eq!(cpo_history_page_start(17,100),16);
        assert_eq!(cpo_history_page_size(17,16),1);
    }
    #[test]
    fn transaction_sequences() {
        assert_eq!(cpo_history_next(2,0,0,2),1);
        assert_eq!(cpo_history_next(2,1,0,2),0);
        assert_eq!(cpo_history_next(2,1,1,2),3);
        assert_eq!(cpo_history_next(2,3,1,1),3);
        assert_eq!(cpo_history_next(2,3,1,0),4);
        assert_eq!(cpo_history_next(2,4,1,0),7);
        assert_eq!(cpo_history_next(5,1,1,0),2);
        assert_eq!(cpo_history_next(5,2,1,0),5);
        assert_eq!(cpo_history_meta_valid(2,3,4,6,100,200,2,4),1);
        assert_eq!(cpo_history_meta_valid(2,7,4,6,100,200,2,4),0);
        assert_eq!(cpo_history_meta_valid(3,11,6,6,200,200,0,0),1);
    }
}
