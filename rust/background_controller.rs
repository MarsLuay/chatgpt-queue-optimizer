//! Background execution, response confirmation and checkpoint policy.
//! Browser effects are awaited outside Rust; each continuation revalidates
//! the original owner. Revision tracking never retains prompt contents.
use std::cell::RefCell;

#[no_mangle]
pub extern "C" fn cpo_background_click(flags:u32,now:f64,expiry:f64)->u32{
    // grant exists, token matches, unused, original owner still eligible.
    (flags&15==15&&now.is_finite()&&expiry.is_finite()&&now>=0.0&&now<=expiry) as u32
}
// 0 reset, 1 reset idle only, 2 existing-generation idle, 3 terminal,
// 4 unbound idle. The cursor stores two saturating 15-bit streaks, with
// bit 30 signaling the confirmation threshold was met.
#[no_mangle]
pub extern "C" fn cpo_background_wait_sample(cursor:u32,op:u32,needed:u32)->u32{
    let mut terminal=cursor&32767;
    let mut idle=(cursor>>15)&32767;
    let limit=needed.clamp(1,32767);
    let ready=match op{
        0=>{terminal=0;idle=0;false},
        1=>{idle=0;false},
        2|4=>{terminal=0;idle=idle.saturating_add(1).min(32767);idle>=limit},
        3=>{idle=0;terminal=terminal.saturating_add(1).min(32767);terminal>=limit},
        _=>return 0
    };
    terminal|(idle<<15)|((ready as u32)<<30)
}
// Valid positive timeout override or the configured default. Keep f64
// because these durations are also used by browser timers.
#[no_mangle]
pub extern "C" fn cpo_background_wait_timeout(flags:u32,ordinary:f64,research:f64)->f64{
    if flags&1!=0{f64::INFINITY}else if flags&6==6{research}else{ordinary}
}
#[no_mangle]
pub extern "C" fn cpo_background_wait_persist(flags:u32,elapsed:f64)->u32{
    // force=1, identical signal signature=2. Clock rollback never suppresses.
    (flags&1!=0||flags&2==0||!elapsed.is_finite()||elapsed<0.0||elapsed>=5000.0) as u32
}
struct Checkpoint{pending:Option<u64>,flight:Option<u64>,durable:Option<u64>}
impl Checkpoint{
    const fn new()->Self{Self{pending:None,flight:None,durable:None}}
    fn update(&mut self,rev:u64,flags:u32)->u32{
        let policy=(self.pending==Some(rev)) as u32|
            (((self.flight==Some(rev)) as u32)<<1)|
            (((self.durable==Some(rev)) as u32)<<2)|
            ((self.flight.is_none() as u32)<<3)|((flags&3)<<4);
        let action=super::cpo_persist_action(policy);
        match action{1=>self.pending=None,2..=4=>self.pending=Some(rev),_=>{}}
        action
    }
    fn control(&mut self,op:u32,rev:u64)->u32{
        match op{
            0=>self.pending.take().is_some() as u32,
            1=>{self.flight=Some(rev);1},
            2=>(self.durable==Some(rev)) as u32,
            3=>{self.durable=Some(rev);1},
            4=>{if self.flight==Some(rev){self.flight=None;}1},
            5=>{self.pending=None;1},
            _=>0
        }
    }
}
thread_local!{static CHECKPOINT:RefCell<Checkpoint>=const{RefCell::new(Checkpoint::new())};}
fn revision(value:f64)->Option<u64>{
    if value.is_finite()&&value>=0.0&&value<=9007199254740991.0&&value.fract()==0.0{Some(value as u64)}else{None}
}
#[no_mangle]
pub extern "C" fn cpo_background_checkpoint_update(rev:f64,flags:u32)->u32{
    let Some(rev)=revision(rev)else{return u32::MAX;};
    CHECKPOINT.with(|c|c.borrow_mut().update(rev,flags))
}
#[no_mangle]
pub extern "C" fn cpo_background_checkpoint(op:u32,rev:f64)->u32{
    let Some(rev)=revision(rev)else{return u32::MAX;};
    CHECKPOINT.with(|c|c.borrow_mut().control(op,rev))
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn checkpoint_coalescing_and_order(){
        let mut c=Checkpoint::new();
        assert_eq!(c.update(1,0),3);
        assert_eq!(c.update(1,2),0);
        assert_eq!(c.update(1,3),2);
        assert_eq!(c.control(0,0),1);
        c.control(1,1);assert_eq!(c.update(1,0),1);
        assert_eq!(c.update(2,1),2);c.control(0,0);c.control(1,2);
        c.control(3,1);c.control(4,1);
        assert_eq!(c.flight,Some(2));
        c.control(3,2);c.control(4,2);
        assert_eq!(c.update(2,0),1);
        assert_eq!(c.update(3,0),3);c.control(5,0);
        assert_eq!(c.control(0,0),0);
    }
    #[test]fn response_confirmation_is_consecutive(){
        let a=cpo_background_wait_sample(0,3,2);
        assert_eq!(a>>30,0);
        assert_eq!(cpo_background_wait_sample(a,3,2)>>30,1);
        let b=cpo_background_wait_sample(a,0,2);
        assert_eq!(cpo_background_wait_sample(b,3,2)>>30,0);
        assert_eq!(cpo_background_wait_sample(0,2,1)>>30,1);
        assert_eq!(cpo_background_click(15,10.0,10.0),1);
        assert_eq!(cpo_background_click(11,10.0,10.0),0);
        assert_eq!(cpo_background_click(15,11.0,10.0),0);
    }
}
