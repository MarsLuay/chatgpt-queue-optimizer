//! Native projection of canonical live-job JSON scalars into durable JSON.
//! No external JSON dependency. The browser supplies JSON.stringify scalars
//! on mutation; unusual legacy numeric strings use the existing compatibility path.
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
    let decoded;
    let text=if string(v){decoded=decode_numeric_string(v)?;decoded.as_str()}else{std::str::from_utf8(v).ok()?};
    let n=if text.is_empty(){0.0}
        else if let Some(digits)=text.strip_prefix("0x").or_else(||text.strip_prefix("0X")){radix(digits,16)?}
        else if let Some(digits)=text.strip_prefix("0b").or_else(||text.strip_prefix("0B")){radix(digits,2)?}
        else if let Some(digits)=text.strip_prefix("0o").or_else(||text.strip_prefix("0O")){radix(digits,8)?}
        else{text.parse::<f64>().ok()?};
    let valid=cpo_durable_number(5,0,n,0.0);
    valid.is_finite().then_some(valid as u64)
}
fn radix(s:&str,base:u32)->Option<f64>{
    if s.is_empty(){return None;}
    let mut n=0u64;for c in s.chars(){n=n.checked_mul(base as u64)?.checked_add(c.to_digit(base)? as u64)?;if n>MAX_SAFE{return None;}}
    Some(n as f64)
}
fn decode_numeric_string(v:&[u8])->Option<String>{
    let v=trim_json(v)?;let text=std::str::from_utf8(body(&v)?).ok()?;
    let mut chars=text.chars();let mut out=Vec::new();
    while let Some(c)=chars.next(){
        if c!='\\'{let mut units=[0;2];out.extend_from_slice(c.encode_utf16(&mut units));continue;}
        let unit=match chars.next()?{
            'u'=>{let mut n=0u16;for _ in 0..4{n=(n<<4)|chars.next()?.to_digit(16)? as u16;}n},
            't'=>9,'n'=>10,'r'=>13,'f'=>12,'b'=>8,'"'=>34,'\\'=>92,'/'=>47,_=>return None
        };
        out.push(unit);
    }
    String::from_utf16(&out).ok()
}
fn body(v:&[u8])->Option<&[u8]>{if string(v){Some(&v[1..v.len()-1])}else{None}}
fn append(out:&mut Vec<u8>,first:&mut bool,name:&str,value:&[u8]){
    if !*first{out.push(b',');}*first=false;
    out.push(b'"');out.extend_from_slice(name.as_bytes());out.extend_from_slice(b"\":");out.extend_from_slice(value);
}
// Scan JSON string tokens rather than decode/re-encode the string. This
// preserves lone surrogate escapes and all interior bytes from JSON.stringify.
fn trim_json(v:&[u8])->Option<Vec<u8>>{
    let text=std::str::from_utf8(body(v)?).ok()?;
    let bytes=text.as_bytes();
    let (mut i,mut first,mut last)=(0usize,None,0usize);
    while i<bytes.len(){
        let start=i;
        let space=if bytes[i]==b'\\'{
            let escape=*bytes.get(i+1)?;i+=2;
            let unit=match escape{
                b'u'=>{let hex=text.get(i..i+4)?;i+=4;u16::from_str_radix(hex,16).ok()?},
                b't'=>9,b'n'=>10,b'v'=>11,b'f'=>12,b'r'=>13,b'b'=>8,
                b'"'=>34,b'\\'=>92,b'/'=>47,_=>return None
            };
            super::whitespace(unit)
        }else{
            let c=text.get(i..)?.chars().next()?;i+=c.len_utf8();
            (c as u32)<=u16::MAX as u32&&super::whitespace(c as u16)
        };
        if !space{if first.is_none(){first=Some(start);}last=i;}
    }
    let mut out=vec![b'"'];
    if let Some(start)=first{out.extend_from_slice(bytes.get(start..last)?);}
    out.push(b'"');Some(out)
}
pub(super) fn restore(fields:&[&[u8]],prompts:&[&[u8]],now:f64,run_id:&[u8])->Option<Vec<u8>>{
    if fields.len()!=DURABLE_FIELDS.len(){return None;}
    let mut scalars:Vec<Option<Vec<u8>>>=fields.iter().map(|v|if v.is_empty(){None}else{Some(v.to_vec())}).collect();
    let current=DURABLE_FIELDS.iter().position(|f|f.name=="currentMessage")?;
    if let Some(v)=scalars[current].as_deref(){
        if v!=NULL{scalars[current]=Some(trim_json(v)?);}
    }
    let mut queue=VecDeque::new();
    for prompt in prompts{
        let text=trim_json(prompt)?;
        if text!=EMPTY{queue.push_back(text);}
    }
    project_mode(&scalars,&queue,1,now,run_id)
}
pub(super) fn project(fields:&[Option<Vec<u8>>],queue:&VecDeque<Vec<u8>>)->Option<Vec<u8>>{
    project_mode(fields,queue,0,0.0,EMPTY)
}
fn project_mode(fields:&[Option<Vec<u8>>],queue:&VecDeque<Vec<u8>>,mode:u32,now:f64,run_id:&[u8])->Option<Vec<u8>>{
    if fields.len()<DURABLE_FIELDS.len(){return None;}
    let read=|name:&str|DURABLE_FIELDS.iter().position(|f|f.name==name).and_then(|i|fields[i].as_deref()).unwrap_or(NULL);
    let id=read("conversationId");
    if mode==1&&super::cpo_restore_eligible(numeric(read("tabId"))? as f64,u32::try_from(queue.len()).ok()?,present(read("currentMessage")) as u32,(read("isStopped")==TRUE) as u32)!=1{return None;}
    let flags=(present(id) as u32)|((read("targetKey")==b"\"chatgpt:new\"") as u32)<<1
        |((read("waitForIdleBeforeSend")==TRUE) as u32)<<2|((present(read("currentMessage")) as u32)<<3);
    let mut out=Vec::new();let mut first=true;out.push(b'{');
    let mut provider=b"\"chatgpt\"".to_vec();
    let mut kind=if present(id){b"\"existing\"".to_vec()}else{b"\"unknown\"".to_vec()};
    for (i,field) in DURABLE_FIELDS.iter().enumerate(){
        let v=fields[i].as_deref().unwrap_or(NULL);
        let rule=if mode==0{field.project}else{field.restore};
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
                if mode==1&&(v!=TRUE&&v!=FALSE&&v!=NULL||rule==14&&v==TRUE){return None;}
                if v!=TRUE&&v!=FALSE&&v!=NULL&&!string(v)&&numeric(v).is_none(){return None;}
                let b=(v==TRUE) as u32|(((v==FALSE) as u32)<<1)|((present(v) as u32)<<2)|(((read("isPaused")==TRUE) as u32)<<3);
                if cpo_durable_boolean(rule,mode,b)==1{TRUE.to_vec()}else{FALSE.to_vec()}
            },
            5|16|17|18=>{
                if mode==0&&rule==16&&fields[i].is_none(){continue;}
                let raw=numeric(v)?;
                let normalized=cpo_durable_number(rule,mode,raw as f64,now);
                if !normalized.is_finite(){return None;}
                let mut n=normalized as u64;
                if rule==17{
                    let done=numeric(read("completedCount"))?;
                    let remaining=(queue.len() as u64).checked_add(present(read("currentMessage")) as u64)?;
                    let total=done.checked_add(remaining)?;
                    if total>MAX_SAFE{return None;}
                    n=n.max(total);
                }
                if mode==1&&field.name=="currentCommandNumber"&&n==0&&present(read("currentMessage")){
                    n=numeric(read("completedCount"))?.checked_add(1)?;
                    if n>MAX_SAFE{return None;}
                }
                n.to_string().into_bytes()
            },
            1|2|7|8|9|10|11|12|15=>{
                if v!=NULL&&!string(v){return None;}
                if rule==15&&mode==1&&v!=b"\"finite\""&&v!=b"\"unlimited\""{EMPTY.to_vec()}
                else if present(v){v.to_vec()}else{
                    match cpo_durable_default(rule,mode,flags){
                        1=>EMPTY.to_vec(),2=>NULL.to_vec(),3=>b"\"chatgpt\"".to_vec(),
                        4=>b"\"existing\"".to_vec(),5=>b"\"new\"".to_vec(),6=>b"\"unknown\"".to_vec(),
                        7=>{
                            let mut key=vec![b'"'];key.extend_from_slice(body(&provider)?);key.push(b':');
                            if present(id){key.extend_from_slice(b"c:");key.extend_from_slice(body(id)?);}
                            else{key.extend_from_slice(body(&kind)?);}
                            key.push(b'"');key
                        },
                        8 if string(run_id)&&present(run_id)=>run_id.to_vec(),
                        9=>b"\"queued\"".to_vec(),
                        10=>b"\"waiting-for-idle\"".to_vec(),
                        11=>b"\"waiting\"".to_vec(),
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
    #[test]fn restoration_trims_only_ecmascript_edges(){
        let mut f=vec![None;DURABLE_FIELDS.len()+1];
        set(&mut f,"tabId",b"8");set(&mut f,"targetKey",b"\"chatgpt:new\"");
        set(&mut f,"completedCount",b"4");set(&mut f,"currentMessage",b"\"\\t\\uFEFFcurrent\\r\"");
        set(&mut f,"isPaused",TRUE);set(&mut f,"retryMode",b"\"old-mode\"");
        let raw:Vec<_>=f[..DURABLE_FIELDS.len()].iter().map(|v|v.as_deref().unwrap_or(b"")).collect();
        let s=String::from_utf8(restore(&raw,&[b"\"\\u00a0\\t\"",b"\"\\t\\ud800 inside \\n\""],1000.0,b"\"run\"").unwrap()).unwrap();
        assert!(s.contains("\"queue\":[\"\\ud800 inside\"]"));
        assert!(s.contains("\"currentMessage\":\"current\""));assert!(s.contains("\"currentCommandNumber\":5"));
        assert!(s.contains("\"isRunning\":false"));assert!(s.contains("\"retryMode\":\"\""));
        assert!(s.contains("\"conversationType\":\"new\""));assert!(s.contains("\"startedAt\":1000"));
        assert!(s.contains("\"runId\":\"run\""));
        assert_eq!(trim_json(b"\"\\u0085\\u180e\"").unwrap(),b"\"\\u0085\\u180e\"");
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
        set(&mut f,"completedCount",b"\"4\"");assert!(project(&f,&q).is_some());
        assert_eq!(numeric(b"\"\\uFEFF0x10\\t\""),Some(16));
        assert_eq!(numeric(b"\"0b101\""),Some(5));
        assert_eq!(numeric(b"\"-0x10\""),None);
    }
}
