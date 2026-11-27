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
