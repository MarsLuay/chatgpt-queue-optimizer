//! Per-document lifecycle, route and submission controller.
//! Only integers persist here. DOM handles and pending browser effects stay
//! in the host and are revalidated after every asynchronous boundary.
use super::cpo_intersection_transition;

struct Controller {
    bind_epoch:u32, binding:bool, refreshing:bool, submission:u32,
    observer_epoch:u32, auto:u32,
}
impl Controller {
    const fn new()->Self{Self{bind_epoch:0,binding:false,refreshing:false,submission:0,observer_epoch:0,auto:4}}
    fn bump(value:&mut u32)->u32{*value=value.wrapping_add(1).max(1);*value}
    fn control(&mut self,op:u32,a:u32,b:u32)->u32{
        match op {
            // Binding generation: cancel stale async bind attempts, including
            // when a route changes while optimizer_core is loading.
            0=>{self.binding=true;Self::bump(&mut self.bind_epoch)},
            1=>(self.binding&&a!=0&&a==self.bind_epoch) as u32,
            2=>{self.binding=false;Self::bump(&mut self.bind_epoch);Self::bump(&mut self.observer_epoch);self.auto=4;1},
            3=>{if self.refreshing{0}else{self.refreshing=true;1}},
            4=>{self.refreshing=false;1},
            // 1 acquired, 2 composer write attempted, 3 click attempted.
            5=>{if self.submission!=0{0}else{self.submission=1;1}},
            6=>{if self.submission==1{self.submission=2;1}else{0}},
            7=>{if self.submission==2{self.submission=3;1}else{0}},
            8=>self.submission,
            9=>{self.submission=0;1},
            // Auto-scroll observer owns its arming and in-flight state. A
            // stale animation-frame completion cannot clear a new observer.
            10=>{self.auto=4;Self::bump(&mut self.observer_epoch)},
            11=>{
                if a==0||a!=self.observer_epoch{return 0;}
                let action=cpo_intersection_transition((b&17)|self.auto);
                self.auto=(if action&1!=0{4}else{0})|(if action&2!=0{2}else{0})|
                    (self.auto&8)|((action&4)<<1);
                action|8
            },
            12=>{if a==self.observer_epoch{self.auto&=!8;1}else{0}},
            _=>0
        }
    }
}
#[cfg(target_arch="wasm32")]
static mut CONTENT:Controller=Controller::new();
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_content_control(op:u32,a:u32,b:u32)->u32{
    unsafe{(&mut *core::ptr::addr_of_mut!(CONTENT)).control(op,a,b)}
}
// Route: supported=1, forced=2, same identity=4, detached=8,
// eligible=16, enabled=32. 0 keep, 1 unbind, 2 unbind/rebind.
#[no_mangle]
pub extern "C" fn cpo_content_route(flags:u32)->u32{
    if flags&1==0||(flags&4!=0&&flags&10==0){0}
    else if flags&48==48{2}else{1}
}
// Stage guards: history capture and discard are fail-closed.
// Discard stages check cheap facts before triggering DOM queries.
#[no_mangle]
pub extern "C" fn cpo_content_guard(kind:u32,flags:u32)->u32{
    let required=match kind {
        0=>31, // hidden, provider, route, no inline enqueue, no native submit
        1=>3,  // composer exists and draft empty
        2=>63, // generation state exists, five inactive generation facts
        3=>15, // no modal, file, playing media, or upload
        4=>3,  // capture provider and discard safety
        5=>3,  // saved conversation and eligible route
        6=>3,  // identity present and request matches
        7=>7,  // provider, queued text, identity
        8=>3,  // background authorization and same send button
        _=>return 0
    };
    (flags&required==required) as u32
}
#[no_mangle]
pub extern "C" fn cpo_content_history_offset(offset:u32,total:u32)->u32{
    (offset<=total) as u32
}
#[no_mangle]
pub extern "C" fn cpo_content_mutation(flags:u32,count:u32,previous:u32)->u32{
    // 0 disabled/skip, 1 invalidate/schedule, 2 refresh, 3 unsafe runtime.
    if flags&3!=3{return 0;}
    if flags&4==0{return 3;}
    if flags&8==0{return 0;}
    if flags&16==0{return 1;}
    if count!=previous||count>0{2}else{0}
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn lifecycle_and_submission_are_exclusive(){
        let mut s=Controller::new();
        let first=s.control(0,0,0);let second=s.control(0,0,0);
        assert_eq!(s.control(1,first,0),0);assert_eq!(s.control(1,second,0),1);
        s.control(2,0,0);assert_eq!(s.control(1,second,0),0);
        assert_eq!(s.control(3,0,0),1);assert_eq!(s.control(3,0,0),0);
        s.control(4,0,0);assert_eq!(s.control(3,0,0),1);
        assert_eq!(s.control(5,0,0),1);assert_eq!(s.control(5,0,0),0);
        assert_eq!(s.control(7,0,0),0);assert_eq!(s.control(6,0,0),1);
        assert_eq!(s.control(7,0,0),1);assert_eq!(s.control(8,0,0),3);
        s.control(9,0,0);assert_eq!(s.control(8,0,0),0);
    }
    #[test]fn route_and_safety_policy(){
        assert_eq!(cpo_content_route(1|4|16|32),0);
        assert_eq!(cpo_content_route(1|4|8|16|32),2);
        assert_eq!(cpo_content_route(1|2),1);
        assert_eq!(cpo_content_guard(0,31),1);assert_eq!(cpo_content_guard(0,30),0);
        assert_eq!(cpo_content_history_offset(5,4),0);
        assert_eq!(cpo_content_mutation(3|4|8,0,0),1);
        assert_eq!(cpo_content_mutation(3|4|8|16,5,5),2);
        assert_eq!(cpo_content_mutation(3,0,0),3);
    }
    #[test]fn observer_epoch_rejects_stale_completion(){
        let mut s=Controller::new();let a=s.control(10,0,0);
        assert_eq!(s.control(11,a,17)&4,4);
        let b=s.control(10,0,0);
        assert_ne!(a,b);assert_eq!(s.control(12,a,0),0);
        assert_eq!(s.control(11,a,17),0);
    }
}
