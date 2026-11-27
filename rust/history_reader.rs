//! Reader state and action guards. One instance per history reader WASM.
//! Browser handles and awaited effects stay outside linear memory.
use super::{cpo_reader_buttons,cpo_reader_move,cpo_reader_batch,MAX_TURNS,MAX_BYTES,PAGE};
#[cfg(target_arch="wasm32")]
use super::{cpo_reader_continue,cpo_reader_partial};

struct Reader { ready:bool, busy:bool, page:u32, count:u32, bytes:u32, total:u32, batch:u32, partial:bool }
impl Reader {
    const fn new()->Self { Self{ready:false,busy:true,page:0,count:0,bytes:0,total:0,batch:0,partial:false} }
    fn buttons(&self, flags:u32,count:u32)->u32 {
        if !self.ready {0} else {cpo_reader_buttons((flags&30)|u32::from(self.busy),self.page,count)}
    }
    fn begin(&mut self, action:u32, flags:u32,count:u32)->bool {
        if !(1..=6).contains(&action)||self.buttons(flags,count)&(1<<(action-1))==0 {return false;}
        self.busy=true;
        if action==5||action==6 {self.page=cpo_reader_move(self.page,u32::from(action==6));}
        true
    }
    fn capture_reset(&mut self){self.count=0;self.bytes=0;self.total=0;self.batch=0;self.partial=false;}
    fn batch(&mut self,total:u32,rows:u32,next:u32)->bool {
        if total==0||(self.total!=0&&total!=self.total)||cpo_reader_batch(self.count,total,rows,next,3)!=1 {return false;}
        self.total=total;self.batch=0;true
    }
    fn row(&mut self,size:u32,truncated:u32)->bool {
        if self.count>=MAX_TURNS||self.count>=self.total||self.batch>=PAGE||size<128||size>MAX_BYTES-self.bytes {return false;}
        self.count+=1;self.bytes+=size;self.batch+=1;self.partial|=truncated!=0;true
    }
}
#[cfg(target_arch="wasm32")]
static mut READER: Reader=Reader::new();
// op: 0 initialized, 1 begin action, 2 finish, 3 button mask,
// 4 get page, 5 adopt page, 6 reset page, 7 disable on init failure.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_reader_state(op:u32,a:u32,b:u32,c:u32)->u32 {
    let r=unsafe{&mut *core::ptr::addr_of_mut!(READER)};
    match op {
        0=>{r.ready=true;r.busy=false;1},
        1=>r.begin(a,b,c) as u32,
        2=>{r.busy=false;1},
        3=>r.buttons(a,b),
        4=>r.page,
        5=>{r.page=super::cpo_history_page_start(b,a);1},
        6=>{r.page=0;1},
        7=>{*r=Reader::new();1},
        _=>0
    }
}
// Capture counters are native. Metadata objects and IDB transactions remain
// in the browser. A failed transaction aborts the action; next capture resets.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_reader_capture(op:u32,a:u32,b:u32,c:u32)->u32 {
    let r=unsafe{&mut *core::ptr::addr_of_mut!(READER)};
    match op {
        0=>{r.capture_reset();1},
        1=>r.batch(a,b,c) as u32,
        2=>r.row(a,b) as u32,
        3=>{r.partial=true;1},
        4=>r.count,
        5=>r.bytes,
        6=>r.batch,
        7=>cpo_reader_continue(r.count,r.total,r.batch,a),
        8=>cpo_reader_partial(r.count,r.total,u32::from(r.partial)),
        _=>0
    }
}
// Action-specific validation: capture source, revalidate source before
// finalize, discard current snapshot, original URL, existing original tab.
// Host supplies observed facts, native code authorizes the action.
#[no_mangle]
pub extern "C" fn cpo_reader_guard(kind:u32,flags:u32)->u32 {
    let required=match kind {0=>31,1=>15,2=>7,3=>3,4=>3,_=>return 0};
    (flags&required==required) as u32
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn reader_state_guards() {
        let mut r=Reader::new();
        assert!(!r.begin(1,2,0));
        r.ready=true;r.busy=false;
        assert!(!r.begin(6,2,0));
        assert!(r.begin(1,2,0));
        assert!(!r.begin(1,2,0));
        r.busy=false;
        assert!(r.begin(6,2|4|8,40));assert_eq!(r.page,16);
        assert_eq!(cpo_reader_guard(0,31),1);assert_eq!(cpo_reader_guard(0,30),0);
        assert_eq!(cpo_reader_guard(99,31),0);
    }
    #[test]fn capture_counters_and_limits() {
        let mut r=Reader::new();r.capture_reset();
        assert!(!r.batch(0,0,0));
        assert!(r.batch(2,2,2));
        assert!(r.row(200,0));assert!(r.row(128,1));
        assert_eq!((r.count,r.bytes,r.batch,r.partial),(2,328,2,true));
        assert!(!r.row(128,0));assert!(!r.batch(3,1,3));
        r.capture_reset();assert!(r.batch(20,16,16));assert!(!r.row(MAX_BYTES+1,0));
    }
}
