//! Background worker collections with bounded, call-local wire transfers.
//! IDs use JSON-escaped strings to preserve ECMAScript UTF-16 identity.
use std::{cell::RefCell,collections::{BTreeMap,BTreeSet,VecDeque}};
const MAX_FRAME:usize=8*1024*1024;
const MAX_LOG:usize=300;
const MAX_SESSIONS:usize=1024;
const MAX_BASELINE_BYTES:usize=16*1024*1024;
const NONE:u32=u32::MAX;
#[derive(Default)]
struct Worker{
    input:Vec<u8>,output:Vec<u8>,
    log:VecDeque<Vec<u8>>,log_bytes:usize,log_epoch:u32,
    next:u32,baseline:BTreeMap<u32,BTreeSet<Vec<u8>>>,baseline_bytes:usize,
    scheduled:BTreeMap<Vec<u8>,u32>,
}
fn fields(input:&[u8])->Option<Vec<&[u8]>>{
    let mut out=Vec::new();let mut at=0usize;
    while at<input.len(){
        let len=u32::from_le_bytes(input.get(at..at+4)?.try_into().ok()?) as usize;
        at+=4;let end=at.checked_add(len)?;
        out.push(input.get(at..end)?);at=end;
    }
    Some(out)
}
fn id(v:&[u8])->bool{v.len()>2&&v.first()==Some(&b'"')&&v.last()==Some(&b'"')&&v.len()<=16384}
impl Worker{
    fn token(&mut self)->Option<u32>{
        let n=self.next.checked_add(1).filter(|n|*n!=NONE)?;
        self.next=n;Some(n)
    }
    fn run(&mut self,op:u32,token:u32)->u32{
        self.output.fill(0);self.output.clear();
        let input=std::mem::take(&mut self.input);
        let Some(f)=fields(&input)else{return NONE;};
        match op{
            // Sanitized JSON object frames, retained only until flush.
            0=>{
                if f.len()!=1||f[0].first()!=Some(&b'{')||f[0].last()!=Some(&b'}')||f[0].len()>MAX_FRAME-16{return NONE;}
                while self.log.len()>=MAX_LOG||self.log_bytes+f[0].len()>MAX_FRAME-16{
                    let Some(old)=self.log.pop_front()else{return NONE;};self.log_bytes-=old.len();
                }
                self.log_bytes+=f[0].len();self.log.push_back(f[0].to_vec());1
            },
            1=>{
                self.output.push(b'[');
                while let Some(entry)=self.log.pop_front(){
                    if self.output.len()>1{self.output.push(b',');}
                    self.output.extend_from_slice(&entry);
                }
                self.output.push(b']');self.log_bytes=0;self.output.len() as u32
            },
            2=>{
                let Some(epoch)=self.log_epoch.checked_add(1).filter(|n|*n!=NONE)else{return NONE;};
                self.log.clear();self.log_bytes=0;self.log_epoch=epoch;epoch
            },
            3=>self.log_epoch,
            // Allocate a submission baseline. An empty baseline is valid.
            4=>{
                if self.baseline.len()>=MAX_SESSIONS||f.iter().any(|v|!id(v)){return NONE;}
                let ids:BTreeSet<Vec<u8>>=f.iter().map(|v|v.to_vec()).collect();
                let bytes=ids.iter().map(Vec::len).sum::<usize>();
                if self.baseline_bytes.saturating_add(bytes)>MAX_BASELINE_BYTES{return NONE;}
                let Some(n)=self.token()else{return NONE;};
                self.baseline_bytes+=bytes;self.baseline.insert(n,ids);n
            },
            // Each candidate is (turn ID, explicit text match, fallback match).
            // Explicit matches take priority even if a fallback precedes them.
            // Return one-based index, zero for no matching new turn.
            5=>{
                let Some(ids)=self.baseline.get(&token)else{return NONE;};
                if f.len()%3!=0{return NONE;}
                let mut fallback=0;
                for (i,row) in f.chunks_exact(3).enumerate(){
                    if !id(row[0])||ids.contains(row[0]){continue;}
                    if row[1]==b"1"{return i as u32+1;}
                    if fallback==0&&row[2]==b"1"{fallback=i as u32+1;}
                }
                fallback
            },
            6=>{
                if let Some(ids)=self.baseline.remove(&token){
                    self.baseline_bytes-=ids.iter().map(Vec::len).sum::<usize>();1
                }else{0}
            },
            // Native lease prevents a live scheduled delivery from being
            // reclassified as abandoned by concurrent startup recovery.
            7=>{
                if f.len()!=1||!id(f[0])||self.scheduled.len()>=MAX_SESSIONS||self.scheduled.contains_key(f[0]){return NONE;}
                let Some(n)=self.token()else{return NONE;};self.scheduled.insert(f[0].to_vec(),n);n
            },
            8=>{
                if f.len()!=1||self.scheduled.get(f[0])!=Some(&token){return 0;}
                self.scheduled.remove(f[0]);1
            },
            9=>if f.len()==1{self.scheduled.get(f[0]).copied().unwrap_or(0)}else{NONE},
            // Batch startup recovery: one action per item, in input order.
            // State and due are browser storage facts; lease ownership is
            // checked directly in Rust. Invalid frames never change state.
            10=>{
                if f.len()%2!=0{return NONE;}
                let mut actions=Vec::with_capacity(f.len()/2);
                for row in f.chunks_exact(2){
                    let state=std::str::from_utf8(row[1]).ok().and_then(|s|s.parse::<u32>().ok()).unwrap_or(NONE);
                    if state>5{return NONE;}
                    let action=super::cpo_schedule_action(5,state,0.0,0.0);
                    actions.push(if action==5&&self.scheduled.contains_key(row[0]){0}else{action});
                }
                self.output.push(b'[');
                for (i,action) in actions.iter().enumerate(){
                    if i!=0{self.output.push(b',');}
                    self.output.push(b'0'+*action as u8);
                }
                self.output.push(b']');self.output.len() as u32
            },
            // Upsert index: target ID, terminal flag, then pairs of
            // existing ID/state. Require exact active claim for settlement.
            // 0 append, 1..n replace, NONE reject.
            11=>{
                if f.len()<2||(f.len()-2)%2!=0||!id(f[0]){return NONE;}
                let terminal=match f[1]{b"0"=>false,b"1"=>true,_=>return NONE};
                if terminal&&(token==0||self.scheduled.get(f[0])!=Some(&token)){return NONE;}
                let mut found=None;
                for (i,row) in f[2..].chunks_exact(2).enumerate(){
                    if row[0]==f[0]{
                        if found.is_some(){return NONE;} // ambiguous persistent ID
                        if terminal&&row[1]!=b"2"{return NONE;}
                        found=Some(i as u32+1);
                    }
                }
                if terminal&&found.is_none(){return NONE;}
                found.unwrap_or(0)
            },
            12=>{
                let n=super::DURABLE_FIELDS.len();
                if f.len()<n+2{return NONE;}
                let now=std::str::from_utf8(f[0]).ok().and_then(|v|v.parse::<f64>().ok()).unwrap_or(f64::NAN);
                if !now.is_finite(){return NONE;}
                let Some(restored)=super::durable_projection::restore(&f[2..n+2],&f[n+2..],now,f[1])else{return NONE;};
                self.output=restored;u32::try_from(self.output.len()).unwrap_or(NONE)
            },
            13=>{
                let Some(result)=super::scheduled_transaction::transact(&f,token,&mut self.scheduled,&mut self.next)else{return NONE;};
                self.output=result;u32::try_from(self.output.len()).unwrap_or(NONE)
            },
            _=>NONE
        }
    }
}
thread_local!{static WORKER:RefCell<Worker>=RefCell::new(Worker::default());}
#[no_mangle]
pub extern "C" fn cpo_worker_input(len:u32)->usize{
    if len as usize>MAX_FRAME{return 0;}
    WORKER.with(|w|{let mut w=w.borrow_mut();w.input.resize(len as usize,0);w.input.as_mut_ptr() as usize})
}
#[no_mangle]
pub extern "C" fn cpo_worker_dispatch(op:u32,token:u32)->u32{WORKER.with(|w|w.borrow_mut().run(op,token))}
#[no_mangle]
pub extern "C" fn cpo_worker_output()->usize{WORKER.with(|w|w.borrow().output.as_ptr() as usize)}
#[no_mangle]
pub extern "C" fn cpo_worker_wipe(){
    WORKER.with(|w|{let mut w=w.borrow_mut();w.input.fill(0);w.input.clear();w.output.fill(0);w.output.clear();})
}
#[cfg(test)]
mod tests{
    use super::*;
    fn frame(w:&mut Worker,items:&[&[u8]]){
        w.input.clear();for item in items{w.input.extend_from_slice(&(item.len() as u32).to_le_bytes());w.input.extend_from_slice(item);}
    }
    #[test]fn log_ring_is_bounded_and_clear_invalidates(){
        let mut w=Worker::default();
        for i in 0..350{let row=format!("{{\"id\":{i}}}");frame(&mut w,&[row.as_bytes()]);assert_eq!(w.run(0,0),1);}
        assert_eq!(w.log.len(),300);
        assert!(w.run(1,0)>2);assert!(w.output.starts_with(b"[{\"id\":50},"));
        assert!(w.output.ends_with(b"{\"id\":349}]"));assert!(w.log.is_empty());
        assert_eq!(w.run(2,0),1);assert_eq!(w.run(3,0),1);
    }
    #[test]fn acknowledgements_and_claims_are_exact(){
        let mut w=Worker::default();
        frame(&mut w,&[b"\"old\""]);let t=w.run(4,0);assert_ne!(t,NONE);
        frame(&mut w,&[b"\"old\"",b"1",b"0",b"\"fallback\"",b"0",b"1",b"\"explicit\"",b"1",b"0"]);
        assert_eq!(w.run(5,t),3);
        assert_eq!(w.run(6,t),1);assert_eq!(w.baseline_bytes,0);
        frame(&mut w,&[b"\"schedule\""]);let a=w.run(7,0);assert_ne!(a,NONE);
        frame(&mut w,&[b"\"schedule\""]);assert_eq!(w.run(7,0),NONE);
        frame(&mut w,&[b"\"schedule\""]);assert_eq!(w.run(8,a+1),0);
        frame(&mut w,&[b"\"schedule\""]);assert_eq!(w.run(8,a),1);
        frame(&mut w,&[b"\"schedule\""]);assert_eq!(w.run(9,0),0);
    }
}
