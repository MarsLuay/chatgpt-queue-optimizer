#[cfg(windows)]
mod windows_ui;
mod secrets;
mod wasm_bindings;
mod browser_api_bindings;
mod history_viewer_bindings;
mod history_store_bindings;
mod queue_bindings;
mod content_bindings;
mod popup_bindings;
mod browser_bridge_bindings;
mod background_bindings;
#[cfg(test)]
mod release_tests;
use serde_json::{json, Value};
use std::{env, fs, io::{self, Write, BufRead, BufReader}, path::{Path, PathBuf}, process::{Command, Stdio}, time::{SystemTime, UNIX_EPOCH}};
use zip::{ZipWriter, write::FileOptions};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const ID: &str = "chatgpt-queue-optimizer@marsluay.local";
const FILES: &[&str] = &["manifest.json","background.js","rust-queue-bridge.js","content.js","rust-browser-bindings.js","rust-browser-bridge.js","utils.js","popup.html","popup.js","options.html","history-viewer.html","history-viewer.js","history-store.js","history-viewer.css","styles.css","icon_16.png","icon_48.png","icon_128.png","optimizer_core.wasm","optimizer_browser.wasm","optimizer_history.wasm","optimizer_queue.wasm"];
const MODULES: &[(&str,&str)] = &[("optimizer_core","optimizer_core.rs"),("optimizer_browser","browser_engine.rs"),("optimizer_history","history_engine.rs"),("optimizer_queue","queue_engine.rs")];
fn err(message: impl Into<String>) -> Box<dyn std::error::Error> { io::Error::new(io::ErrorKind::Other,message.into()).into() }
fn stamp()->u128 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()}
#[cfg(test)]
fn fixture_stamp()->String{
    static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
    format!("{}-{}",stamp(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed))
}
fn checked(command:&mut Command)->Result<()> {
    let status=command.status()?;
    if !status.success(){return Err(err(format!("Child process failed: {status}")));}
    Ok(())
}
fn build_wasm(repo:&Path, stage:&Path)->Result<()> {
    let target="wasm32-unknown-unknown";
    let lib=Command::new("rustc").args(["--print","target-libdir","--target",target]).output()?;
    if !lib.status.success(){return Err(err("Rust target discovery failed"));}
    let lib=PathBuf::from(String::from_utf8(lib.stdout)?.trim());
    let installed=fs::read_dir(lib).ok().into_iter().flatten().flatten()
        .any(|e|e.file_name().to_string_lossy().starts_with("libcore-"));
    if !installed {checked(Command::new("rustup").args(["target","add",target]))?;}
    for &(name,source) in MODULES {
        let output=stage.join(format!("{name}.wasm"));
        checked(Command::new("rustc").current_dir(repo)
            .args(["--edition=2021","--crate-name",name,"--crate-type","cdylib","--target",target,
                "-C","opt-level=z","-C","panic=abort","-C","strip=symbols","-C","link-arg=-zstack-size=16384"])
            .arg(repo.join("rust").join(source)).arg("-o").arg(&output))?;
        let bytes=fs::read(&output)?;
        if !bytes.starts_with(b"\0asm\x01\0\0\0"){return Err(err("Invalid generated WASM module"));}
        println!("Built {} ({} bytes)",name,bytes.len());
    }
    browser_bridge_bindings::generate(stage)?;
    wasm_bindings::generate(repo,stage)?;
    browser_api_bindings::generate(stage)?;
    history_viewer_bindings::generate(stage)?;
    history_store_bindings::generate(stage)?;
    queue_bindings::generate(stage)?;
    content_bindings::generate(stage)?;
    popup_bindings::generate(stage)?;
    background_bindings::generate(stage)?;
    Ok(())
}
fn firefox_manifest(base:&Value)->Result<Value>{
    if base["manifest_version"]!=3 || !base["version"].is_string() || !base["action"].is_object(){return Err(err("Invalid Chromium manifest"));}
    let mut permissions=Vec::<String>::new();
    for key in ["permissions","host_permissions"]{
        if let Some(items)=base[key].as_array(){for item in items{permissions.push(item.as_str().ok_or_else(||err("Invalid permission"))?.to_string());}}
    }
    permissions.sort();permissions.dedup();
    Ok(json!({
        "manifest_version":2,"name":base["name"],"description":base["description"],"version":base["version"],
        "offline_enabled":base["offline_enabled"].as_bool().unwrap_or(true),
        "browser_action":base["action"],
        "background":{"scripts":["utils.js","rust-queue-bridge.js","rust-browser-bindings.js","rust-browser-bridge.js","background.js"],"persistent":true},
        "options_ui":{"page":"options.html","open_in_tab":true},
        "commands":base["commands"],"content_scripts":base["content_scripts"],"permissions":permissions,"icons":base["icons"],
        "content_security_policy":"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        "web_accessible_resources":["optimizer_core.wasm","optimizer_browser.wasm","optimizer_queue.wasm","icon_16.png","icon_48.png","icon_128.png","popup.html","popup.js","styles.css"],
        "browser_specific_settings":{"gecko":{"id":ID,"strict_min_version":"140.0","data_collection_permissions":{"required":["none"]}},"gecko_android":{"strict_min_version":"142.0"}}
    }))
}
fn copy_tree(src:&Path,dst:&Path)->Result<()>{
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?{
        let entry=entry?;let kind=entry.file_type()?;let dest=dst.join(entry.file_name());
        if kind.is_dir(){copy_tree(&entry.path(),&dest)?;}
        else if kind.is_file(){fs::copy(entry.path(),dest)?;}
        else{return Err(err("Refusing non-regular package asset"));}
    }
    Ok(())
}
fn archive(dir:&Path,out:&Path)->Result<()>{
    fn add(zip:&mut ZipWriter<fs::File>,root:&Path,dir:&Path)->Result<()>{
        let mut entries=fs::read_dir(dir)?.collect::<std::result::Result<Vec<_>,_>>()?;
        entries.sort_by_key(|e|e.file_name());
        for entry in entries{
            let path=entry.path();
            if entry.file_type()?.is_dir(){add(zip,root,&path)?;}
            else if entry.file_type()?.is_file(){
                let name=path.strip_prefix(root)?.to_str().ok_or_else(||err("Invalid asset name"))?.replace('\\',"/");
                zip.start_file(name,FileOptions::default().compression_method(zip::CompressionMethod::Deflated))?;
                io::copy(&mut fs::File::open(path)?,zip)?;
            }else{return Err(err("Invalid archive asset"));}
        }
        Ok(())
    }
    let mut zip=ZipWriter::new(fs::File::create(out)?);add(&mut zip,dir,dir)?;zip.finish()?;Ok(())
}
// Replace only generated outputs, preserving the old artifact if the rename fails.
fn publish_path(from:&Path,to:&Path)->Result<()>{
    let backup=to.with_extension(format!("old-{}-{}",std::process::id(),stamp()));
    if to.exists(){fs::rename(to,&backup)?;}
    if let Err(e)=fs::rename(from,to){if backup.exists(){let _=fs::rename(&backup,to);}return Err(e.into());}
    if backup.is_dir(){fs::remove_dir_all(backup)?;}else if backup.exists(){fs::remove_file(backup)?;}
    Ok(())
}
struct Cleanup(PathBuf);
impl Drop for Cleanup{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
fn package(repo:&Path)->Result<String>{
    let base:Value=serde_json::from_slice(&fs::read(repo.join("manifest.json"))?)?;
    let version=base["version"].as_str().filter(|s|!s.is_empty()).ok_or_else(||err("Missing version"))?.to_owned();
    let ff=firefox_manifest(&base)?;
    let build=repo.join("build");fs::create_dir_all(&build)?;
    let stage=build.join(format!("native-stage-{}-{}",std::process::id(),stamp()));
    fs::create_dir(&stage)?;let _cleanup=Cleanup(stage.clone());
    build_wasm(repo,&stage)?;
    for name in ["chrome-src","firefox-src"]{
        let dest=stage.join(name);fs::create_dir(&dest)?;
        for asset in FILES{
            let src=if asset.ends_with(".wasm")||*asset==wasm_bindings::OUTPUT||*asset==browser_api_bindings::OUTPUT||*asset==history_viewer_bindings::OUTPUT||*asset==history_store_bindings::OUTPUT||*asset==queue_bindings::OUTPUT||*asset==content_bindings::OUTPUT||*asset==popup_bindings::OUTPUT||*asset==browser_bridge_bindings::OUTPUT||*asset==background_bindings::OUTPUT{stage.join(asset)}else{repo.join(asset)};
            if !fs::symlink_metadata(&src)?.file_type().is_file(){return Err(err(format!("Not a regular file: {asset}")));}
            fs::copy(src,dest.join(asset))?;
        }
        if repo.join("icons").is_dir(){copy_tree(&repo.join("icons"),&dest.join("icons"))?;}
        if name=="firefox-src"{fs::write(dest.join("manifest.json"),serde_json::to_string_pretty(&ff)?+"\n")?;}
    }
    let chrome="chatgpt-queue-optimizer-chrome-store.zip";
    let firefox="chatgpt-queue-optimizer-firefox-store.zip";
    archive(&stage.join("chrome-src"),&stage.join(chrome))?;
    archive(&stage.join("firefox-src"),&stage.join(firefox))?;
    for &(name,_) in MODULES{let file=format!("{name}.wasm");publish_path(&stage.join(&file),&repo.join(&file))?;}
    publish_path(&stage.join(wasm_bindings::OUTPUT),&repo.join(wasm_bindings::OUTPUT))?;
    publish_path(&stage.join(browser_api_bindings::OUTPUT),&repo.join(browser_api_bindings::OUTPUT))?;
    publish_path(&stage.join(history_viewer_bindings::OUTPUT),&repo.join(history_viewer_bindings::OUTPUT))?;
    publish_path(&stage.join(history_store_bindings::OUTPUT),&repo.join(history_store_bindings::OUTPUT))?;
    publish_path(&stage.join(queue_bindings::OUTPUT),&repo.join(queue_bindings::OUTPUT))?;
    publish_path(&stage.join(content_bindings::OUTPUT),&repo.join(content_bindings::OUTPUT))?;
    publish_path(&stage.join(popup_bindings::OUTPUT),&repo.join(popup_bindings::OUTPUT))?;
    publish_path(&stage.join(browser_bridge_bindings::OUTPUT),&repo.join(browser_bridge_bindings::OUTPUT))?;
    publish_path(&stage.join(background_bindings::OUTPUT),&repo.join(background_bindings::OUTPUT))?;
    for file in ["chrome-src","firefox-src",chrome,firefox]{publish_path(&stage.join(file),&build.join(file))?;}
    println!("Packaged v{version}: build/{chrome}, build/{firefox}");
    Ok(version)
}
fn logged_child(command:&mut Command, log:&mut fs::File)->Result<i32>{
    // Merge output at the receiver to avoid deadlocking on a full stderr pipe.
    let mut child=command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let (tx,rx)=std::sync::mpsc::channel::<String>();
    let mut threads=Vec::new();
    for (stream,prefix) in [(Box::new(child.stdout.take().unwrap()) as Box<dyn io::Read+Send>,""),(Box::new(child.stderr.take().unwrap()) as Box<dyn io::Read+Send>,"[stderr] ")]{
        let tx=tx.clone();threads.push(std::thread::spawn(move||{
            for line in BufReader::new(stream).split(b'\n'){match line{Ok(line)=>{if tx.send(format!("{prefix}{}",String::from_utf8_lossy(&line).trim_end_matches('\r'))).is_err(){break;}},Err(_)=>break}}
        }));
    }
    drop(tx);
    let mut log_error=None;
    for line in rx{println!("{line}");if let Err(e)=writeln!(log,"[{0}] {line}",stamp()){log_error=Some(e);}}
    for thread in threads{let _=thread.join();}
    let code=child.wait()?.code().unwrap_or(1);
    if let Some(e)=log_error{return Err(e.into());}Ok(code)
}
fn install(repo:&Path, browser:&str, paths:&[Option<String>;3], legacy_ui:bool)->Result<()>{
    if !cfg!(windows){return Err(err("Local UI installation is Windows-only"));}
    let browser=if browser.is_empty(){
        println!("1. Firefox\n2. Chromium");let mut line=String::new();io::stdin().read_line(&mut line)?;
        match line.trim(){"1"=>"Firefox","2"=>"Chromium",_=>return Err(err("Invalid browser selection"))}
    }else{browser};
    let targets=match browser{"All"=>vec!["Firefox","Chromium"],"Firefox"|"Chromium"|"Chrome"=>vec![browser],_=>return Err(err("Unknown browser"))};
    let logs=repo.join("build/logs");fs::create_dir_all(&logs)?;
    let log_path=logs.join(format!("install-local-{}-{}.log",stamp(),std::process::id()));
    let mut log=fs::File::create(&log_path)?;
    let result=(||->Result<()>{
        writeln!(log,"Selected browser: {browser}")?;
        // Run packaging in a child of this binary so every compiler diagnostic is retained.
        let mut build=Command::new(env::current_exe()?);
        build.arg("package").arg("--repo-dir").arg(repo);
        if logged_child(&mut build,&mut log)?!=0{return Err(err("Packaging failed; no browser modified"));}
        let mut installed=0;let mut failed=false;
        for target in targets{
            let mut cmd=if legacy_ui{
                let mut cmd=Command::new("powershell.exe");
                cmd.args(["-NoProfile","-STA","-ExecutionPolicy","RemoteSigned","-File"]);
                if target=="Firefox"{cmd.arg(repo.join("Installers/install_firefox_locally.ps1"));if let Some(p)=&paths[0]{cmd.args(["-FirefoxPath",p]);}}
                else{
                    cmd.arg(repo.join("Installers/install_chromium_locally.ps1")).args(["-ProductName",if target=="Chrome"{"Google Chrome"}else{"Chromium"}]);
                    if let Some(p)=&paths[if target=="Chrome"{2}else{1}]{cmd.args(["-BrowserPath",p]);}
                }
                cmd
            }else{
                let mut cmd=Command::new(env::current_exe()?);
                cmd.arg("native-ui").arg("--repo-dir").arg(repo).args(["--browser",target]);
                let index=if target=="Firefox"{0}else if target=="Chromium"{1}else{2};
                if let Some(p)=&paths[index]{cmd.arg(["--firefox-path","--chromium-path","--chrome-path"][index]).arg(p);}
                cmd
            };
            let code=logged_child(&mut cmd,&mut log)?;writeln!(log,"{target} exit code: {code}")?;
            if code==0{installed+=1;}else if !(code==2&&browser=="All"){failed=true;}
        }
        if failed||installed==0{return Err(err("One or more browser installs failed or no browser was installed"));}
        Ok(())
    })();
    writeln!(log,"Result: {}",if result.is_ok(){"success"}else{"failed"})?;drop(log);
    println!("Full diagnostic log: {}\n================ BEGIN FULL INSTALLER LOG ================\n{}\n================ END FULL INSTALLER LOG =================",log_path.display(),fs::read_to_string(&log_path)?);
    result
}
fn npm()->Command{
    if cfg!(windows){Command::new("npm.cmd")}else{Command::new("npm")}
}

fn local_firefox_command(repo:&Path,source:&Path)->Command{
    let mut command=npm();
    command.current_dir(repo).args(["exec","--yes","--package=web-ext@10.7.0","--","web-ext","run","--source-dir"]).arg(source)
        .args(["--no-config-discovery","--start-url","https://chatgpt.com/"]).env_remove("WEB_EXT_API_KEY").env_remove("WEB_EXT_API_SECRET");
    command
}
fn amo_command(repo:&Path,source:&Path,artifacts:&Path,key:&str,secret:&str)->Command{
    let mut command=npm();
    command.current_dir(repo).args(["exec","--yes","--package=web-ext@10.7.0","--","web-ext","sign","--source-dir"]).arg(source)
        .arg("--artifacts-dir").arg(artifacts).args(["--channel","listed","--approval-timeout","0","--no-input","--no-config-discovery"])
        .env("WEB_EXT_API_KEY",key).env("WEB_EXT_API_SECRET",secret);
    command
}
fn redact_release_output(bytes:&[u8],key:&str,secret:&str)->String{
    let text=String::from_utf8_lossy(bytes);
    let mut values=[key,secret];values.sort_by_key(|v|std::cmp::Reverse(v.len()));
    let mut result=String::new();let mut offset=0;
    while offset<text.len(){
        let remaining=&text[offset..];
        if let Some(value)=values.iter().find(|v|!v.is_empty()&&remaining.starts_with(**v)){
            result.push_str("[redacted]");offset+=value.len();
        }else{let ch=remaining.chars().next().unwrap();result.push(ch);offset+=ch.len_utf8();}
    }
    result
}
fn read_credentials_with(mut key:String,mut secret:String,interactive:bool,mut prompt:impl FnMut(&str)->Result<String>)->Result<(String,String)>{
    if key.trim().is_empty()||secret.trim().is_empty(){
        if !interactive{return Err(err("AMO credentials must be configured in the environment for noninteractive publishing"));}
        if key.trim().is_empty(){key=prompt("AMO API key (hidden): ")?;}
        if secret.trim().is_empty(){secret=prompt("AMO API secret (hidden): ")?;}
    }
    if key.trim().is_empty()||secret.trim().is_empty(){return Err(err("Both AMO credentials are required"));}
    Ok((key.trim().to_owned(),secret.trim().to_owned()))
}
fn finish_upload(local_only:bool,managed:bool,local_failed:bool,credentials:impl FnOnce()->Result<(String,String)>,submit:impl FnOnce((String,String))->Result<()>)->Result<()>{
    if local_only{return if local_failed{Err(err("Temporary Firefox test failed"))}else{Ok(())};}
    let values=credentials()?;
    submit(values)?;
    if local_failed&&!managed{return Err(err("AMO submission accepted, but temporary Firefox test failed; inspect logs before retrying."));}
    Ok(())
}
fn publish(repo:&Path,local_only:bool,configured:Option<(String,String)>)->Result<()>{
    let version=package(repo)?;
    let source=repo.join("build/firefox-src");let artifacts=repo.join("build/amo-artifacts");
    fs::create_dir_all(&artifacts)?;
    let logs=repo.join("build/logs");fs::create_dir_all(&logs)?;
    let output=fs::File::create(logs.join("upload-firefox-test.log"))?;
    let mut command=local_firefox_command(repo,&source);
    command.stdin(Stdio::null()).stdout(Stdio::from(output.try_clone()?)).stderr(Stdio::from(output));
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x00000200);}
    let managed=configured.is_some();
    let mut child=command.spawn()?;fs::write(logs.join("upload-firefox-test.pid"),format!("{}\n",child.id()))?;
    println!("Started isolated Firefox test for v{version}; see build/logs/upload-firefox-test.log.");
    let local_failed=if managed{false}else{
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(20);
        loop{
            let output=fs::read(logs.join("upload-firefox-test.log")).unwrap_or_default();
            let lower=String::from_utf8_lossy(&output).to_ascii_lowercase();
            if lower.contains("installed")&&lower.contains("temporary add-on"){break false;}
            if child.try_wait()?.is_some(){break true;}
            if std::time::Instant::now()>=deadline{break false;}
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    };
    if local_failed{eprintln!("Temporary Firefox test failed; see build/logs/upload-firefox-test.log.");}
    finish_upload(local_only,managed,local_failed,||match configured{Some(values)=>Ok(values),None=>credentials()},|(key,secret)|{
    // Never expose signing secrets on a command line or in raw logs.
    if key.trim().is_empty()||secret.trim().is_empty(){return Err(err("Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET before explicit publishing."));}
    let result=amo_command(repo,&source,&artifacts,&key,&secret).output()?;
    let redact=|bytes:&[u8]|redact_release_output(bytes,&key,&secret);
    let message=format!("{}\n{}",redact(&result.stdout),redact(&result.stderr));
    fs::write(logs.join("upload.log"),&message)?;println!("{message}");
    if !result.status.success(){return Err(err("AMO submission failed; see redacted upload.log"));}
    println!("AMO accepted the submission request; approval may remain pending.");
    Ok(())
    })
}
fn git_output(repo:&Path,args:&[&str])->Result<String>{
    let result=Command::new("git").current_dir(repo).args(args).output()?;
    if !result.status.success(){return Err(err(format!("Git {} failed",args.first().unwrap_or(&"command"))));}
    Ok(String::from_utf8(result.stdout)?.trim_end().to_owned())
}
fn credentials()->Result<(String,String)>{
    use std::io::IsTerminal;
    let key=env::var("WEB_EXT_API_KEY").unwrap_or_default();
    let secret=env::var("WEB_EXT_API_SECRET").unwrap_or_default();
    if key.trim().is_empty()||secret.trim().is_empty(){
        println!("Create AMO credentials at https://addons.mozilla.org/developers/addon/api/key/");
    }
    read_credentials_with(key,secret,io::stdin().is_terminal(),|prompt|Ok(rpassword::prompt_password(prompt)?))
}
fn managed_publish(repo:&Path)->Result<()>{
    managed_publish_with(repo,||{
        secrets::require_clean(repo)?;
        package(repo)?;
        checked(npm().current_dir(repo).args(["ci","--ignore-scripts","--no-audit","--no-fund"]))?;
        checked(npm().current_dir(repo).args(["run","check"]))?;
        checked(Command::new("cargo").current_dir(repo).args(["test","--manifest-path","Installers/native/Cargo.toml"]))?;
        for (_,source) in MODULES{
            let executable=repo.join("build").join(format!("release-test-{}{}",source.trim_end_matches(".rs"),env::consts::EXE_SUFFIX));
            checked(Command::new("rustc").current_dir(repo).args(["--edition=2021","--test"]).arg(repo.join("rust").join(source)).arg("-o").arg(&executable))?;
            checked(&mut Command::new(&executable))?;
        }
        Ok(())
    },credentials,|values|publish(repo,false,Some(values)))
}
fn managed_publish_with(repo:&Path,preflight:impl FnOnce()->Result<()>,get_credentials:impl FnOnce()->Result<(String,String)>,submit:impl FnOnce((String,String))->Result<()>)->Result<()>{
    let top=PathBuf::from(git_output(repo,&["rev-parse","--show-toplevel"])?).canonicalize()?;
    if top!=repo||git_output(repo,&["branch","--show-current"])?!="main"{
        return Err(err("Publishing requires the intended checkout root and main branch"));
    }
    let clean=||git_output(repo,&["status","--porcelain","--untracked-files=normal"]);
    if !clean()?.is_empty(){return Err(err("Working tree must be clean before publishing"));}
    git_output(repo,&["remote","get-url","origin"])?;
    checked(Command::new("git").current_dir(repo).args(["pull","--ff-only","origin","main"]))?;
    if !clean()?.is_empty(){return Err(err("Working tree changed while pulling main"));}
    preflight()?;
    if !clean()?.is_empty(){return Err(err("Preflight produced unexpected tracked changes"));}
    let credentials=get_credentials()?;
    let path=repo.join("manifest.json");
    let original=fs::read_to_string(&path)?;
    let mut base:Value=serde_json::from_str(&original)?;
    let version=base["version"].as_str().ok_or_else(||err("Missing version"))?;
    let next=next_patch_version(version)?;
    base["version"]=json!(next);
    fs::write(&path,serde_json::to_string_pretty(&base)?+"\n")?;
    let submission=submit(credentials);
    if let Err(e)=submission{
        eprintln!("Keeping the bumped manifest because submission may already have started. Inspect AMO and git status before retrying.");
        return Err(e);
    }
    if clean()? !=" M manifest.json"{return Err(err("Unexpected changes after submission; refusing automatic commit"));}
    checked(Command::new("git").current_dir(repo).args(["add","--","manifest.json"]))?;
    checked(Command::new("git").current_dir(repo).args(["commit","-m",&format!("chore(release): Firefox extension v{next}")]))?;
    checked(Command::new("git").current_dir(repo).args(["push","origin","main"]))?;
    println!("Release {next} submitted and version committed/pushed; Mozilla approval may remain pending.");
    Ok(())
}
fn build_only(repo:&Path)->Result<()>{
    let dir=repo.join("build");fs::create_dir_all(&dir)?;
    let stage=dir.join(format!("wasm-stage-{}-{}",std::process::id(),stamp()));
    fs::create_dir(&stage)?;let _cleanup=Cleanup(stage.clone());
    build_wasm(repo,&stage)?;
    for &(name,_) in MODULES{let file=format!("{name}.wasm");publish_path(&stage.join(&file),&repo.join(&file))?;}
    publish_path(&stage.join(wasm_bindings::OUTPUT),&repo.join(wasm_bindings::OUTPUT))?;
    publish_path(&stage.join(browser_api_bindings::OUTPUT),&repo.join(browser_api_bindings::OUTPUT))?;
    publish_path(&stage.join(history_viewer_bindings::OUTPUT),&repo.join(history_viewer_bindings::OUTPUT))?;
    publish_path(&stage.join(history_store_bindings::OUTPUT),&repo.join(history_store_bindings::OUTPUT))?;
    publish_path(&stage.join(queue_bindings::OUTPUT),&repo.join(queue_bindings::OUTPUT))?;
    publish_path(&stage.join(content_bindings::OUTPUT),&repo.join(content_bindings::OUTPUT))?;
    publish_path(&stage.join(popup_bindings::OUTPUT),&repo.join(popup_bindings::OUTPUT))?;
    publish_path(&stage.join(browser_bridge_bindings::OUTPUT),&repo.join(browser_bridge_bindings::OUTPUT))?;
    publish_path(&stage.join(background_bindings::OUTPUT),&repo.join(background_bindings::OUTPUT))?;
    Ok(())
}

fn next_patch_version(version:&str)->Result<String>{
    let parts=version.split('.').map(str::parse::<u32>).collect::<std::result::Result<Vec<_>,_>>()?;
    if parts.len()!=3{return Err(err("Expected three-part version"));}
    Ok(format!("{}.{}.{}",parts[0],parts[1],parts[2].checked_add(1).ok_or_else(||err("Version overflow"))?))
}

#[cfg(target_os="macos")]
fn install_upload_launcher(repo:&Path)->Result<()>{
    use std::os::unix::fs::PermissionsExt;
    let dir=repo.join("upload.app/Contents/MacOS");
    fs::create_dir_all(&dir)?;
    let target=dir.join("upload");
    let temp=dir.join(format!(".upload-{}-{}",std::process::id(),stamp()));
    fs::copy(env::current_exe()?,&temp)?;
    fs::set_permissions(&temp,fs::Permissions::from_mode(0o755))?;
    if let Err(error)=publish_path(&temp,&target){let _=fs::remove_file(&temp);return Err(error);}
    println!("Native macOS publisher ready: {}",repo.join("upload.app").display());
    Ok(())
}
#[cfg(not(target_os="macos"))]
fn install_upload_launcher(_repo:&Path)->Result<()>{
    Err(err("Build the macOS publisher on macOS"))
}

#[cfg(target_os="macos")]
fn macos_upload_launcher(executable:&Path)->Result<()>{
    let repo=executable.ancestors().nth(4).ok_or_else(||err("Invalid upload.app path"))?.canonicalize()?;
    if !repo.join("manifest.json").is_file(){return Err(err("Keep upload.app in the extension checkout"));}
    // Finder launches without a TTY and often without the user's PATH.
    // Terminal provides interactive hidden credential prompts. Pass paths
    // as osascript arguments and quote them inside AppleScript.
    let script=r#"on run argv
set executablePath to item 1 of argv
set repoPath to item 2 of argv
tell application "Terminal"
activate
do script "cd " & quoted form of repoPath & " && " & quoted form of executablePath & " publish --repo-dir " & quoted form of repoPath
end tell
end run"#;
    checked(Command::new("/usr/bin/osascript").arg("-e").arg(script).arg(executable).arg(repo))
}

fn run()->Result<()>{
    let mut args=env::args().skip(1);
    #[cfg(target_os="macos")]
    {
        let executable=env::current_exe()?;
        if executable.file_name().and_then(|v|v.to_str())==Some("upload")&&env::args().skip(1).all(|v|v.starts_with("-psn_")){
            return macos_upload_launcher(&executable);
        }
    }
    let action=args.next().unwrap_or_else(||"package".into());
    let mut repo=None;let mut browser=String::new();let mut paths=[None,None,None];let mut local_only=false;let mut legacy_ui=false;
    while let Some(arg)=args.next(){match arg.as_str(){
        "--repo-dir"|"--repo-root"=>repo=Some(PathBuf::from(args.next().ok_or_else(||err("Missing repository path"))?)),
        "--browser"|"-Browser"=>browser=args.next().ok_or_else(||err("Missing browser"))?,
        "--firefox-path"|"-FirefoxPath"=>paths[0]=Some(args.next().ok_or_else(||err("Missing Firefox path"))?),
        "--chromium-path"|"-ChromiumPath"=>paths[1]=Some(args.next().ok_or_else(||err("Missing Chromium path"))?),
        "--chrome-path"|"-ChromePath"=>paths[2]=Some(args.next().ok_or_else(||err("Missing Chrome path"))?),
        "--local-only"=>local_only=true,"--legacy-ui"|"-LegacyUI"=>legacy_ui=true,_=>return Err(err(format!("Unknown argument: {arg}")))
    }}
    let repo=repo.unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")).canonicalize()?;
    if action=="check-secrets"{
        let status=secrets::run(&repo);
        if status!=0{std::process::exit(status);}
        return Ok(());
    }
    if !repo.join("manifest.json").is_file(){return Err(err("Missing extension manifest"));}
    match action.as_str(){"package"=>{package(&repo)?;},"build"=>build_only(&repo)?,"install"=>install(&repo,&browser,&paths,legacy_ui)?,
        "native-ui"=>{
            #[cfg(windows)]{
                let index=match browser.as_str(){"Firefox"=>0,"Chromium"=>1,"Chrome"=>2,_=>return Err(err("Select one browser for native UI"))};
                let code=windows_ui::install(&repo,&browser,paths[index].as_deref())?;
                if code!=0{std::process::exit(code);}
            }
            #[cfg(not(windows))]{return Err(err("Native Windows UI Automation requires Windows"));}
        },
        "publish"=>publish(&repo,local_only,None)?, "managed-publish"=>managed_publish(&repo)?, "install-upload-launcher"=>install_upload_launcher(&repo)?,_=>return Err(err("Expected build, package, install, native-ui, publish, managed-publish, install-upload-launcher or check-secrets"))}
    Ok(())
}
fn main(){if let Err(error)=run(){eprintln!("[ERROR] {error}");std::process::exit(1);}}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn patch_version_validation(){
        assert_eq!(next_patch_version("1.0.7").unwrap(),"1.0.8");
        assert_eq!(next_patch_version("0.9.99").unwrap(),"0.9.100");
        for invalid in ["1.0","1.0.0.1","1.0.beta","1.0.4294967295",""]{assert!(next_patch_version(invalid).is_err());}
        let mut manifest=json!({"name":"Demo","version":"1.0.7","other":true});
        manifest["version"]=json!(next_patch_version(manifest["version"].as_str().unwrap()).unwrap());
        assert_eq!(manifest,json!({"name":"Demo","version":"1.0.8","other":true}));
    }
    #[test]fn managed_publish_refuses_invalid_checkout_before_any_external_effect(){
        let root=env::temp_dir().join(format!("cpo-release-guard-{}-{}",std::process::id(),fixture_stamp()));
        fs::create_dir_all(&root).unwrap();
        let _cleanup=Cleanup(root.clone());
        let root=root.canonicalize().unwrap();
        checked(Command::new("git").current_dir(&root).args(["init","-b","main"])).unwrap();
        fs::write(root.join("manifest.json"),r#"{"version":"1.0.7"}"#).unwrap();
        checked(Command::new("git").current_dir(&root).args(["add","manifest.json"])).unwrap();
        checked(Command::new("git").current_dir(&root).args(["-c","user.name=CPO Test","-c","user.email=test@example.invalid","commit","-m","fixture"])).unwrap();
        fs::write(root.join("dirty.txt"),"untracked").unwrap();
        assert!(managed_publish(&root).unwrap_err().to_string().contains("clean"));
        assert_eq!(fs::read_to_string(root.join("manifest.json")).unwrap(),r#"{"version":"1.0.7"}"#);
        fs::remove_file(root.join("dirty.txt")).unwrap();
        checked(Command::new("git").current_dir(&root).args(["switch","-c","feature"])).unwrap();
        assert!(managed_publish(&root).unwrap_err().to_string().contains("main branch"));
        assert_eq!(fs::read_to_string(root.join("manifest.json")).unwrap(),r#"{"version":"1.0.7"}"#);
    }
    #[test]fn manifest_conversion(){
        let base=json!({"manifest_version":3,"name":"test","description":"test","version":"1.0","action":{},
            "permissions":["storage","alarms"],"host_permissions":["storage"],"commands":{},"content_scripts":[],"icons":{}});
        let result=firefox_manifest(&base).unwrap();assert_eq!(result["manifest_version"],2);
        assert_eq!(result["browser_specific_settings"]["gecko"]["id"],ID);
        assert_eq!(result["permissions"],json!(["alarms","storage"]));
    }
}
