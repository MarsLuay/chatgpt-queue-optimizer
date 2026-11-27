// Included in the queue engine's UTF-16 batch module. All selectors and
// semantic marker decisions are native; JS supplies browser observations.
const GENERIC_PROGRESS:&[&str]=&["thinking","working","generating","searching","researching","loading"];
const GENERIC_ERRORS:&[&str]=&["something went wrong","there was an error","failed to generate","try again later","unable to"];
fn provider_group(name:&str)->&'static [&'static str]{
    super::CATALOG_4.iter().find(|(key,_)|*key==name).map_or(&[],|(_,values)|*values)
}
fn provider_contains_units(text:&[u16],needle:&[u16])->bool{
    !needle.is_empty()&&text.windows(needle.len()).any(|window|window==needle)
}
fn contains_ascii(text:&[u16],needle:&str)->bool{provider_contains_units(text,&ascii(needle))}
fn first_marker(text:&[u16],markers:&[&str],prefix:bool)->Vec<u16>{
    for &marker in markers{
        let m=ascii(marker);
        let found=if prefix{text.starts_with(&m)&&(text.len()==m.len()||matches!(text.get(m.len()),Some(32|33|46|63)))}else{provider_contains_units(text,&m)};
        if found{return m;}
    }
    Vec::new()
}
fn provider_marker(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()!=2{return None;}
    let kind=number(f[0]) as u32;
    let text=lower_ascii(&normalize(f[1]));
    let markers=match kind{
        0=>provider_group("errorMarkers"),1=>provider_group("conversationCapacityMarkers"),
        2=>provider_group("waitingForUserMarkers"),3=>provider_group("interruptedMarkers"),
        4=>provider_group("deliveryTimeoutMarkers"),5=>provider_group("errorMarkers"),_=>return None
    };
    Some(vec![first_marker(&text,markers,kind==0)])
}
fn provider_buttons(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()<2||(f.len()-2)%5!=0{return None;}
    let provider=number(f[0]) as u32;let mode=number(f[1]) as u32;
    if !(1..=3).contains(&provider)||mode>1{return None;}
    let rows=f[2..].chunks_exact(5);
    let mut result=Vec::new();
    for (i,row) in rows.enumerate(){
        if !eq(row[0],"1"){continue;}
        let test=lower_ascii(row[1]);let label=lower_ascii(trim(row[2]));
        let text=lower_ascii(trim(row[3]));let class=lower_ascii(row[4]);
        let found=if mode==0{
            let accessible=if label.is_empty(){&text}else{&label};
            if provider==1{
                provider_group("stopLabels").iter().any(|m|contains_ascii(accessible,m)||contains_ascii(&test,&m.replace(' ',"-")))
            }else{
                contains_ascii(&test,"stop")||eq(accessible,"stop")||
                    ["stop response","stop generating","stop streaming"].iter().any(|m|contains_ascii(accessible,m))||contains_ascii(&class,"stop-button")
            }
        }else if provider==1{
            contains_ascii(&test,"retry")||contains_ascii(&test,"regenerate")||
                provider_group("retryLabels").iter().any(|m|contains_ascii(&label,m)||contains_ascii(&text,m))
        }else{
            let accessible=if text.is_empty(){&label}else{&text};
            eq(accessible,"retry")||eq(accessible,"try again")
        };
        if found{result.push(ascii(&i.to_string()));}
    }
    Some(result)
}
fn provider_generation_text(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()!=4{return None;}
    let provider=number(f[0]) as u32;if !(1..=3).contains(&provider){return None;}
    let mut preview=normalize(f[1]);preview.truncate(1200);
    let status=lower_ascii(&preview);
    let alerts=if provider==1{lower_ascii(&normalize(f[2]))}else{lower_ascii(f[2])};
    let research=first_marker(&status,if provider==1{provider_group("researchMarkers")}else{GENERIC_PROGRESS},false);
    let deep=provider==1&&(contains_ascii(&status,"deep research")||contains_ascii(&status,"researching"));
    let timeout=if provider==1{first_marker(&alerts,provider_group("deliveryTimeoutMarkers"),false)}else{Vec::new()};
    let mut combined=alerts.clone();combined.push(32);combined.extend_from_slice(&status);
    let capacity=if provider==1{first_marker(&combined,provider_group("conversationCapacityMarkers"),false)}else{Vec::new()};
    let assistant_error=eq(f[3],"1");
    let error=if !capacity.is_empty(){ascii("conversation-max-length")}
        else if !timeout.is_empty(){ascii("Message delivery timed out. Please try again.")}
        else if provider==1&&assistant_error{ascii("assistant-error-stop")}
        else{first_marker(&alerts,if provider==1{provider_group("errorMarkers")}else{GENERIC_ERRORS},false)};
    let snippet=if provider==1{error.clone()}else if error.is_empty(){Vec::new()}else{
        let index=alerts.windows(error.len()).position(|v|v==error.as_slice()).unwrap_or(0);
        normalize(&alerts[index.saturating_sub(60)..(index+160).min(alerts.len())])
    };
    Some(vec![preview,research,error,snippet,ascii(if deep{"1"}else{"0"}),ascii(if timeout.is_empty(){"0"}else{"1"}),ascii(if capacity.is_empty(){"0"}else{"1"})])
}
fn provider_diagnostics(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()!=3{return None;}
    let flags=number(f[0]) as u32;let count=number(f[1]) as u32;let valid=eq(f[2],"1");
    let mut result=vec![ascii(if flags&7!=7{"required-signals-missing"}else if count==0&&valid{"empty-conversation"}else if count>0{"matched"}else{"not-found"})];
    for (i,key) in ["mainRoot","composer","sendButton"].iter().enumerate(){if flags&(1<<i)==0{result.push(ascii(key));}}
    Some(result)
}

#[cfg(test)]
mod additional_provider_tests{
    use super::*;
    fn run(op:u32,args:&[&str])->Vec<String>{
        let values=args.iter().map(|s|ascii(s)).collect::<Vec<_>>();
        let refs=values.iter().map(Vec::as_slice).collect::<Vec<_>>();
        execute(op,&refs).unwrap().iter().map(|s|String::from_utf16_lossy(s)).collect()
    }
    #[test]fn all_provider_semantic_observations(){
        assert_eq!(run(26,&["0","Something went wrong. Retry"]),vec!["something went wrong"]);
        assert_eq!(run(26,&["0","Explanation: something went wrong"]),vec![""]);
        assert_eq!(run(27,&["2","0","0","stop-button","","","", "1","","Stop generating","",""]),vec!["1"]);
        let gen=run(28,&["1"," Deep research ","maximum length for this conversation","0"]);
        assert_eq!(gen[2],"conversation-max-length");assert_eq!(gen[4],"1");assert_eq!(gen[6],"1");
        assert_eq!(run(29,&["7","0","1"]),vec!["empty-conversation"]);
    }
}

 // Complete generation decision: DOM facts plus native text observation.
 // Bits: stop=1, streaming=2, spinner=4, assistant error=8, retry=16.
 fn provider_generation_state(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()!=4{return None;}
    let provider=number(f[0]) as u32;
    let dom=number(f[3]) as u32;
    let assistant=ascii(if dom&8!=0{"1"}else{"0"});
    let mut result=provider_generation_text(&[f[0],f[1],f[2],&assistant])?;
    let tool=!result[1].is_empty()||(provider==1&&dom&4!=0);
    let capacity=eq(&result[6],"1");
    let error=!result[2].is_empty();
    let retry=dom&16!=0&&!capacity;
    let flags=(dom&3)|(u32::from(tool)<<2)|(u32::from(error)<<3)|(u32::from(retry)<<4)|(u32::from(eq(&result[4],"1"))<<5)|(u32::from(capacity)<<6);
    let state=super::cpo_generation_state(flags);
    let facts=u32::from(tool)|(u32::from(error)<<1)|(u32::from(retry)<<2);
    result.push(ascii(&state.to_string()));result.push(ascii(&facts.to_string()));
    Some(result)
 }


// Store only bounded metadata, never full prompts or browser object handles.
const TURN_CACHE_LIMIT:usize=4096;
const TURN_PREFIX:usize=128;
struct TurnMetadata{role:u32,fingerprint:Vec<u16>,has_text:bool,error:Vec<u16>}
impl TurnMetadata{
    fn fields(&self)->Vec<Vec<u16>>{vec![self.fingerprint.clone(),ascii(if self.has_text{"1"}else{"0"}),self.error.clone()]}
}
struct TurnText{fingerprint:super::Fingerprint,prefix:[u16;TURN_PREFIX],used:usize}
impl TurnText{
    fn new()->Self{Self{fingerprint:super::Fingerprint::new(),prefix:[0;TURN_PREFIX],used:0}}
    fn push(&mut self,unit:u16){
        self.fingerprint.push(unit);
        if self.used<TURN_PREFIX{self.prefix[self.used]=unit;self.used+=1;}
    }
    fn update(&mut self,units:&[u16]){
        for &unit in units{
            if super::whitespace(unit){
                if self.fingerprint.len!=0{self.fingerprint.pending=true;}
            }else{
                if self.fingerprint.pending{self.push(32);self.fingerprint.pending=false;}
                self.push(unit);
            }
        }
    }
    fn metadata(&self,role:u32)->TurnMetadata{
        let error=if role==2{first_marker(&lower_ascii(&self.prefix[..self.used]),provider_group("errorMarkers"),true)}else{Vec::new()};
        TurnMetadata{role,fingerprint:ascii(&format!("fnv1a:{:x}:len:{}",self.fingerprint.hash,self.fingerprint.len)),has_text:self.fingerprint.len!=0,error}
    }
}
thread_local!{
    static TURN_TEXT:RefCell<TurnText>=RefCell::new(TurnText::new());
    static TURN_CACHE:RefCell<std::collections::BTreeMap<(u32,u32),TurnMetadata>>=RefCell::new(std::collections::BTreeMap::new());
}
#[no_mangle]
pub extern "C" fn cpo_turn_text_reset(){
    TURN_TEXT.with(|state|{let mut state=state.borrow_mut();state.prefix.fill(0);*state=TurnText::new();});
}
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_turn_text_update(len:u32)->u32{
    if len as usize>super::CHUNK{return 0;}
    unsafe{
        let ptr=super::cpo_fingerprint_buffer() as *mut u16;
        let input=core::slice::from_raw_parts(ptr,len as usize);
        TURN_TEXT.with(|state|state.borrow_mut().update(input));
        for i in 0..len as usize{core::ptr::write_volatile(ptr.add(i),0);}
    }
    1
}
#[no_mangle]
pub extern "C" fn cpo_turn_cache_invalidate(scope:u32,token:u32)->u32{
    TURN_CACHE.with(|cache|{
        let mut cache=cache.borrow_mut();
        if token==0{cache.retain(|(owner,_),_|*owner!=scope);}
        else{cache.remove(&(scope,token));}
    });1
}
fn turn_key(f:&[&[u16]])->Option<(u32,u32,u32)>{
    if f.len()!=3{return None;}
    let scope=number(f[0]);let token=number(f[1]);let role=number(f[2]);
    if [scope,token,role].iter().any(|v|!v.is_finite()||*v<0.0||*v>u32::MAX as f64||v.fract()!=0.0)||role>2.0{return None;}
    Some((scope as u32,token as u32,role as u32))
}
fn turn_metadata_finish(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    let (scope,token,role)=turn_key(f)?;
    let metadata=TURN_TEXT.with(|state|state.borrow().metadata(role));
    cpo_turn_text_reset();
    let fields=metadata.fields();
    if scope!=0&&token!=0{
        TURN_CACHE.with(|cache|{
            let mut cache=cache.borrow_mut();
            if cache.len()>=TURN_CACHE_LIMIT&&!cache.contains_key(&(scope,token)){
                if let Some(key)=cache.keys().next().copied(){cache.remove(&key);}
            }
            cache.insert((scope,token),metadata);
        });
    }
    Some(fields)
}
fn turn_metadata_lookup(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    let (scope,token,role)=turn_key(f)?;
    Some(TURN_CACHE.with(|cache|cache.borrow().get(&(scope,token)).filter(|m|m.role==role).map_or_else(Vec::new,TurnMetadata::fields)))
}
// Error prefix has already been computed by the streaming text scanner.
fn last_assistant_observation(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()!=3{return None;}
    let flags=number(f[0]) as u32;
    let alerts=lower_ascii(&normalize(f[1]));
    let timeout=!first_marker(&alerts,provider_group("deliveryTimeoutMarkers"),false).is_empty();
    let general=!first_marker(&alerts,provider_group("errorMarkers"),false).is_empty();
    let has_error=timeout||general||flags&1!=0||!f[2].is_empty();
    let completed=flags&4!=0&&!has_error&&flags&2==0;
    let result=u32::from(has_error)|(u32::from(timeout)<<1)|(u32::from(completed)<<2);
    Some(vec![ascii(&result.to_string()),f[2].to_vec()])
}
#[cfg(test)]
mod turn_cache_tests{
    use super::*;
    fn frame(scope:u32,token:u32,role:u32)->Vec<Vec<u16>>{[scope,token,role].iter().map(|v|ascii(&v.to_string())).collect()}
    #[test]fn streaming_metadata_and_cache_invalidation(){
        cpo_turn_text_reset();
        TURN_TEXT.with(|state|{let mut state=state.borrow_mut();state.update(&ascii("  Something  "));state.update(&ascii("went wrong.\n"));state.update(&ascii("More text"));});
        let values=frame(1,1,2);let refs=values.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let metadata=turn_metadata_finish(&refs).unwrap();
        let mut expected=super::super::Fingerprint::new();expected.update(&ascii("Something went wrong. More text"));
        assert_eq!(metadata[0],ascii(&format!("fnv1a:{:x}:len:{}",expected.hash,expected.len)));
        assert_eq!(metadata[1],ascii("1"));assert_eq!(metadata[2],ascii("something went wrong"));
        assert_eq!(turn_metadata_lookup(&refs).unwrap(),metadata);
        let wrong=frame(1,1,1);let wrong_refs=wrong.iter().map(Vec::as_slice).collect::<Vec<_>>();
        assert!(turn_metadata_lookup(&wrong_refs).unwrap().is_empty());
        cpo_turn_cache_invalidate(1,1);
        assert!(turn_metadata_lookup(&refs).unwrap().is_empty());
    }
    #[test]fn cache_bounded_and_scope_clear(){
        TURN_CACHE.with(|cache|cache.borrow_mut().clear());
        for token in 1..=TURN_CACHE_LIMIT as u32+2{
            TURN_TEXT.with(|state|state.borrow_mut().update(&ascii("x")));
            let values=frame(2,token,1);let refs=values.iter().map(Vec::as_slice).collect::<Vec<_>>();
            turn_metadata_finish(&refs).unwrap();
        }
        TURN_CACHE.with(|cache|assert_eq!(cache.borrow().len(),TURN_CACHE_LIMIT));
        cpo_turn_cache_invalidate(2,0);
        TURN_CACHE.with(|cache|assert!(cache.borrow().is_empty()));
    }
}


// URL parsing remains the browser's WHATWG URL primitive. Native code owns
// host validation, route identity, surface eligibility and navigation policy.
// Fields: provider code, URL state (0 invalid, 1 HTTPS, 2 absent), host, path.
fn provider_surface(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()!=4{return None;}
    let provider=number(f[0]) as u32;
    let state=number(f[1]) as u32;
    let name=match provider{1=>"chatgpt",2=>"gemini",3=>"claude",_=>return None};
    let supported=state==1&&super::provider_host(&lower_ascii(f[2]))==provider;
    let packed=if supported{super::route(provider,f[3])}else{0};
    let kind=packed&3;
    let id=if kind==2{
        let start=((packed>>2)&2047) as usize;
        let len=((packed>>13)&2047) as usize;
        f[3].get(start..start.checked_add(len)?)?.to_vec()
    }else{Vec::new()};
    let kind_name=match kind{1=>"new",2=>"existing",_=>"unsupported"};
    let mut key=ascii(name);append(&mut key,":");
    if kind==2{append(&mut key,"c:");key.extend_from_slice(&id);}else{append(&mut key,kind_name);}
    let missing=state==2&&provider==1;
    let surface=if missing{"unclassified"}else{match kind{1=>"composer",2=>"conversation",_=>"unsupported"}};
    let eligible=provider==1&&(missing||kind==1||kind==2);
    let fallback=provider==1&&kind==2;
    let flags=u32::from(supported)|(u32::from(eligible)<<1)|(u32::from(fallback)<<2);
    Some(vec![ascii(kind_name),id,key,ascii(surface),ascii(&flags.to_string()),if supported{f[3].to_vec()}else{Vec::new()}])
}
fn provider_navigation(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()!=1{return None;}
    let provider=number(f[0]) as u32;
    Some(if provider==1{vec![ascii("1"),ascii("https://chatgpt.com/"),ascii("route")]}else{vec![ascii("0"),Vec::new(),ascii("unsupported")]})
}


// Generic provider response projection, including whether the last-assistant
// observation is required. Initial calls omit that observation; only an idle
// response requests it. No text or DOM handles cross this boundary.
fn generic_provider_response(f:&[&[u16]])->Option<Vec<Vec<u16>>>{
    if f.len()!=5{return None;}
    let flags=number(f[0]) as u32;
    let observed=eq(f[1],"1");
    let code=super::cpo_response_class(flags);
    let (phase,source,bits)=match code{
        1..=6=>("error",if flags&8!=0{"delivery-timeout"}else if flags&16!=0{"retry-visible"}else{"generation-error"},u32::from(flags&1024!=0)<<1),
        10|12=>("active",if flags&1024!=0{"deep-research"}else{"generating"},u32::from(flags&512!=0)|(u32::from(flags&1024!=0)<<1)),
        13=>("terminal","assistant-turn-completed",4),
        _ if !observed=>("transient-idle","unknown-idle",8),
        _=>("transient-idle","unknown-idle",0)
    };
    Some(vec![ascii(phase),ascii(source),ascii(&bits.to_string()),f[2].to_vec(),if bits&4!=0{f[3].to_vec()}else{Vec::new()},f[4].to_vec()])
}
#[cfg(test)]
#[test]
fn generic_response_observation_is_lazy(){
    let run=|flags:&str,observed:&str|{
        let fields=[flags,observed,"u","a","c"].map(ascii);
        let refs=fields.iter().map(Vec::as_slice).collect::<Vec<_>>();
        generic_provider_response(&refs).unwrap()
    };
    assert_eq!(run("0","0")[2],ascii("8"));
    assert_eq!(run("0","1")[2],ascii("0"));
    assert_eq!(run("256","1")[4],ascii("a"));
    assert_eq!(run("512","0")[0],ascii("active"));
    assert_eq!(run("520","0")[1],ascii("delivery-timeout"));
}
