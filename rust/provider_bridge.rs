//! Provider cache decisions and last-turn observation. DOM handles remain
//! call-local and browser-owned. No cached text or DOM pointer lives here.
use super::{cpo_cache_valid,cpo_cache_ttl,cpo_dom_last_assistant};
struct Tokens{next:u32}
impl Tokens{
    const fn new()->Self{Self{next:1}}
    fn allocate(&mut self)->u32{
        let token=self.next;
        self.next=if token==0{0}else{token.checked_add(1).unwrap_or(0)};
        token
    }
}
#[cfg(target_arch="wasm32")]
static mut TOKENS:Tokens=Tokens::new();
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_bridge_cache_token()->u32{
    unsafe{(&mut *core::ptr::addr_of_mut!(TOKENS)).allocate()}
}
// Cache plan: enabled=1, same document=2, cached nodes present=4.
// 0 bypass and invalidate; 1 inspect connected nodes; 2 rebuild and retain.
#[no_mangle]
pub extern "C" fn cpo_bridge_cache_plan(flags:u32,age:u32)->u32{
    if flags&1==0{0}
    else if flags&6==6&&cpo_cache_valid(1,age,3)==1{1}
    else{2}
}
// Convert native decisions into an expiration delay for the browser timer.
#[no_mangle]
pub extern "C" fn cpo_bridge_cache_delay(plan:u32)->u32{
    if plan==1||plan==2{cpo_cache_ttl(1)}else{0}
}
// Select error signal precedence without materializing alternate strings.
// capacity=1, assistant-error-stop=2, alert=4, status=8, retry=16.
#[no_mangle]
pub extern "C" fn cpo_bridge_error_signal(flags:u32)->u32{
    if flags&1!=0{
        if flags&4!=0{1}else if flags&8!=0{2}else{3}
    }else if flags&2!=0{4}else if flags&4!=0{1}else if flags&16!=0{5}else{0}
}
// Inspect only the latest turn. Do not read text, query alerts, or scan
// retry controls until native classification establishes an assistant turn.
// 0 no turn, 1 not assistant, 2 assistant observed; host gathers facts.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_bridge_last_turn(count:u32)->u32{
    if count==0{return 0;}
    let mut flags=super::h(190,count-1,0,0);
    if count>=2{flags|=8;}
    if cpo_dom_last_assistant(flags)!=1{return 1;}
    if super::h(191,0,0,0)==0{return u32::MAX;}
    if super::h(191,1,0,0)==0{return u32::MAX;}
    if super::h(191,2,0,0)==0{return u32::MAX;}
    if super::h(191,3,0,0)==0{return u32::MAX;}
    2
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn tokens_never_wrap(){
        let mut t=Tokens::new();assert_eq!(t.allocate(),1);assert_eq!(t.allocate(),2);
        t.next=u32::MAX;assert_eq!(t.allocate(),u32::MAX);assert_eq!(t.allocate(),0);assert_eq!(t.allocate(),0);
    }
    #[test]fn cache_plans(){
        assert_eq!(cpo_bridge_cache_plan(7,7999),1);
        assert_eq!(cpo_bridge_cache_plan(7,8000),2);
        assert_eq!(cpo_bridge_cache_plan(3,0),2);
        assert_eq!(cpo_bridge_cache_plan(6,0),0);
        assert_eq!(cpo_bridge_cache_delay(2),8000);
    }
    #[test]fn signal_priority(){
        for (flags,want) in [(0,0),(1,3),(1|8,2),(1|4|8,1),(2|4,4),(4|16,1),(16,5)]{
            assert_eq!(cpo_bridge_error_signal(flags),want);
        }
    }
}
