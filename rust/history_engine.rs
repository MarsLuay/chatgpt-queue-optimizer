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
pub extern "C" fn cpo_history_abi() -> u32 { 2 }

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

// CPO2 uses bounded LZ tokens. A literal token 0..127 copies token+1
// bytes; a match token 128..255 copies (token&127)+3 bytes from a
// nonzero little-endian u16 distance. Each row is independent.
fn compress(input: &[u8], out: &mut [u8], table: &mut [u32; 4096]) -> Option<usize> {
    table.fill(u32::MAX);
    let mut pos = 0;
    let mut written = 0;
    let mut literal = 0;
    fn literals(input: &[u8], out: &mut [u8], written: &mut usize, from: usize, to: usize) -> Option<()> {
        for chunk in input[from..to].chunks(128) {
            let end = written.checked_add(1 + chunk.len())?;
            if end > out.len() { return None; }
            out[*written] = (chunk.len()-1) as u8;
            out[*written+1..end].copy_from_slice(chunk);
            *written = end;
        }
        Some(())
    }
    while pos + 2 < input.len() {
        let key = ((u32::from(input[pos]) * 251 + u32::from(input[pos+1])) * 251 + u32::from(input[pos+2])) as usize & 4095;
        let prev = table[key] as usize;
        table[key] = pos as u32;
        let mut len = 0;
        if prev < pos && pos-prev <= 65535 {
            while len < 130 && pos+len < input.len() && input[prev+len] == input[pos+len] { len += 1; }
        }
        if len >= 4 {
            literals(input,out,&mut written,literal,pos)?;
            if written+3 > out.len() { return None; }
            out[written] = 128 | ((len-3) as u8);
            out[written+1..written+3].copy_from_slice(&((pos-prev) as u16).to_le_bytes());
            written += 3;
            pos += len;
            literal = pos;
        } else { pos += 1; }
    }
    literals(input,out,&mut written,literal,input.len())?;
    (written < input.len()).then_some(written)
}

fn decompress(input: &[u8], output: &mut [u8]) -> bool {
    let mut i = 0;
    let mut o = 0;
    while i < input.len() {
        let token = input[i]; i += 1;
        if token < 128 {
            let n = token as usize + 1;
            if n > input.len()-i || n > output.len()-o { return false; }
            output[o..o+n].copy_from_slice(&input[i..i+n]);
            i += n; o += n;
        } else {
            let n = (token & 127) as usize + 3;
            if input.len()-i < 2 || n > output.len()-o { return false; }
            let distance = u16::from_le_bytes([input[i],input[i+1]]) as usize;
            i += 2;
            if distance == 0 || distance > o { return false; }
            for _ in 0..n { output[o] = output[o-distance]; o += 1; }
        }
    }
    o == output.len()
}

#[cfg(target_arch = "wasm32")]
static mut CODEC_OUTPUT: [u8; MAX_ROW] = [0; MAX_ROW];
#[cfg(target_arch = "wasm32")]
static mut CODEC_TABLE: [u32; 4096] = [0; 4096];

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_output() -> usize { core::ptr::addr_of_mut!(CODEC_OUTPUT) as *mut u8 as usize }

// The input is a previously framed CPO1 row. Return the compressed length,
// or zero to retain the original frame when compression is not beneficial.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_compress(size: u32) -> u32 {
    let size = size as usize;
    if !(HEADER..=MAX_ROW).contains(&size) { return 0; }
    let input = unsafe { core::slice::from_raw_parts(cpo_history_buffer() as *const u8,size) };
    let index = u32::from_le_bytes([input[4],input[5],input[6],input[7]]);
    if parse(input,index).is_none() { return 0; }
    let output = unsafe { core::slice::from_raw_parts_mut(cpo_history_output() as *mut u8,MAX_ROW) };
    let table = unsafe { &mut *core::ptr::addr_of_mut!(CODEC_TABLE) };
    match compress(&input[HEADER..],&mut output[HEADER..size],table) {
        Some(n) => {
            output[..HEADER].copy_from_slice(&input[..HEADER]);
            output[..4].copy_from_slice(b"CPO2");
            (HEADER+n) as u32
        }
        None => 0
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_decompress(index: u32, size: u32) -> u32 {
    let size = size as usize;
    if !(HEADER..=MAX_ROW).contains(&size) { return 0; }
    let input = unsafe { core::slice::from_raw_parts(cpo_history_buffer() as *const u8,size) };
    if &input[..4] != b"CPO2" { return 0; }
    let len = u32::from_le_bytes([input[12],input[13],input[14],input[15]]) as usize;
    if len > MAX_TEXT || size-HEADER >= len { return 0; }
    let output = unsafe { core::slice::from_raw_parts_mut(cpo_history_output() as *mut u8,HEADER+len) };
    output[..HEADER].copy_from_slice(&input[..HEADER]);
    output[..4].copy_from_slice(b"CPO1");
    if !decompress(&input[HEADER..],&mut output[HEADER..]) || parse(output,index).is_none() { return 0; }
    (HEADER+len) as u32
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_wipe_output(size: u32) {
    let ptr = cpo_history_output() as *mut u8;
    for i in 0..(size as usize).min(MAX_ROW) { unsafe { core::ptr::write_volatile(ptr.add(i),0); } }
    let table = core::ptr::addr_of_mut!(CODEC_TABLE) as *mut u32;
    for i in 0..4096 { unsafe { core::ptr::write_volatile(table.add(i),0); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lz_roundtrip_and_malformed_tokens() {
        let input = b"the same sentence the same sentence the same sentence";
        let mut compressed = [0; 64];
        let mut table = [0; 4096];
        let n = compress(input,&mut compressed,&mut table).unwrap();
        assert!(n < input.len());
        let mut restored = [0; b"the same sentence the same sentence the same sentence".len()];
        assert_eq!(input.len(),restored.len());
        assert!(decompress(&compressed[..n],&mut restored));
        assert_eq!(&restored,input);
        assert!(!decompress(&[128,0,0],&mut [0;3]));
        assert!(!decompress(&[127,1],&mut [0;2]));
    }
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
