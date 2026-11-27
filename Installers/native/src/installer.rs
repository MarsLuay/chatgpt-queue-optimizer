//! Native one-click installation. Dependency discovery, packaging, diagnostics
//! and platform routing are owned by Rust. No signature or enterprise-policy
//! overrides, no termination of arbitrary existing browser processes.
use super::{err,Result,local_artifacts,logged_child,stamp};
use std::{env,fs,io::Write,path::{Path,PathBuf},process::{Command,Stdio},time::{Duration,Instant}};

#[derive(Default)]
pub(super) struct Options{
    pub update_repo:bool,pub skip_chrome:bool,pub skip_firefox:bool,
    pub no_restart:bool,pub no_temporary_loader:bool,pub no_dependencies:bool,
}
fn find(names:&[&str],roots:&[PathBuf])->Option<PathBuf>{
    for root in roots{
        for name in names{let p=root.join(name);if p.is_file(){return Some(p);}}
    }
    for root in env::split_paths(&env::var_os("PATH").unwrap_or_default()){
        for name in names{let p=root.join(name);if p.is_file(){return Some(p);}}
    }
    None
}
fn home()->PathBuf{
    env::var_os(if cfg!(windows){"USERPROFILE"}else{"HOME"}).map(PathBuf::from).unwrap_or_default()
}
fn path_refresh()->Result<()>{
    let mut dirs=vec![home().join(".cargo/bin")];
    if cfg!(windows){
        for key in ["ProgramFiles","ProgramFiles(x86)","LOCALAPPDATA"]{
            if let Some(value)=env::var_os(key){
                let root=PathBuf::from(value);
                for relative in ["nodejs","Programs/nodejs","Git/cmd","Programs/Git/cmd","Microsoft/WinGet/Links"]{
                    dirs.push(root.join(relative));
                }
            }
        }
    }else if cfg!(target_os="macos"){
        dirs.extend([PathBuf::from("/opt/homebrew/bin"),PathBuf::from("/usr/local/bin"),PathBuf::from("/usr/bin")]);
    }
    dirs.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
    dirs.retain(|p|p.is_dir());
    env::set_var("PATH",env::join_paths(dirs)?);
    Ok(())
}
fn browser(target:&str,explicit:Option<&str>)->Result<Option<PathBuf>>{
    if let Some(p)=explicit{
        let p=PathBuf::from(p).canonicalize()?;
        if !p.is_file(){return Err(err("Explicit browser path is not a file"));}
        return Ok(Some(p));
    }
    let mut roots=Vec::new();
    if cfg!(windows){
        for var in ["ProgramFiles","ProgramFiles(x86)","LOCALAPPDATA"]{
            if let Some(base)=env::var_os(var){
                let base=PathBuf::from(base);
                roots.push(base.clone());roots.push(base.join("Programs"));
            }
        }
        let names:&[&str]=match target{
            "Firefox"=>&["Firefox Developer Edition/firefox.exe","Mozilla Firefox/firefox.exe","Firefox Nightly/firefox.exe","Firefox ESR/firefox.exe","firefox.exe"],
            "Chromium"=>&["Chromium/Application/chromium.exe","Chromium/Application/chrome.exe","chromium.exe"],
            _=>&["Google/Chrome/Application/chrome.exe","Google/Chrome Beta/Application/chrome.exe","chrome.exe"]
        };
        Ok(find(names,&roots))
    }else if cfg!(target_os="macos"){
        roots.extend([PathBuf::from("/Applications"),home().join("Applications")]);
        let names:&[&str]=match target{
            "Firefox"=>&["Firefox Developer Edition.app/Contents/MacOS/firefox","Firefox.app/Contents/MacOS/firefox"],
            "Chromium"=>&["Chromium.app/Contents/MacOS/Chromium"],
            _=>&["Google Chrome.app/Contents/MacOS/Google Chrome"]
        };
        Ok(find(names,&roots))
    }else{
        Ok(find(match target{"Firefox"=>&["firefox-developer-edition","firefox"],"Chromium"=>&["chromium","chromium-browser"],_=>&["google-chrome","google-chrome-stable"]},&roots))
    }
}
fn npm_path()->Option<PathBuf>{find(if cfg!(windows){&["npm.cmd","npm.exe"]}else{&["npm"]},&[])}
fn dependency(package:&str,cask:bool,log:&mut fs::File)->Result<bool>{
    let mut command=if cfg!(windows){
        let Some(winget)=find(&["winget.exe"],&[])else{return Ok(false);};
        let mut cmd=Command::new(winget);
        cmd.args(["install","--id",package,"--exact","--source","winget","--accept-package-agreements","--accept-source-agreements"]);cmd
    }else if cfg!(target_os="macos"){
        let Some(brew)=find(&["brew"],&[PathBuf::from("/opt/homebrew/bin"),PathBuf::from("/usr/local/bin")])else{return Ok(false);};
        let mut cmd=Command::new(brew);cmd.arg("install");if cask{cmd.arg("--cask");}cmd.arg(package);cmd
    }else{return Ok(false);};
    let result=logged_child(&mut command,log)?==0;path_refresh()?;Ok(result)
}
fn help(repo:&Path,lines:&[String])->Result<()>{
    fs::write(repo.join("build/installer-help-links.txt"),lines.join("\n")+"\n")?;
    for line in lines{println!("{line}");}Ok(())
}
fn targets(browser:&str,options:&Options)->Result<Vec<&'static str>>{
    let mut out=match browser{
        ""|"All"=>vec!["Chrome","Firefox"],
        "Chrome"=>vec!["Chrome"],"Firefox"=>vec!["Firefox"],"Chromium"=>vec!["Chromium"],
        _=>return Err(err("Unknown browser selection"))
    };
    out.retain(|t|!(*t=="Firefox"&&options.skip_firefox||*t!="Firefox"&&options.skip_chrome));
    if out.is_empty(){return Err(err("No browser selected"));}Ok(out)
}
fn report(log:&mut fs::File,message:&str)->Result<()>{println!("{message}");writeln!(log,"[{0}] {message}",stamp())?;log.flush()?;Ok(())}
#[cfg(target_os="macos")]
fn dialog(message:&str){
    if env::var("CHATGPT_QUEUE_OPTIMIZER_INSTALLER_NO_DIALOG").ok().as_deref()==Some("true"){return;}
    let script="on run argv\ndisplay dialog (item 1 of argv) with title \"ChatGPT Queue Optimizer\" buttons {\"OK\"} default button \"OK\"\nend run";
    let _=Command::new("/usr/bin/osascript").args(["-e",script]).arg(message).status();
}
#[cfg(not(target_os="macos"))]
fn dialog(_message:&str){}
fn firefox_temporary(repo:&Path,exe:&Path,log:&mut fs::File)->Result<()>{
    let npm=npm_path().ok_or_else(||err("Node/npm is unavailable for Firefox temporary installation"))?;
    let dir=repo.join("build/logs");fs::create_dir_all(&dir)?;
    let path=dir.join(format!("firefox-web-ext-{}-{}.log",stamp(),std::process::id()));
    let output=fs::File::create(&path)?;
    let mut cmd=Command::new(npm);
    cmd.current_dir(repo).args(["exec","--yes","--package=web-ext@10.7.0","--","web-ext","run","--no-config-discovery","--source-dir"]).arg(repo.join("build/firefox-src"))
        .arg("--firefox").arg(exe).args(["--no-reload","--start-url","https://chatgpt.com/"])
        .env_remove("WEB_EXT_API_KEY").env_remove("WEB_EXT_API_SECRET")
        .stdin(Stdio::null()).stdout(Stdio::from(output.try_clone()?)).stderr(Stdio::from(output));
    #[cfg(windows)]{use std::os::windows::process::CommandExt;cmd.creation_flags(0x00000200);}
    let mut child=cmd.spawn()?;
    let deadline=Instant::now()+Duration::from_secs(45);
    loop{
        let content=fs::read(&path).unwrap_or_default();
        let lower=String::from_utf8_lossy(&content).to_ascii_lowercase();
        if lower.contains("installed")&&lower.contains("temporary add-on"){
            return report(log,&format!("Firefox temporary add-on confirmed in isolated profile. Log: {}",path.display()));
        }
        if child.try_wait()?.is_some()||Instant::now()>=deadline{
            return Err(err(format!("Firefox temporary installation not confirmed; inspect {}",path.display())));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
// On platforms without Windows UIA, use the browser's own developer controls.
// Do not pretend that opening an internal page verifies installation.
fn manual(repo:&Path,target:&str,exe:&Path,log:&mut fs::File)->Result<()>{
    let firefox=target=="Firefox";
    let (path,id)=local_artifacts::prepare(repo,firefox)?;
    let page=if firefox{"about:debugging#/runtime/this-firefox"}else{"chrome://extensions/"};
    Command::new(exe).arg(page).spawn()?;
    let message=if firefox{format!("Firefox: choose Load Temporary Add-on and select:\n{}\nExpected ID: {id}",path.display())}
        else{format!("{target}: enable Developer mode, choose Load unpacked (or Reload for the existing local copy), and select:\n{}\nExpected ID: {id}",path.display())};
    report(log,&message)?;dialog(&message);
    Err(err(format!("{target} requires manual confirmation; installation was not automatically verified")))
}
pub(super) fn run(repo:&Path,selection:&str,paths:&[Option<String>;3],opts:&Options)->Result<()>{
    path_refresh()?;
    let build=repo.join("build");fs::create_dir_all(&build)?;
    let mut log=fs::OpenOptions::new().create(true).append(true).open(build.join("installer.log"))?;
    let mut links=Vec::new();
    report(&mut log,&format!("Native installer: {}",repo.display()))?;
    if opts.update_repo{
        if logged_child(Command::new("git").current_dir(repo).args(["pull","--ff-only","origin","main"]),&mut log)?!=0{
            return Err(err("Repository update failed; no browser modified"));
        }
    }
    let selected=targets(selection,opts)?;
    let mut failures=Vec::new();
    let mut available=Vec::new();
    for target in selected{
        let index=match target{"Firefox"=>0,"Chromium"=>1,_=>2};
        let explicit=paths[index].as_deref();
        let mut exe=browser(target,explicit)?;
        if exe.is_none()&&!opts.no_dependencies&&explicit.is_none(){
            let package=match (cfg!(windows),target){
                (true,"Firefox")=>"Mozilla.Firefox",(true,"Chrome")=>"Google.Chrome",(true,_)=>"Hibbiki.Chromium",
                (false,"Firefox")=>"firefox",(false,"Chrome")=>"google-chrome",(false,_)=>"chromium"
            };
            if let Err(e)=dependency(package,true,&mut log){report(&mut log,&format!("Dependency setup: {e}"))?;}
            exe=browser(target,None)?;
        }
        if let Some(exe)=exe{report(&mut log,&format!("{target}: {}",exe.display()))?;available.push((target,index,exe));}
        else{
            failures.push(format!("{target} not found"));
            links.push(match target{"Firefox"=>"Firefox - https://www.mozilla.org/firefox/","Chromium"=>"Chromium - https://www.chromium.org/getting-involved/download-chromium/",_=>"Chrome - https://www.google.com/chrome/"}.into());
        }
    }
    if !cfg!(windows)&&!opts.no_restart&&!opts.no_temporary_loader&&available.iter().any(|(t,_,_)|*t=="Firefox")&&npm_path().is_none(){
        if !opts.no_dependencies{let _=dependency("node",false,&mut log);}
        if npm_path().is_none(){links.push("Node.js/npm - https://nodejs.org/en/download".into());}
    }
    let code=logged_child(Command::new(env::current_exe()?).arg("package").arg("--repo-dir").arg(repo),&mut log)?;
    if code!=0{return Err(err("Packaging failed; no browser modified"));}
    for (target,index,exe) in available{
        let result=if opts.no_restart{
            local_artifacts::prepare(repo,target=="Firefox").and_then(|(p,id)|report(&mut log,&format!("Prepared {target}: {} (ID {id}); no browser launched",p.display())))
        }else if cfg!(windows){
            let mut cmd=Command::new(env::current_exe()?);
            cmd.arg("native-ui").arg("--repo-dir").arg(repo).args(["--browser",target]);
            // Prefer the UI backend's own running-process discovery unless a
            // specific executable was explicitly requested.
            if let Some(p)=&paths[index]{cmd.arg(["--firefox-path","--chromium-path","--chrome-path"][index]).arg(p);}
            logged_child(&mut cmd,&mut log).and_then(|code|if code==0{Ok(())}else{Err(err(format!("{target} UI installation exited {code}")))})
        }else if target=="Firefox"&&!opts.no_temporary_loader&&npm_path().is_some(){
            firefox_temporary(repo,&exe,&mut log)
        }else{manual(repo,target,&exe,&mut log)};
        if let Err(e)=result{report(&mut log,&format!("Needs attention: {e}"))?;failures.push(e.to_string());}
    }
    if !failures.is_empty(){links.push("Repository - https://github.com/MarsLuay/chatgpt-queue-optimizer".into());}
    help(repo,&links)?;
    let summary=if failures.is_empty(){"Native installation workflow completed".into()}else{format!("Installation needs attention:\n{}",failures.join("\n"))};
    report(&mut log,&summary)?;
    report(&mut log,&format!("Log: {}",build.join("installer.log").display()))?;
    dialog(&summary);
    if failures.is_empty(){Ok(())}else{Err(err(summary))}
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn selection_and_skip_flags(){
        assert_eq!(targets("",&Options::default()).unwrap(),vec!["Chrome","Firefox"]);
        assert_eq!(targets("All",&Options{skip_chrome:true,..Options::default()}).unwrap(),vec!["Firefox"]);
        assert!(targets("Firefox",&Options{skip_firefox:true,..Options::default()}).is_err());
        assert!(targets("unknown",&Options::default()).is_err());
    }
}
