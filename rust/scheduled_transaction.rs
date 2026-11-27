//! Transaction-scoped scheduler. Browser storage remains the durable authority;
//! native records are discarded immediately after an authorized result.
//! JSON fields are browser-produced; preserve unknown legacy fields verbatim.
use std::{collections::BTreeMap,cmp::Ordering};
const NONE:u32=u32::MAX;
const RESTART:&[u8]=b"\"Delivery interrupted by background restart. Retry only if the message is not already queued.\"";
fn num(v:&[u8])->Option<f64>{let n=std::str::from_utf8(v).ok()?.parse::<f64>().ok()?;n.is_finite().then_some(n)}
fn state(v:&[u8])->Option<u32>{let n=std::str::from_utf8(v).ok()?.parse::<u32>().ok()?;(n<=5).then_some(n)}
fn key(v:&[u8])->bool{v.len()>2&&v.len()<=16384&&v.first()==Some(&b'"')&&v.last()==Some(&b'"')}
fn skip_space(b:&[u8],i:&mut usize){while b.get(*i).is_some_and(|c|c.is_ascii_whitespace()){*i+=1;}}
fn string_end(b:&[u8],i:&mut usize)->Option<()>{
    if *b.get(*i)?!=b'"'{return None;}*i+=1;
    loop{match *b.get(*i)?{b'"'=>{*i+=1;return Some(());},b'\\'=>{*i+=2;},_=>*i+=1}}
}
// Scan one JSON value without decoding strings or nested records. Depth and
// frame size are bounded; only structured-clone-compatible JSON is passed.
fn value_end(b:&[u8],i:&mut usize)->Option<()>{
    skip_space(b,i);
    match *b.get(*i)?{
        b'"'=>string_end(b,i),
        b'{'|b'['=>{
            let mut stack=Vec::new();
            loop{
                match *b.get(*i)?{
                    b'"'=>{string_end(b,i)?;continue;},
                    b'{'=>stack.push(b'}'),b'['=>stack.push(b']'),
                    c @ (b'}'|b']')=>{if stack.pop()!=Some(c){return None;}if stack.is_empty(){*i+=1;return Some(());}},
                    _=>{}
                }
                if stack.len()>128{return None;}*i+=1;
            }
        },
        _=>{let start=*i;while b.get(*i).is_some_and(|c|!matches!(*c,b','|b'}'|b']')&&!c.is_ascii_whitespace()){*i+=1;}(*i>start).then_some(())}
    }
}
fn patch(raw:&[u8],updates:&[(&str,&[u8])])->Option<Vec<u8>>{
    let mut i=0;skip_space(raw,&mut i);if *raw.get(i)?!=b'{'{return None;}i+=1;
    let mut out=vec![b'{'];let mut first=true;
    let emit=|out:&mut Vec<u8>,first:&mut bool,k:&[u8],v:&[u8]|{
        if !*first{out.push(b',');}*first=false;out.extend_from_slice(k);out.push(b':');out.extend_from_slice(v);
    };
    loop{
        skip_space(raw,&mut i);
        if *raw.get(i)?==b'}'{i+=1;break;}
        let ks=i;string_end(raw,&mut i)?;let ke=i;
        skip_space(raw,&mut i);if *raw.get(i)?!=b':'{return None;}i+=1;
        skip_space(raw,&mut i);let vs=i;value_end(raw,&mut i)?;let ve=i;
        let k=&raw[ks..ke];
        if !updates.iter().any(|(name,_)|k.len()==name.len()+2&&&k[1..k.len()-1]==name.as_bytes()){
            emit(&mut out,&mut first,k,&raw[vs..ve]);
        }
        skip_space(raw,&mut i);
        match *raw.get(i)?{b','=>i+=1,b'}'=>{i+=1;break;},_=>return None}
    }
    skip_space(raw,&mut i);if i!=raw.len(){return None;}
    for (name,value) in updates{
        let mut k=vec![b'"'];k.extend_from_slice(name.as_bytes());k.push(b'"');
        emit(&mut out,&mut first,&k,value);
    }
    out.push(b'}');Some(out)
}
struct Row<'a>{id:&'a[u8],state:u32,due:f64,created:f64,raw:std::borrow::Cow<'a,[u8]>,effect:u8,selected:bool,original:Option<usize>}
impl Row<'_>{
    fn transition(&mut self,op:u32,now:f64,next:f64,reason:&[u8])->Option<()>{
        let now_text=now.to_string();let next_text=next.to_string();
        let (status,why,new_state)=match op{
            1=>(b"\"cancelled\"".as_slice(),b"\"\"".as_slice(),5),
            3=>(b"\"pending\"".as_slice(),b"\"\"".as_slice(),1),
            4=>(b"\"firing\"".as_slice(),b"\"\"".as_slice(),2),
            5=>(b"\"failed\"".as_slice(),RESTART,4),
            _=>return None
        };
        let mut updates=vec![("status",status),("failureReason",why),("updatedAt",now_text.as_bytes())];
        if op==3{updates.push(("dueTs",next_text.as_bytes()));self.due=next;}
        if op==4{updates.push(("fireAttemptedAt",now_text.as_bytes()));}
        let _=reason;
        self.raw=std::borrow::Cow::Owned(patch(&self.raw,&updates)?);
        self.state=new_state;Some(())
    }
}
fn error(code:u32)->Vec<u8>{format!("{{\"code\":{code}}}").into_bytes()}
// Frame: operation, target JSON ID, now, retry/creation due or completion
// flags, payload (creation facts, failure reason or optional remaining count),
// followed by (ID,state,due,created,record) tuples.
// Result: code, sorted records, selected index, alarm actions and optional
// claim. The only persistent native state is an actual in-flight claim.
pub(super) fn transact(f:&[&[u8]],token:u32,leases:&mut BTreeMap<Vec<u8>,u32>,next_token:&mut u32)->Option<Vec<u8>>{
    transact_mode(f,token,leases,next_token,false)
}
pub(super) fn transact_sparse(f:&[&[u8]],token:u32,leases:&mut BTreeMap<Vec<u8>,u32>,next_token:&mut u32)->Option<Vec<u8>>{
    transact_mode(f,token,leases,next_token,true)
}
fn transact_mode(f:&[&[u8]],token:u32,leases:&mut BTreeMap<Vec<u8>,u32>,next_token:&mut u32,sparse:bool)->Option<Vec<u8>>{
    if f.len()<5||(f.len()-5)%5!=0{return None;}
    let op=std::str::from_utf8(f[0]).ok()?.parse::<u32>().ok()?;
    if !(1..=8).contains(&op){return None;}
    let target=f[1];let now=num(f[2])?;if now<=0.0{return None;}
    let next=num(f[3])?;
    let mut rows=Vec::with_capacity((f.len()-5)/5);
    for (i,v) in f[5..].chunks_exact(5).enumerate(){
        let state=state(v[1])?;
        let required=!sparse||if op==5{state==2&&!leases.contains_key(v[0])}else{matches!(op,1|3|4|7|8)&&v[0]==target};
        if required||!v[4].is_empty(){
            if v[4].first()!=Some(&b'{')||v[4].last()!=Some(&b'}'){return None;}
        }
        rows.push(Row{id:v[0],state,due:num(v[2])?,created:num(v[3])?,raw:std::borrow::Cow::Borrowed(v[4]),effect:0,selected:false,original:Some(i)});
    }
    let mut found=None;
    if op!=5{
        if !key(target){return Some(error(0));}
        for (i,row) in rows.iter().enumerate(){
            if row.id==target{if found.is_some(){return Some(error(7));}found=Some(i);}
        }
    }
    let mut claim=0;let mut changed=true;let mut clear_deleted=false;
    match op{
        1|2|3|4=>{
            let Some(i)=found else{return Some(error(0));};
            let action=super::cpo_schedule_action(op,rows[i].state,rows[i].due,now);
            if action!=1{return Some(error(action));}
            if op==3&&super::cpo_timestamp_valid(next)!=1{return Some(error(6));}
            if op==4{
                if leases.contains_key(target)||leases.len()>=1024{return Some(error(3));}
                claim=next_token.checked_add(1).filter(|v|*v!=NONE)?;
            }
            if op==2{rows.remove(i);clear_deleted=true;}
            else{
                rows[i].transition(op,now,next,b"")?;
                rows[i].selected=true;
                rows[i].effect=if op==1{1}else if op==3{2}else{0};
            }
        },
        5=>{
            changed=false;
            for row in &mut rows{
                match super::cpo_schedule_action(5,row.state,row.due,now){
                    5 if !leases.contains_key(row.id)=>{row.transition(5,now,next,b"")?;row.effect=1;changed=true;},
                    4=>row.effect=2,
                    _=>{}
                }
            }
        },
        6=>{ // create, never overwrite an existing record
            if found.is_some()||leases.contains_key(target){return Some(error(7));}
            if super::cpo_timestamp_valid(next)!=1{return Some(error(6));}
            let due=next.to_string();let time=now.to_string();
            let raw=patch(f[4],&[("id",target),("status",b"\"pending\""),("failureReason",b"\"\""),
                ("dueTs",due.as_bytes()),("createdAt",time.as_bytes()),("updatedAt",time.as_bytes())])?;
            rows.push(Row{id:target,state:1,due:next,created:now,raw:std::borrow::Cow::Owned(raw),effect:2,selected:true,original:None});
        },
        7|8=>{ // terminal settlement must match a live claim and firing row
            let Some(i)=found else{return Some(error(0));};
            if rows[i].state!=2||token==0||leases.get(target)!=Some(&token){return Some(error(7));}
            let time=now.to_string();
            let raw=if op==7{
                let reason=if f[4]==b"\"\""||f[4].is_empty(){b"\"Scheduled delivery failed.\"".as_slice()}else{f[4]};
                if reason.first()!=Some(&b'"')||reason.last()!=Some(&b'"'){return None;}
                patch(&rows[i].raw,&[("status",b"\"failed\""),("failureReason",reason),("updatedAt",time.as_bytes())])?
            }else{
                if !(0.0..=15.0).contains(&next)||next.fract()!=0.0{return None;}
                let flags=next as u32;
                let mut result=format!("{{\"queued\":{},\"started\":{},\"paused\":{},\"waitingForIdle\":{}",
                    flags&1!=0,flags&2!=0,flags&4!=0,flags&8!=0).into_bytes();
                if !f[4].is_empty(){
                    let remaining=num(f[4])?;
                    if remaining<0.0||remaining.fract()!=0.0||remaining>9007199254740991.0{return None;}
                    result.extend_from_slice(b",\"remaining\":");result.extend_from_slice(remaining.to_string().as_bytes());
                }
                result.push(b'}');
                patch(&rows[i].raw,&[("status",b"\"completed\""),("failureReason",b"\"\""),("updatedAt",time.as_bytes()),
                    ("completedAt",time.as_bytes()),("enqueueResult",&result)])?
            };
            rows[i].raw=std::borrow::Cow::Owned(raw);rows[i].state=if op==7{4}else{3};
            rows[i].selected=true;rows[i].effect=1;
            // Host releases only after durable storage has succeeded or the
            // enclosing delivery fails. A rejected commit cannot authorize a new send.
        },
        _=>return None
    }
    rows.sort_by(|a,b|match super::cpo_schedule_compare(a.due,b.due,a.created,b.created){
        0=>Ordering::Less,2=>Ordering::Greater,_=>Ordering::Equal
    });
    let selected=rows.iter().position(|r|r.selected).map_or(-1,|i|i as i64);
    let mut out=format!("{{\"code\":1,\"changed\":{changed},\"claim\":{claim},\"index\":{selected},\"clearDeleted\":{clear_deleted},\"items\":[").into_bytes();
    for (i,row) in rows.iter().enumerate(){
        if i!=0{out.push(b',');}
        if sparse{
            match (&row.raw,row.original){
                (std::borrow::Cow::Borrowed(_),Some(index))=>out.extend_from_slice(index.to_string().as_bytes()),
                (std::borrow::Cow::Owned(record),_)=>out.extend_from_slice(record),
                _=>return None
            }
        }else{out.extend_from_slice(&row.raw);}
    }
    out.extend_from_slice(b"],\"effects\":[");
    for (i,row) in rows.iter().enumerate(){if i!=0{out.push(b',');}out.push(b'0'+row.effect);}
    out.extend_from_slice(b"]}");
    if claim!=0{*next_token=claim;leases.insert(target.to_vec(),claim);}
    Some(out)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn patch_keeps_nested_unknown_fields(){
        let raw=br#"{"id":"a","status":"pending","other":{"nested":[1,{"q":"a\"b"}]},"text":"\ud800"}"#;
        let result=patch(raw,&[("status",b"\"firing\""),("updatedAt",b"10")]).unwrap();
        let s=String::from_utf8(result).unwrap();
        assert!(s.contains(r#""other":{"nested":[1,{"q":"a\"b"}]}"#));
        assert!(s.contains(r#""text":"\ud800""#));assert!(s.contains(r#""status":"firing""#));
        assert!(!s.contains("pending"));
    }
    #[test]fn creation_and_terminal_settlement_require_exact_owner(){
        let mut leases=BTreeMap::new();let mut next=0;
        let created=[b"6".as_slice(),b"\"a\"",b"10",b"20",br#"{"text":"hello","tabId":1}"#];
        let result=String::from_utf8(transact(&created,0,&mut leases,&mut next).unwrap()).unwrap();
        assert!(result.contains("\"status\":\"pending\""));assert!(result.contains("\"dueTs\":20"));
        let row=br#"{"id":"a","status":"firing","dueTs":20,"text":"hello","createdAt":10}"#;
        let terminal=[b"8".as_slice(),b"\"a\"",b"21",b"9",b"2",b"\"a\"",b"2",b"20",b"10",row];
        assert_eq!(transact(&terminal,1,&mut leases,&mut next).unwrap(),b"{\"code\":7}");
        leases.insert(b"\"a\"".to_vec(),1);
        let result=String::from_utf8(transact(&terminal,1,&mut leases,&mut next).unwrap()).unwrap();
        assert!(result.contains("\"status\":\"completed\""));
        assert!(result.contains("\"enqueueResult\":{\"queued\":true,\"started\":false,\"paused\":false,\"waitingForIdle\":true,\"remaining\":2}"));
        assert!(result.contains("\"completedAt\":21"));
        assert_eq!(leases.get(b"\"a\"".as_slice()),Some(&1));
    }
    #[test]fn claim_is_single_use_and_not_early(){
        let mut leases=BTreeMap::new();let mut next=0;
        let base=[b"4".as_slice(),b"\"a\"",b"9",b"0",b"",b"\"a\"",b"1",b"10",b"1",br#"{"id":"a","status":"pending","dueTs":10}"#];
        assert_eq!(transact(&base,0,&mut leases,&mut next).unwrap(),b"{\"code\":4}");
        let mut due=base;due[2]=b"10";
        let result=transact(&due,0,&mut leases,&mut next).unwrap();
        assert!(String::from_utf8(result).unwrap().contains("\"claim\":1"));assert_eq!(leases.get(b"\"a\"".as_slice()),Some(&1));
        assert_eq!(transact(&due,0,&mut leases,&mut next).unwrap(),b"{\"code\":3}");
    }
}
