//! Compute legacy-compatible command fingerprints directly from stored JSON.
//! Stream decoded UTF-16 code units, including escaped lone surrogates.
use super::Fingerprint;
pub(super) fn decode_units(bytes:&[u8])->Option<Vec<u16>>{
    if bytes.len()<2||bytes.first()!=Some(&b'"')||bytes.last()!=Some(&b'"'){return None;}
    let mut chars=std::str::from_utf8(&bytes[1..bytes.len()-1]).ok()?.chars();
    let mut out=Vec::new();
    while let Some(c)=chars.next(){
        if c=='\\'{
            let unit=match chars.next()?{
                'u'=>{let mut value=0u16;for _ in 0..4{value=(value<<4)|chars.next()?.to_digit(16)? as u16;}value},
                '"'=>34,'\\'=>92,'/'=>47,'b'=>8,'f'=>12,'n'=>10,'r'=>13,'t'=>9,_=>return None
            };
            out.push(unit);
        }else{
            if c=='"'||(c as u32)<32{return None;}
            let mut units=[0;2];out.extend_from_slice(c.encode_utf16(&mut units));
        }
    }
    Some(out)
}
pub(super) fn encode_units(units:&[u16])->Vec<u8>{
    // ASCII escaping preserves exact UTF-16 even for isolated surrogates.
    let mut out=vec![b'"'];
    for &u in units{
        match u{
            32..=126 if u!=34&&u!=92=>out.push(u as u8),
            34=>out.extend_from_slice(b"\\\""),
            92=>out.extend_from_slice(b"\\\\"),
            _=>out.extend_from_slice(format!("\\u{u:04x}").as_bytes())
        }
    }
    out.push(b'"');out
}
pub(super) fn fingerprint_json(bytes:&[u8])->Option<Vec<u8>>{
    if bytes.len()<2||bytes.first()!=Some(&b'"')||bytes.last()!=Some(&b'"'){return None;}
    let text=std::str::from_utf8(&bytes[1..bytes.len()-1]).ok()?;
    let mut chars=text.chars();
    let mut fp=Fingerprint::new();
    while let Some(c)=chars.next(){
        if c=='\\'{
            let unit=match chars.next()?{
                'u'=>{
                    let mut value=0u16;
                    for _ in 0..4{value=(value<<4)|chars.next()?.to_digit(16)? as u16;}
                    value
                },
                '"' => 34, '\\' => 92, '/' => 47,
                'b'=>8,'f'=>12,'n'=>10,'r'=>13,'t'=>9,
                _=>return None
            };
            fp.update(&[unit]);
        }else{
            if c=='"'||(c as u32)<32{return None;}
            let mut units=[0u16;2];
            fp.update(c.encode_utf16(&mut units));
        }
    }
    Some(format!("\"fnv1a:{:x}:len:{}\"",fp.hash,fp.len).into_bytes())
}
pub(super) fn command_id(run:&[u8],number:u32)->Option<Vec<u8>>{
    let run=if run==b"null"||run==b"\"\""||run.is_empty(){b"\"run\"".as_slice()}else{run};
    if run.len()<2||run.first()!=Some(&b'"')||run.last()!=Some(&b'"'){return None;}
    let mut out=run[..run.len()-1].to_vec();
    out.extend_from_slice(format!(":{number}\"").as_bytes());
    Some(out)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn fingerprint_matches_units(){
        let mut fp=Fingerprint::new();
        fp.update(&[32,97,9,0xd800,0xd83c,0xdf0d,10,98,0xfeff]);
        assert_eq!(fingerprint_json(r#"" a\t\ud800🌍\nb\ufeff""#.as_bytes()).unwrap(),
            format!("\"fnv1a:{:x}:len:{}\"",fp.hash,fp.len).into_bytes());
        assert!(fingerprint_json(br#""bad\q""#).is_none());
        assert_eq!(command_id(br#""x\"y\ud800""#,7).unwrap(),br#""x\"y\ud800:7""#);
        assert_eq!(command_id(b"null",1).unwrap(),b"\"run:1\"");
    }
}
