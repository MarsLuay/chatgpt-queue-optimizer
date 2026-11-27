//! Popup controller: native generations, bounded rendering, and action policy.
//! Browser object identities and effect handles remain with the host.
const CHANNELS:usize=9;
const CHUNK:u32=100;
struct Popup { epochs:[u32;CHANNELS],limit:u32,panel:u32,status:u32 }
impl Popup {
    const fn new()->Self{Self{epochs:[0;CHANNELS],limit:CHUNK,panel:0,status:0}}
    fn control(&mut self,op:u32,a:u32,b:u32)->u32 {
        match op {
            // Each request family has its own generation. A late completion
            // can never render over a newer request from the same family.
            0=>{let Some(e)=self.epochs.get_mut(a as usize)else{return 0;};*e=e.wrapping_add(1).max(1);*e},
            1=>(b!=0&&self.epochs.get(a as usize)==Some(&b)) as u32,
            2=>self.limit.min(a),
            3=>{self.limit=super::cpo_ui_next_limit(a,self.limit);self.limit},
            4=>{if a<4{self.panel=a;1}else{0}},
            5=>self.panel,
            // Active status flags: exists=1, persistent=2, queue source=4.
            6=>{self.status=(a&6)|1;1},
            7=>{self.status=0;1},
            8=>self.status,
            _=>0
        }
    }
}
#[cfg(target_arch="wasm32")]
static mut POPUP:Popup=Popup::new();
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_popup_control(op:u32,a:u32,b:u32)->u32{
    unsafe{(&mut *core::ptr::addr_of_mut!(POPUP)).control(op,a,b)}
}
// Previous explicit choice valid=1, active tab supported=2, first
// supported candidate available=4. Return keep=1, current=2, first=3.
#[no_mangle]
pub extern "C" fn cpo_popup_target(flags:u32)->u32{
    if flags&1!=0{1}else if flags&2!=0{2}else if flags&4!=0{3}else{2}
}
// Schedule validation: text=1, valid local time=2, future=4.
#[no_mangle]
pub extern "C" fn cpo_popup_schedule_guard(flags:u32)->u32{
    if flags&1==0{1}else if flags&2==0{2}else if flags&4==0{3}else{0}
}
// Queue send/stop decision: existing job=1, messages present=2.
#[no_mangle]
pub extern "C" fn cpo_popup_send_action(flags:u32)->u32{
    if flags&1!=0{1}else if flags&2!=0{2}else{0}
}
// Queue status presentation: jobs exist=1, selected job=2,
// paused/failed=4, active non-queue persistent notification=8.
#[no_mangle]
pub extern "C" fn cpo_popup_queue_view(flags:u32)->u32{
    if flags&1==0{0}else if flags&8!=0{1}else if flags&2==0{2}else if flags&4!=0{3}else{4}
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn generations_are_independent(){
        let mut p=Popup::new();let a=p.control(0,0,0);let b=p.control(0,1,0);
        assert_eq!(p.control(1,0,a),1);assert_eq!(p.control(1,1,b),1);
        let next=p.control(0,0,0);assert_ne!(a,next);
        assert_eq!(p.control(1,0,a),0);assert_eq!(p.control(1,1,b),1);
        assert_eq!(p.control(0,9,0),0);
        assert_eq!(p.control(2,999,0),100);assert_eq!(p.control(3,999,0),200);
        assert_eq!(p.control(2,4,0),4);assert_eq!(p.control(4,2,0),1);
        assert_eq!(p.control(5,0,0),2);p.control(6,6,0);
        assert_eq!(p.control(8,0,0),7);p.control(7,0,0);assert_eq!(p.control(8,0,0),0);
    }
    #[test]fn popup_decisions(){
        assert_eq!(cpo_popup_target(7),1);assert_eq!(cpo_popup_target(6),2);assert_eq!(cpo_popup_target(4),3);
        assert_eq!(cpo_popup_schedule_guard(0),1);assert_eq!(cpo_popup_schedule_guard(1),2);
        assert_eq!(cpo_popup_schedule_guard(3),3);assert_eq!(cpo_popup_schedule_guard(7),0);
        assert_eq!(cpo_popup_send_action(3),1);assert_eq!(cpo_popup_send_action(2),2);
        for (flags,want) in [(0,0),(9,1),(1,2),(7,3),(3,4)]{assert_eq!(cpo_popup_queue_view(flags),want);}
    }
}
