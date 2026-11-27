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
struct Row<'a>{id:&'a[u8],state:u32,due:f64,created:f64,raw:std::borrow::Cow<'a,[u8]>,effect:u8,selected:bool}
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
// Frame: operation, target JSON ID, now, retry due, optional replacement
// record (for upsert), followed by (ID,state,due,created,record) tuples.
// Result: code, sorted records, selected index, alarm actions and optional
// claim. The only persistent native state is an actual in-flight claim.
pub(super) fn transact(f:&[&[u8]],token:u32,leases:&mut BTreeMap<Vec<u8>,u32>,next_token:&mut u32)->Option<Vec<u8>>{
    if f.len()<5||(f.len()-5)%5!=0{return None;}
    let op=state(f[0])?;
    if op==0{return None;}
    let target=f[1];let now=num(f[2])?;if now<=0.0{return None;}
    let next=num(f[3])?;
    let mut rows=Vec::with_capacity((f.len()-5)/5);
    for v in f[5..].chunks_exact(5){
        if v[4].first()!=Some(&b'{')||v[4].last()!=Some(&b'}'){return None;}
        rows.push(Row{id:v[0],state:state(v[1])?,due:num(v[2])?,created:num(v[3])?,raw:std::borrow::Cow::Borrowed(v[4]),effect:0,selected:false});
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
        _=>return None
    }
    rows.sort_by(|a,b|match super::cpo_schedule_compare(a.due,b.due,a.created,b.created){
        0=>Ordering::Less,2=>Ordering::Greater,_=>Ordering::Equal
    });
    let selected=rows.iter().position(|r|r.selected).map_or(-1,|i|i as i64);
    let mut out=format!("{{\"code\":1,\"changed\":{changed},\"claim\":{claim},\"index\":{selected},\"clearDeleted\":{clear_deleted},\"items\":[").into_bytes();
    for (i,row) in rows.iter().enumerate(){if i!=0{out.push(b',');}out.extend_from_slice(&row.raw);}
    out.extend_from_slice(b"],\"effects\":[");
    for (i,row) in rows.iter().enumerate(){if i!=0{out.push(b',');}out.push(b'0'+row.effect);}
    out.extend_from_slice(b"]}");
    if claim!=0{*next_token=claim;leases.insert(target.to_vec(),claim);}
    let _=token;
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
