//! Native projection of canonical live-job JSON scalars into durable JSON.
//! No external JSON dependency. The browser supplies JSON.stringify scalars
//! on mutation; legacy noncanonical values use the existing compatibility path.
use super::{DURABLE_FIELDS,cpo_durable_default,cpo_durable_number,cpo_durable_boolean};
use std::collections::VecDeque;
const NULL:&[u8]=b"null";
const EMPTY:&[u8]=b"\"\"";
const TRUE:&[u8]=b"true";
const FALSE:&[u8]=b"false";
const ZERO:&[u8]=b"0";
const MAX_SAFE:u64=9_007_199_254_740_991;
fn string(v:&[u8])->bool{v.len()>=2&&v.first()==Some(&b'"')&&v.last()==Some(&b'"')}
fn present(v:&[u8])->bool{!v.is_empty()&&v!=NULL&&v!=EMPTY&&v!=FALSE&&v!=ZERO}
fn numeric(v:&[u8])->Option<u64>{
    if v==NULL||v==EMPTY||v.is_empty(){return Some(0);}
    // Normal live state is numeric. Let legacy JS handle numeric strings,
    // including ECMAScript radix and whitespace conversions.
    if string(v){return None;}
    let n=std::str::from_utf8(v).ok()?.parse::<f64>().ok()?;
    let valid=cpo_durable_number(5,0,n,0.0);
    valid.is_finite().then_some(valid as u64)
}
fn body(v:&[u8])->Option<&[u8]>{if string(v){Some(&v[1..v.len()-1])}else{None}}
fn append(out:&mut Vec<u8>,first:&mut bool,name:&str,value:&[u8]){
    if !*first{out.push(b',');}*first=false;
    out.push(b'"');out.extend_from_slice(name.as_bytes());out.extend_from_slice(b"\":");out.extend_from_slice(value);
}
pub(super) fn project(fields:&[Option<Vec<u8>>],queue:&VecDeque<Vec<u8>>)->Option<Vec<u8>>{
    if fields.len()<DURABLE_FIELDS.len(){return None;}
    let read=|name:&str|DURABLE_FIELDS.iter().position(|f|f.name==name).and_then(|i|fields[i].as_deref()).unwrap_or(NULL);
    let id=read("conversationId");
    let flags=(present(id) as u32)|((read("targetKey")==b"\"chatgpt:new\"") as u32)<<1
        |((read("waitForIdleBeforeSend")==TRUE) as u32)<<2|((present(read("currentMessage")) as u32)<<3);
    let mut out=Vec::new();let mut first=true;out.push(b'{');
    let mut provider=b"\"chatgpt\"".to_vec();
    let mut kind=if present(id){b"\"existing\"".to_vec()}else{b"\"unknown\"".to_vec()};
    for (i,field) in DURABLE_FIELDS.iter().enumerate(){
        let v=fields[i].as_deref().unwrap_or(NULL);
        let rule=field.project;
        if rule==6{
            if queue.iter().any(|p|!string(p)){return None;}
            if !first{out.push(b',');}first=false;
            out.extend_from_slice(b"\"queue\":[");
            for (n,p) in queue.iter().enumerate(){if n!=0{out.push(b',');}out.extend_from_slice(p);}
            out.push(b']');continue;
        }
        let value=match rule{
            3|4|13|14=>{
                // Canonical booleans, absent/null, and legacy truthiness of
                // scalar strings/numbers. Non-scalar values fall back.
                if v!=TRUE&&v!=FALSE&&v!=NULL&&!string(v)&&numeric(v).is_none(){return None;}
                let b=(v==TRUE) as u32|(((v==FALSE) as u32)<<1)|((present(v) as u32)<<2);
                if cpo_durable_boolean(rule,0,b)==1{TRUE.to_vec()}else{FALSE.to_vec()}
            },
            5|16|17|18=>{
                if rule==16&&fields[i].is_none(){continue;}
                let mut n=numeric(v)?;
                if rule==18&&n==0{return None;}
                if rule==17{
                    let done=numeric(read("completedCount"))?;
                    let remaining=(queue.len() as u64).checked_add(present(read("currentMessage")) as u64)?;
                    let total=done.checked_add(remaining)?;
                    if total>MAX_SAFE{return None;}
                    n=n.max(total);
                }
                n.to_string().into_bytes()
            },
            1|2|7|8|9|10|11|12|15=>{
                if v!=NULL&&!string(v){return None;}
                if present(v){v.to_vec()}else{
                    match cpo_durable_default(rule,0,flags){
                        1=>EMPTY.to_vec(),2=>NULL.to_vec(),3=>b"\"chatgpt\"".to_vec(),
                        4=>b"\"existing\"".to_vec(),5=>b"\"new\"".to_vec(),6=>b"\"unknown\"".to_vec(),
                        7=>{
                            let mut key=vec![b'"'];key.extend_from_slice(body(&provider)?);key.push(b':');
                            if present(id){key.extend_from_slice(b"c:");key.extend_from_slice(body(id)?);}
                            else{key.extend_from_slice(body(&kind)?);}
                            key.push(b'"');key
                        },
                        9=>b"\"queued\"".to_vec(),
                        _=>return None
                    }
                }
            },
            _=>return None
        };
        if field.name=="provider"{provider=value.clone();}
        if field.name=="conversationType"{kind=value.clone();}
        append(&mut out,&mut first,field.name,&value);
    }
    out.push(b'}');Some(out)
}
#[cfg(test)]
mod tests{
    use super::*;
    fn set(f:&mut[Option<Vec<u8>>],name:&str,value:&[u8]){
        let i=DURABLE_FIELDS.iter().position(|f|f.name==name).unwrap();f[i]=Some(value.to_vec());
    }
    #[test]fn canonical_projection_defaults_and_queue_order(){
        let mut f=vec![None;DURABLE_FIELDS.len()+1];set(&mut f,"tabId",b"3");
        set(&mut f,"conversationId",b"\"a\\ud800\"");set(&mut f,"completedCount",b"4");
        set(&mut f,"currentMessage",b"\"current\"");set(&mut f,"isRunning",TRUE);
        let q=VecDeque::from([b"\"one\"".to_vec(),b"\"two\"".to_vec()]);
        let s=String::from_utf8(project(&f,&q).unwrap()).unwrap();
        assert!(s.contains("\"targetKey\":\"chatgpt:c:a\\ud800\""));
        assert!(s.contains("\"queue\":[\"one\",\"two\"]"));
        assert!(s.contains("\"totalMessages\":7"));assert!(s.contains("\"isRunning\":true"));
        assert!(!s.contains("\"startedAt\""));assert!(!s.contains("\"isProcessing\""));
        set(&mut f,"completedCount",b"\"4\"");assert!(project(&f,&q).is_none());
    }
}
