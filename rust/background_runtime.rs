//! Ephemeral background worker state. Browser timers, promises and tab
//! objects stay in the host; Rust owns leases and all acceptance decisions.
use std::{cell::RefCell,collections::BTreeMap};

pub(super) struct ResponseWait {
    pub token:u32,
    pub polling:bool,
    cursor:u32,
    last_log:f64,
    last_persist:f64,
    signature:Vec<Vec<u8>>,
    research_preview:Vec<u8>,
}
impl ResponseWait{
    pub fn new(token:u32,started:f64)->Self{
        Self{token,polling:false,cursor:0,last_log:started,last_persist:0.0,signature:Vec::new(),research_preview:b"\"\"".to_vec()}
    }
    pub fn sample(&mut self,op:u32,needed:u32)->u32{
        let packed=super::cpo_background_wait_sample(self.cursor,op,needed);
        self.cursor=packed&0x3fffffff;
        (packed>>30)&1
    }
    // Low byte: settlement action. Bit 8: confirmation reached.
    pub fn settle(&mut self,flags:u32,needed:u32)->u32{
        let action=super::cpo_wait_settle(flags);
        let confirmed=match action{
            1=>self.sample(1,1),
            2=>self.sample(2,if flags&64!=0{needed}else{1}),
            4=>self.sample(3,needed),
            5=>self.sample(4,needed),
            _=>self.sample(0,1)
        };
        action|(confirmed<<8)
    }
    // Exact JSON-escaped preview comparison, including lone surrogates.
    pub fn research_progress(&mut self,preview:Vec<u8>,force:bool)->bool{
        let changed=force||self.research_preview!=preview;
        if changed{
            self.research_preview.fill(0);
            self.research_preview=preview;
        }
        changed
    }
    pub fn progress_log(&mut self,now:f64)->u32{
        if now-self.last_log>30000.0{self.last_log=now;1}else{0}
    }
    pub fn persist(&mut self,force:bool,now:f64,fields:&[&[u8]])->bool{
        let same=self.signature.len()==fields.len()&&self.signature.iter().zip(fields).all(|(a,b)|a.as_slice()==*b);
        let flags=(force as u32)|((same as u32)<<1);
        if super::cpo_background_wait_persist(flags,now-self.last_persist)==0{return false;}
        if !same{
            // Keep exact field boundaries. No concatenated-string ambiguity,
            // hash collisions or whole-job JSON materialization.
            self.signature=fields.iter().map(|v|v.to_vec()).collect();
        }
        self.last_persist=now;true
    }
}

#[derive(Default)]
struct Grants { next:u32, active:BTreeMap<u32,Grant> }
struct Grant{lease:u32,expiry:f64,used:bool}
impl Grants{
    fn control(&mut self,op:u32,tab:u32,lease:u32,flags:u32,now:f64)->u32{
        match op{
            0=>{
                if tab==0||!now.is_finite()||now<0.0||self.active.contains_key(&tab){return 0;}
                let Some(next)=self.next.checked_add(1)else{return 0;};
                let expiry=now+15000.0;
                if !expiry.is_finite(){return 0;}
                self.next=next;self.active.insert(tab,Grant{lease:next,expiry,used:false});next
            },
            1=>{
                let Some(grant)=self.active.get_mut(&tab)else{return 0;};
                if grant.lease!=lease{return 0;}
                let facts=1|((flags&1)<<1)|((!grant.used as u32)<<2)|((flags&2)<<2);
                if super::cpo_background_click(facts,now,grant.expiry)==1{grant.used=true;1}else{0}
            },
            2=>{
                if self.active.get(&tab).is_some_and(|g|g.lease==lease){self.active.remove(&tab);1}else{0}
            },
            3=>self.active.remove(&tab).is_some() as u32,
            4=>{self.active.clear();1},
            _=>0
        }
    }
}
#[derive(Default)]
struct Restore{next:u32,active:u32}
impl Restore{
    fn control(&mut self,op:u32,token:u32)->u32{
        match op{
            0 if self.active==0=>{
                let Some(next)=self.next.checked_add(1)else{return 0;};
                self.next=next;self.active=next;next
            },
            1=>(token!=0&&self.active==token) as u32,
            2=>{if token!=0&&self.active==token{self.active=0;1}else{0}},
            3=>{self.active=0;1},
            4=>(self.active!=0) as u32,
            _=>0
        }
    }
}
thread_local!{
    static GRANTS:RefCell<Grants>=RefCell::new(Grants::default());
    static RESTORE:RefCell<Restore>=RefCell::new(Restore::default());
}
#[no_mangle]
pub extern "C" fn cpo_background_grant(op:u32,tab:u32,lease:u32,flags:u32,now:f64)->u32{
    GRANTS.with(|g|g.borrow_mut().control(op,tab,lease,flags,now))
}
#[no_mangle]
pub extern "C" fn cpo_background_restore(op:u32,token:u32)->u32{
    RESTORE.with(|r|r.borrow_mut().control(op,token))
}
// Poll admission: owner exists=1, running and unpaused=2,
// unlimited=4, research-aware=8, research observed=16.
// 0 poll, 1 stopped/replaced, 2 paused, 3 timeout, 4 stalled research.
#[no_mangle]
pub extern "C" fn cpo_background_poll_gate(flags:u32,elapsed:f64,ordinary:f64,research:f64,stale_elapsed:f64,stale_limit:f64)->u32{
    if flags&1==0{return 1;}
    if flags&2==0{return 2;}
    let max=super::cpo_background_wait_timeout((flags>>2)&7,ordinary,research);
    if elapsed>max{return 3;}
    if flags&28==24&&stale_elapsed>stale_limit{return 4;}
    0
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn settlement_and_research_progress(){
        let mut w=ResponseWait::new(1,0.0);
        let terminal=8|16|32;
        assert_eq!(w.settle(terminal,2),4);
        assert_eq!(w.settle(terminal,2),4|256);
        assert_eq!(w.settle(4|8,2),3);
        assert_eq!(w.settle(terminal,2),4);
        assert_eq!(w.settle(1,3),2|256);
        assert!(!w.research_progress(b"\"\"".to_vec(),false));
        assert!(w.research_progress(b"\"\\ud800\"".to_vec(),false));
        assert!(!w.research_progress(b"\"\\ud800\"".to_vec(),false));
        assert!(w.research_progress(b"\"\\ud800\"".to_vec(),true));
    }
    #[test]fn exact_heartbeat_and_poll_samples(){
        let mut w=ResponseWait::new(1,1000.0);
        assert!(w.persist(false,1000.0,&[b"a|b",b"c"]));
        assert!(!w.persist(false,1001.0,&[b"a|b",b"c"]));
        assert!(w.persist(false,1002.0,&[b"a",b"b|c"]));
        assert!(w.persist(true,1003.0,&[b"a",b"b|c"]));
        assert!(w.persist(false,6003.0,&[b"a",b"b|c"]));
        assert_eq!(w.sample(3,2),0);assert_eq!(w.sample(3,2),1);
        assert_eq!(w.progress_log(31000.0),0);assert_eq!(w.progress_log(31001.0),1);
    }
    #[test]fn grants_expire_and_never_replay(){
        let mut g=Grants::default();let a=g.control(0,2,0,0,1000.0);
        assert_ne!(a,0);assert_eq!(g.control(0,2,0,0,1001.0),0);
        assert_eq!(g.control(1,2,a,1,1002.0),0);
        assert_eq!(g.control(1,2,a,3,1002.0),1);
        assert_eq!(g.control(1,2,a,3,1003.0),0);
        assert_eq!(g.control(2,2,a,0,0.0),1);
        let b=g.control(0,2,0,0,2000.0);
        assert_ne!(a,b);assert_eq!(g.control(2,2,a,0,0.0),0);
        assert_eq!(g.control(1,2,b,3,17001.0),0);
        g.control(4,0,0,0,0.0);assert_eq!(g.control(1,2,b,3,2001.0),0);
    }
    #[test]fn restore_and_poll_are_fail_closed(){
        let mut r=Restore::default();let a=r.control(0,0);
        assert_eq!(r.control(0,0),0);assert_eq!(r.control(1,a),1);
        r.control(3,0);let b=r.control(0,0);
        assert_ne!(a,b);assert_eq!(r.control(2,a),0);assert_eq!(r.control(1,b),1);
        assert_eq!(cpo_background_poll_gate(0,0.,10.,100.,0.,20.),1);
        assert_eq!(cpo_background_poll_gate(1,0.,10.,100.,0.,20.),2);
        assert_eq!(cpo_background_poll_gate(3,11.,10.,100.,0.,20.),3);
        assert_eq!(cpo_background_poll_gate(27,11.,10.,100.,21.,20.),4);
        assert_eq!(cpo_background_poll_gate(31,1000.,10.,100.,1000.,20.),0);
    }
}
