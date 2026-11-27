//! Native Windows UIA installer. Fail closed on ambiguous controls, windows or
//! package identities. No keyboard injection, preference edits, or removal.
use super::{err,Result,local_artifacts::{prepare,NAME}};
use std::{env,path::{Path,PathBuf},process::Command,thread,time::{Duration,Instant}};
use windows::{core::BSTR,Win32::{Foundation::HWND,System::Com::*,UI::{Accessibility::*,WindowsAndMessaging::*}}};
#[link(name="kernel32")]
extern "system"{
    fn OpenProcess(access:u32,inherit:i32,pid:u32)->*mut core::ffi::c_void;
    fn QueryFullProcessImageNameW(process:*mut core::ffi::c_void,flags:u32,buffer:*mut u16,size:*mut u32)->i32;
    fn CloseHandle(handle:*mut core::ffi::c_void)->i32;
}
fn process_path(pid:u32)->Option<PathBuf>{
    unsafe{
        let handle=OpenProcess(0x1000,0,pid);if handle.is_null(){return None;}
        let mut buf=vec![0u16;32768];let mut len=buf.len() as u32;
        let result=QueryFullProcessImageNameW(handle,0,buf.as_mut_ptr(),&mut len);CloseHandle(handle);
        if result==0{return None;}Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}
fn same(a:&Path,b:&Path)->bool{
    match (a.canonicalize(),b.canonicalize()){
        (Ok(a),Ok(b))=>a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()),_=>false
    }
}
struct Com;
impl Com{fn new()->Result<Self>{unsafe{CoInitializeEx(None,COINIT_MULTITHREADED).ok()?;}Ok(Self)}}
impl Drop for Com{fn drop(&mut self){unsafe{CoUninitialize();}}}
fn automation()->Result<IUIAutomation>{Ok(unsafe{CoCreateInstance(&CUIAutomation,None,CLSCTX_INPROC_SERVER)?})}
fn nodes(u:&IUIAutomation,root:&IUIAutomationElement,scope:TreeScope)->Result<Vec<IUIAutomationElement>>{
    let list=unsafe{root.FindAll(scope,&u.CreateTrueCondition()?)?};
    let count=unsafe{list.Length()?};
    if count>30000{return Err(err("UIA tree exceeds safe inspection bound"));}
    Ok((0..count).filter_map(|i|unsafe{list.GetElement(i).ok()}).collect())
}
fn name(e:&IUIAutomationElement)->String{unsafe{e.CurrentName().map(|v|v.to_string()).unwrap_or_default()}}
fn pid(e:&IUIAutomationElement)->u32{unsafe{e.CurrentProcessId().unwrap_or(0).max(0) as u32}}
fn hwnd(e:&IUIAutomationElement)->Option<HWND>{unsafe{e.CurrentNativeWindowHandle().ok().filter(|v|!v.0.is_null())}}
fn enabled(e:&IUIAutomationElement)->bool{unsafe{e.CurrentIsEnabled().map(|v|v.as_bool()).unwrap_or(false)}}
fn visible(e:&IUIAutomationElement)->bool{unsafe{e.CurrentIsOffscreen().map(|v|!v.as_bool()).unwrap_or(false)}}
fn control(e:&IUIAutomationElement,kind:UIA_CONTROLTYPE_ID)->bool{unsafe{e.CurrentControlType().ok()==Some(kind)}}
fn value_pattern(e:&IUIAutomationElement)->Option<IUIAutomationValuePattern>{unsafe{e.GetCurrentPatternAs(UIA_ValuePatternId).ok()}}
fn value(e:&IUIAutomationElement)->String{value_pattern(e).and_then(|v|unsafe{v.CurrentValue().ok()}).map(|v|v.to_string()).unwrap_or_default()}
fn invoke(e:&IUIAutomationElement)->Result<()>{
    if !enabled(e)||!visible(e){return Err(err("UIA control is unavailable"));}
    let action:IUIAutomationInvokePattern=unsafe{e.GetCurrentPatternAs(UIA_InvokePatternId)?};
    unsafe{action.Invoke()?;}Ok(())
}
fn unique(items:Vec<IUIAutomationElement>,what:&str)->Result<Option<IUIAutomationElement>>{
    if items.len()>1{return Err(err(format!("Ambiguous {what}; refusing UI mutation")));}
    Ok(items.into_iter().next())
}
fn wait<T>(what:&str,seconds:u64,mut probe:impl FnMut()->Result<Option<T>>)->Result<T>{
    let until=Instant::now()+Duration::from_secs(seconds);
    loop{if let Some(v)=probe()?{return Ok(v);}if Instant::now()>=until{return Err(err(format!("Timed out: {what}")));}thread::sleep(Duration::from_millis(250));}
}
fn root(u:&IUIAutomation)->Result<IUIAutomationElement>{Ok(unsafe{u.GetRootElement()?})}
#[link(name="user32")]
extern "system"{
    #[link_name="EnumWindows"] fn enum_windows(callback:unsafe extern "system" fn(isize,isize)->i32,data:isize)->i32;
    #[link_name="GetClassNameW"] fn class_name(handle:isize,text:*mut u16,max:i32)->i32;
    #[link_name="GetWindowThreadProcessId"] fn window_pid(handle:isize,pid:*mut u32)->u32;
}
unsafe extern "system" fn collect_window(handle:isize,data:isize)->i32{
    (*(data as *mut Vec<isize>)).push(handle);1
}
fn all_windows()->Vec<isize>{
    let mut handles=Vec::new();unsafe{enum_windows(collect_window,&mut handles as *mut _ as isize);}handles
}
fn window_class(h:HWND)->String{
    let mut buf=[0u16;256];let len=unsafe{class_name(h.0 as isize,buf.as_mut_ptr(),buf.len() as i32)}.max(0) as usize;
    String::from_utf16_lossy(&buf[..len])
}
fn windows(u:&IUIAutomation,exe:&Path)->Result<Vec<IUIAutomationElement>>{
    let mut result=Vec::new();
    for handle in all_windows(){
        let mut p=0;unsafe{window_pid(handle,&mut p);}
        if !process_path(p).is_some_and(|v|same(&v,exe)){continue;}
        if let Ok(element)=unsafe{u.ElementFromHandle(HWND(handle as *mut _))}{result.push(element);}
    }
    Ok(result)
}
fn outside_document(u:&IUIAutomation,w:&IUIAutomationElement,e:&IUIAutomationElement)->bool{
    let Ok(walker)= (unsafe{u.RawViewWalker()}) else{return false;};
    let mut node=e.clone();
    for _ in 0..32{
        if control(&node,UIA_DocumentControlTypeId){return false;}
        if unsafe{u.CompareElements(&node,w)}.map(|b|b.as_bool()).unwrap_or(false){return true;}
        match unsafe{walker.GetParentElement(&node)}{Ok(parent)=>node=parent,Err(_)=>return false}
    }
    false
}
fn verified_page(u:&IUIAutomation,w:&IUIAutomationElement,firefox:bool)->Result<bool>{
    let list=nodes(u,w,TreeScope_Descendants)?;
    let url=if firefox{"about:debugging#/runtime/this-firefox"}else{"chrome://extensions"};
    let url_ok=list.iter().any(|e|{
        let n=name(e).to_lowercase();
        outside_document(u,w,e)&&(control(e,UIA_EditControlTypeId)||control(e,UIA_ComboBoxControlTypeId))&&
        (n.contains("address")||n.contains("search or enter")||n.contains("search with"))&&
        value(e).trim_end_matches('/')==url
    });
    let marker=list.iter().any(|e|if firefox{name(e)=="This Firefox"||name(e).starts_with("Load Temporary Add-on")}else{name(e)=="Extensions"||name(e)=="Developer mode"});
    Ok(url_ok&&marker)
}
fn assert_page(u:&IUIAutomation,w:&IUIAutomationElement,exe:&Path,firefox:bool)->Result<()>{
    let h=hwnd(w).ok_or_else(||err("Browser window disappeared"))?;
    if !process_path(pid(w)).is_some_and(|p|same(&p,exe))||unsafe{GetForegroundWindow()}!=h||!verified_page(u,w,firefox)?{
        return Err(err("Browser window, foreground or internal page changed; no UI action sent"));
    }Ok(())
}
fn named(u:&IUIAutomation,w:&IUIAutomationElement,names:&[&str])->Result<Option<IUIAutomationElement>>{
    unique(nodes(u,w,TreeScope_Descendants)?.into_iter().filter(|e|control(e,UIA_ButtonControlTypeId)&&visible(e)&&enabled(e)&&names.contains(&name(e).as_str())).collect(),"named button")
}
fn browser_exe(u:&IUIAutomation,target:&str,explicit:Option<&str>)->Result<Option<PathBuf>>{
    let expected=if target=="Firefox"{"firefox.exe"}else if target=="Chrome"{"chrome.exe"}else{"chromium.exe"};
    if let Some(p)=explicit{
        let p=PathBuf::from(p).canonicalize()?;
        if !p.is_file()||!(p.file_name().is_some_and(|n|n.to_string_lossy().eq_ignore_ascii_case(expected))||
            (target=="Chromium"&&p.file_name().is_some_and(|n|n.to_string_lossy().eq_ignore_ascii_case("chrome.exe")))){
            return Err(err("Explicit browser executable does not match selected browser"));
        }return Ok(Some(p));
    }
    let mut paths=Vec::new();
    for e in nodes(u,&root(u)?,TreeScope_Children)?{
        if let Some(p)=process_path(pid(&e)){
            let s=p.to_string_lossy().to_lowercase();
            let matches=if target=="Firefox"{s.ends_with("\\firefox.exe")}else if target=="Chrome"{s.contains("\\google\\")&&s.ends_with("\\chrome.exe")}else{s.contains("\\chromium\\")&&(s.ends_with("\\chrome.exe")||s.ends_with("\\chromium.exe"))};
            if matches&&!paths.iter().any(|old:&PathBuf|same(old,&p)){paths.push(p);}
        }
    }
    if paths.len()>1{return Err(err("Multiple browser installations detected; specify the executable"));}
    if let Some(p)=paths.pop(){return Ok(Some(p));}
    let folders=if target=="Firefox"{vec!["Mozilla Firefox/firefox.exe","Firefox Developer Edition/firefox.exe","Firefox Nightly/firefox.exe","Firefox ESR/firefox.exe"]}else if target=="Chrome"{vec!["Google/Chrome/Application/chrome.exe","Google/Chrome Beta/Application/chrome.exe"]}else{vec!["Chromium/Application/chromium.exe","Chromium/Application/chrome.exe"]};
    for var in ["LOCALAPPDATA","ProgramFiles","ProgramFiles(x86)"]{
        if let Some(base)=env::var_os(var){for folder in &folders{for root in [PathBuf::from(&base),PathBuf::from(&base).join("Programs")]{let p=root.join(folder);if p.is_file(){return Ok(Some(p.canonicalize()?));}}}}
    }Ok(None)
}
fn id_name(s:&str,id:&str)->bool{s==id||s==format!("ID: {id}")||s==format!("Extension ID: {id}")}
fn card(u:&IUIAutomation,w:&IUIAutomationElement,id:&str,firefox:bool)->Result<Option<IUIAutomationElement>>{
    let all=nodes(u,w,TreeScope_Descendants)?;
    let walker=unsafe{u.RawViewWalker()?};
    for e in all.iter().filter(|e|id_name(&name(e),id)){
        let mut parent=e.clone();
        for _ in 0..12{
            parent=match unsafe{walker.GetParentElement(&parent)}{Ok(v)=>v,Err(_)=>break};
            if control(&parent,UIA_DocumentControlTypeId)||unsafe{u.CompareElements(&parent,w)?}.as_bool(){break;}
            let sub=nodes(u,&parent,TreeScope_Descendants)?;
            let conflicting=sub.iter().any(|n|{
                let s=name(n);let t=s.strip_prefix("ID: ").unwrap_or(&s);
                (t.len()==32&&t.bytes().all(|c|(b'a'..=b'p').contains(&c))&&t!=id)||
                (firefox&&s.starts_with("Extension ID: ")&&!id_name(&s,id))
            });
            if conflicting{break;}
            if sub.iter().any(|n|name(n)==NAME)&&sub.iter().filter(|n|name(n)=="Reload"||name(n)=="Reload extension"||name(n)=="Reload ChatGPT Queue + Optimizer").count()==1{return Ok(Some(parent));}
        }
    }
    Ok(None)
}
fn owned_dialogs(u:&IUIAutomation,owner:HWND,exe:&Path)->Result<Vec<IUIAutomationElement>>{
    Ok(windows(u,exe)?.into_iter().filter(|e|hwnd(e).is_some_and(|h|h!=owner&&window_class(h)=="#32770"&&unsafe{GetWindow(h,GW_OWNER).ok()==Some(owner)})).collect())
}
fn install_picker(u:&IUIAutomation,w:&IUIAutomationElement,exe:&Path,firefox:bool,path:&Path)->Result<()>{
    assert_page(u,w,exe,firefox)?;
    let owner=hwnd(w).unwrap();
    if !owned_dialogs(u,owner,exe)?.is_empty(){return Err(err("Browser already owns a dialog; refusing to interfere"));}
    let labels=if firefox{vec!["Load Temporary Add-on","Load Temporary Add-on…","Load Temporary Add-on..."]}else{vec!["Load unpacked"]};
    let button=named(u,w,&labels)?.ok_or_else(||err("Install control unavailable"))?;
    // Invoke may block until the dialog closes. Reacquire the control on a
    // dedicated COM thread rather than passing COM objects across apartments.
    let owner_bits=owner.0 as usize;let exe2=exe.to_owned();let _=button;
    let worker=thread::spawn(move||->std::result::Result<(),String>{
        let f=||->Result<()>{
            let _com=Com::new()?;let u=automation()?;
            let w=unsafe{u.ElementFromHandle(HWND(owner_bits as *mut _))?};
            assert_page(&u,&w,&exe2,firefox)?;
            let b=named(&u,&w,&labels)?.ok_or_else(||err("Install button changed"))?;
            invoke(&b)
        };f().map_err(|e|e.to_string())
    });
    let dialog=wait("new browser-owned file picker",30,||{
        unique(owned_dialogs(u,owner,exe)?,"browser-owned file dialog")
    })?;
    let handle=hwnd(&dialog).ok_or_else(||err("Dialog handle unavailable"))?;
    let assert_dialog=||->Result<()>{
        if unsafe{GetForegroundWindow()}!=handle||unsafe{GetWindow(handle,GW_OWNER).ok()}!=Some(owner)||!process_path(pid(&dialog)).is_some_and(|p|same(&p,exe)){
            return Err(err("File picker ownership or foreground changed"));
        }Ok(())
    };
    assert_dialog()?;
    let fields=nodes(u,&dialog,TreeScope_Descendants)?;
    let field=unique(fields.into_iter().filter(|e|{
        let n=name(e).trim_end_matches(':').to_owned();
        control(e,UIA_EditControlTypeId)&&visible(e)&&enabled(e)&&
        (n=="File name"||(!firefox&&n=="Folder"))&&value_pattern(e).is_some()
    }).collect(),"file picker path field")?.ok_or_else(||err("No verified accessible path field; use manual selection"))?;
    let pattern=value_pattern(&field).ok_or_else(||err("Path field changed"))?;
    let path_text=path.to_string_lossy().trim_start_matches("\\\\?\\").to_owned();
    assert_dialog()?;unsafe{pattern.SetValue(&BSTR::from(path_text.as_str()))?;}
    if !unsafe{pattern.CurrentValue()?}.to_string().eq_ignore_ascii_case(&path_text){return Err(err("Picker did not retain the exact package path"));}
    let select=named(u,&dialog,if firefox{&["Open"][..]}else{&["Select Folder","Select","Open"][..]})?.ok_or_else(||err("Verified picker confirm button unavailable"))?;
    assert_dialog()?;invoke(&select)?;
    wait("file picker close",20,||Ok((!unsafe{IsWindow(Some(handle))}.as_bool()).then_some(())))?;
    if worker.is_finished(){worker.join().map_err(|_|err("UIA worker panicked"))?.map_err(err)?;}
    Ok(())
}
pub fn install(repo:&Path,target:&str,explicit:Option<&str>)->Result<i32>{
    let _com=Com::new()?;let u=automation()?;let firefox=target=="Firefox";
    let Some(exe)=browser_exe(&u,target,explicit)? else{println!("{target} executable not found");return Ok(2);};
    let (path,id)=prepare(repo,firefox)?;
    println!("Native UIA: {} package {}",target,path.display());
    let mut launch=Command::new(&exe);
    if firefox{launch.args(["--new-window","about:debugging#/runtime/this-firefox"]);}
    else{launch.args(["--new-window","--force-renderer-accessibility=complete","--enable-features=UiaProvider","chrome://extensions/"]);}
    launch.spawn()?;
    let w=wait("foreground verified internal browser page",30,||{
        let fg=unsafe{GetForegroundWindow()};
        for w in windows(&u,&exe)?{if hwnd(&w)==Some(fg)&&verified_page(&u,&w,firefox)?{return Ok(Some(w));}}
        Ok(None)
    })?;
    assert_page(&u,&w,&exe,firefox)?;
    if !firefox{
        if named(&u,&w,&["Load unpacked"])?.is_none(){
            let toggle=unique(nodes(&u,&w,TreeScope_Descendants)?.into_iter().filter(|e|name(e)=="Developer mode"&&visible(e)&&enabled(e)&&unsafe{e.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).is_ok()}).collect(),"Developer mode toggle")?.ok_or_else(||err("Developer mode toggle unavailable"))?;
            let pattern:IUIAutomationTogglePattern=unsafe{toggle.GetCurrentPatternAs(UIA_TogglePatternId)?};
            assert_page(&u,&w,&exe,firefox)?;
            if unsafe{pattern.CurrentToggleState()?}==ToggleState_Off{unsafe{pattern.Toggle()?;}}
            wait("Load unpacked",20,||named(&u,&w,&["Load unpacked"]))?;
        }
        if nodes(&u,&w,TreeScope_Descendants)?.iter().any(|e|id_name(&name(e),&id)){
            let card=card(&u,&w,&id,false)?.ok_or_else(||err("Existing local ID found without a unique reload card"))?;
            let reload=named(&u,&card,&["Reload","Reload extension","Reload ChatGPT Queue + Optimizer"])?.ok_or_else(||err("Local reload control unavailable"))?;
            assert_page(&u,&w,&exe,false)?;invoke(&reload)?;
            wait("local ID after reload",20,||{assert_page(&u,&w,&exe,false)?;Ok(card_exists(&u,&w,&id,false)?.then_some(()))})?;
            println!("Reload requested for exact local extension ID {id}");return Ok(0);
        }
    }
    install_picker(&u,&w,&exe,firefox,&path)?;
    wait("installed extension identity",30,||{
        assert_page(&u,&w,&exe,firefox)?;
        let Some(card)=card(&u,&w,&id,firefox)?else{return Ok(None);};
        if firefox{
            let expected=path.to_string_lossy().trim_start_matches("\\\\?\\").replace('\\',"/").to_lowercase();
            if !nodes(&u,&card,TreeScope_Descendants)?.iter().any(|n|name(n).replace('\\',"/").to_lowercase().contains(&expected)){return Ok(None);}
        }
        Ok(Some(()))
    })?;
    println!("Verified installed extension ID {id}");Ok(0)
}
fn card_exists(u:&IUIAutomation,w:&IUIAutomationElement,id:&str,firefox:bool)->Result<bool>{Ok(card(u,w,id,firefox)?.is_some())}
