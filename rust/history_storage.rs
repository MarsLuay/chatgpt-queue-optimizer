//! Native storage transaction cursor and fused row transport.
//! The cursor is passed by value between awaited IndexedDB requests;
//! independent transactions never share a mutable native transaction slot.
use super::{cpo_history_next,cpo_history_page_start,cpo_history_page_size,cpo_history_row_decision,MAX_TURNS,PAGE};
#[cfg(target_arch="wasm32")]
use super::{cpo_history_encode,cpo_history_compress,cpo_history_decode,cpo_history_decompress,cpo_history_buffer,cpo_history_output,HEADER,MAX_ROW};

#[no_mangle]
pub extern "C" fn cpo_history_tx_mode(kind:u32)->u32 {
    match kind {0|4=>1,1|2|3|5=>2,_=>0}
}
// Cursor: low 3 bits command, next 5 remaining rows, bit 8 valid,
// next 5 step count. Plan has low 5 bits remaining, bit 5 valid.
// Zero is the initial cursor or rejection; command 7 completes.
#[no_mangle]
pub extern "C" fn cpo_history_tx_step(kind:u32,cursor:u32,plan:u32)->u32 {
    if cpo_history_tx_mode(kind)==0||cursor>>14!=0||plan>>6!=0{return 0;}
    let previous=cursor&7;
    let step=(cursor>>9)&31;
    if step>=PAGE+8||previous==7{return 0;}
    let (remaining,valid)=if previous==0||previous==1 {
        (plan&31,(plan>>5)&1)
    } else {
        let pending=(cursor>>3)&31;
        if previous==3&&pending==0{return 0;}
        (pending-u32::from(previous==3),(cursor>>8)&1)
    };
    if remaining>PAGE{return 0;}
    let next=cpo_history_next(kind,previous,valid,remaining);
    if next==0{return 0;}
    next|(remaining<<3)|(valid<<8)|((step+1)<<9)
}
// Page plan: 0 invalid; otherwise one plus packed start/count.
#[no_mangle]
pub extern "C" fn cpo_history_page_plan(complete:u32,count:u32,requested:u32)->u32 {
    if complete==0{return 1;}
    if count>MAX_TURNS{return 0;}
    let start=cpo_history_page_start(count,requested);
    1+(start<<5)+cpo_history_page_size(count,start)
}
#[no_mangle]
pub extern "C" fn cpo_history_legacy_row(index:u32,expected:u32,role:u32,text_present:u32)->u32 {
    (text_present==1&&index==expected&&index<MAX_TURNS&&(1..=3).contains(&role)) as u32
}
// 0 invalid, 1 capacity reached, otherwise encoded length in low 17 bits;
// bit 17 selects compression output. A single call validates and encodes.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_write_row(index:u32,expected:u32,role:u32,truncated:u32,chars:u32,used:u32,bytes:u32)->u32 {
    match cpo_history_row_decision(index,expected,role,chars,used,bytes) {
        2=>return 1,1=>{},_=>return 0
    }
    let len=cpo_history_encode(index,role,truncated,bytes);
    if len==0{return 0;}
    let compressed=cpo_history_compress(len);
    if compressed!=0{compressed|(1<<17)}else{len}
}
// Length (including header) in low 17 bits, validated role/truncation
// flags in bits 17..25, bit 26 selects decompressed scratch output.
// No decoded text is copied into an intermediate JS byte array.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_history_read_row(index:u32,size:u32)->u32 {
    if !(HEADER as u32..=MAX_ROW as u32).contains(&size){return 0;}
    let input=unsafe{core::slice::from_raw_parts(cpo_history_buffer() as *const u8,4)};
    if input==b"CPO2" {
        let len=cpo_history_decompress(index,size);
        if len==0{return 0;}
        let header=unsafe{core::slice::from_raw_parts(cpo_history_output() as *const u8,HEADER)};
        let flags=u32::from(header[8])|(u32::from(header[9])<<8);
        len|(flags<<17)|(1<<26)
    }else{
        let flags=cpo_history_decode(index,size);
        if flags==0{0}else{size|(flags<<17)}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn independent_cursors_and_bounds(){
        let first=cpo_history_tx_step(2,0,0);
        assert_eq!(first&7,1);
        let mut a=cpo_history_tx_step(2,first,32|2);
        let b=cpo_history_tx_step(2,first,32|1);
        assert_eq!(a&7,3);assert_eq!(b&7,3);
        a=cpo_history_tx_step(2,a,0);assert_eq!(a&7,3);
        assert_eq!(cpo_history_tx_step(2,b,0)&7,4);
        a=cpo_history_tx_step(2,a,0);assert_eq!(a&7,4);
        assert_eq!(cpo_history_tx_step(2,a,0)&7,7);
        assert_eq!(cpo_history_tx_step(2,first,32|17),0);
        assert_eq!(cpo_history_tx_step(2,first,0),0);
        assert_eq!(cpo_history_tx_mode(4),1);
        assert_eq!(cpo_history_tx_mode(8),0);
        assert_eq!(cpo_history_page_plan(1,17,100),1+(16<<5)+1);
        assert_eq!(cpo_history_page_plan(1,4097,0),0);
        assert_eq!(cpo_history_legacy_row(0,0,2,1),1);
        assert_eq!(cpo_history_legacy_row(0,0,0,1),0);
        assert_eq!(cpo_history_row_decision(0,0,1,1,super::super::MAX_BYTES,1),2);
    }
}
