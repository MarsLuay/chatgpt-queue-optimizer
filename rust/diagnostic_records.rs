//! Native serialization of bounded, browser-observed diagnostic facts.
//! Details must already have passed the native diagnostic traversal policy.
use super::command_identity::{decode_units,encode_units};
fn append(out:&mut Vec<u8>,key:&str,v:&[u8]){
    if out.len()>1{out.push(b',');}
    out.push(b'"');out.extend_from_slice(key.as_bytes());out.extend_from_slice(b"\":");out.extend_from_slice(v);
}
fn text(v:&[u8])->Option<&[u8]>{if v.len()>=2&&v.first()==Some(&b'"')&&v.last()==Some(&b'"'){Some(v)}else{None}}
fn choose<'a>(v:&'a[u8],fallback:&'a[u8])->Option<&'a[u8]>{let v=text(v)?;Some(if v==b"\"\""{fallback}else{v})}
pub(super) fn log_record(f:&[&[u8]])->Option<Vec<u8>>{
    if f.len()!=6{return None;}
    let id=text(f[0])?;let timestamp=text(f[1])?;
    let tab=f[2];
    if text(tab).is_none()&&!std::str::from_utf8(tab).ok().and_then(|s|s.parse::<f64>().ok()).is_some_and(f64::is_finite){return None;}
    let level=match text(f[3])?{b"\"error\""=>b"\"error\"".as_slice(),b"\"warn\""=>b"\"warn\"",b"\"success\""=>b"\"success\"",_=>b"\"info\""};
    let message=choose(f[4],b"\"Queue event\"")?;
    let details=f[5];
    if details.is_empty(){return None;}
    let mut out=vec![b'{'];
    for (key,value) in [("id",id),("timestamp",timestamp),("tabId",tab),("level",level),("message",message),("details",details)]{append(&mut out,key,value);}
    out.push(b'}');Some(out)
}
fn bounded(raw:&[u8],limit:usize)->Option<Vec<u8>>{
    let units=decode_units(raw)?;
    let mut out=Vec::with_capacity(limit);
    let mut pending=false;let mut overflow=false;
    for u in units{
        if super::whitespace(u){pending=!out.is_empty();continue;}
        if pending{if out.len()==limit{overflow=true;break;}out.push(32);pending=false;}
        if out.len()==limit{overflow=true;break;}out.push(u);
    }
    if overflow{out.truncate(limit-1);out.push(0x2026);}
    Some(encode_units(&out))
}
pub(super) fn provider_summary(f:&[&[u8]])->Option<Vec<u8>>{
    if f.len()!=7{return None;}
    let flags=std::str::from_utf8(f[0]).ok()?.parse::<u32>().ok()?;
    if flags>511{return None;}
    let phase=choose(f[1],text(f[2])?)?;
    let source=text(f[3])?;
    let compatibility=bounded(f[4],160)?;
    let signal=bounded(choose(f[5],choose(f[6],source)?)?,160)?;
    let mut out=vec![b'{'];
    append(&mut out,"phase",phase);append(&mut out,"source",source);
    for (i,key) in ["generating","deepResearchActive","hasError","hasTryAgainButton","hasDeliveryTimedOut","conversationCapacityReached","requiresNewConversation"].iter().enumerate(){
        let yes=flags&(1<<i)!=0||(*key=="hasError"&&f[1]==b"\"error\"");
        append(&mut out,key,if yes{b"true"}else{b"false"});
    }
    append(&mut out,"compatibilityState",&compatibility);append(&mut out,"matchedSignal",&signal);
    out.push(b'}');Some(out)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn serialization_and_normalization(){
        let row=log_record(&[b"\"id\"",b"\"date\"",b"7",b"\"unknown\"",b"\"\"",br#"{"redacted":true}"#]).unwrap();
        assert_eq!(row,br#"{"id":"id","timestamp":"date","tabId":7,"level":"info","message":"Queue event","details":{"redacted":true}}"#);
        let row=provider_summary(&[b"9",b"\"error\"",b"\"active\"",b"\"source\"",b"\"  a\\t b  \"",b"\"\"",b"\"\\ud800\""]).unwrap();
        let text=String::from_utf8(row).unwrap();assert!(text.contains("\"hasError\":true"));assert!(text.contains("\"hasTryAgainButton\":true"));assert!(text.contains("\"compatibilityState\":\"a b\""));assert!(text.contains("\"matchedSignal\":\"\\ud800\""));
    }
}
