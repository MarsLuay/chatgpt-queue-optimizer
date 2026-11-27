use serde_json::{json, Value};
use std::{env, fs, io::{self, Write, BufRead, BufReader}, path::{Path, PathBuf}, process::{Command, Stdio}, time::{SystemTime, UNIX_EPOCH}};
use zip::{ZipWriter, write::FileOptions};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const ID: &str = "chatgpt-queue-optimizer@marsluay.local";
const FILES: &[&str] = &["manifest.json","background.js","rust-queue-bridge.js","content.js","rust-browser-bridge.js","provider-adapter.js","utils.js","popup.html","popup.js","options.html","history-viewer.html","history-viewer.js","history-store.js","history-viewer.css","styles.css","icon_16.png","icon_48.png","icon_128.png","optimizer_core.wasm","optimizer_browser.wasm","optimizer_history.wasm","optimizer_queue.wasm"];
const MODULES: &[(&str,&str)] = &[("optimizer_core","optimizer_core.rs"),("optimizer_browser","browser_engine.rs"),("optimizer_history","history_engine.rs"),("optimizer_queue","queue_engine.rs")];
fn err(message: impl Into<String>) -> Box<dyn std::error::Error> { io::Error::new(io::ErrorKind::Other,message.into()).into() }
fn stamp()->u128 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()}
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
        "background":{"scripts":["utils.js","rust-queue-bridge.js","provider-adapter.js","background.js"],"persistent":true},
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
            let src=if asset.ends_with(".wasm"){stage.join(asset)}else{repo.join(asset)};
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
fn install(repo:&Path, browser:&str, paths:&[Option<String>;3])->Result<()>{
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
            let mut cmd=Command::new("powershell.exe");
            cmd.args(["-NoProfile","-STA","-ExecutionPolicy","RemoteSigned","-File"]);
            if target=="Firefox"{cmd.arg(repo.join("Installers/install_firefox_locally.ps1"));if let Some(p)=&paths[0]{cmd.args(["-FirefoxPath",p]);}}
            else{
                cmd.arg(repo.join("Installers/install_chromium_locally.ps1")).args(["-ProductName",if target=="Chrome"{"Google Chrome"}else{"Chromium"}]);
                if let Some(p)=&paths[if target=="Chrome"{2}else{1}]{cmd.args(["-BrowserPath",p]);}
            }
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
fn publish(repo:&Path,local_only:bool)->Result<()>{
    let version=package(repo)?;
    let source=repo.join("build/firefox-src");let artifacts=repo.join("build/amo-artifacts");
    fs::create_dir_all(&artifacts)?;
    let logs=repo.join("build/logs");fs::create_dir_all(&logs)?;
    let output=fs::File::create(logs.join("upload-firefox-test.log"))?;
    let mut command=npm();
    command.current_dir(repo).args(["exec","--yes","--package=web-ext@10.7.0","--","web-ext","run","--source-dir"]).arg(&source)
        .args(["--no-config-discovery","--start-url","https://chatgpt.com/"]).env_remove("WEB_EXT_API_KEY").env_remove("WEB_EXT_API_SECRET")
        .stdin(Stdio::null()).stdout(Stdio::from(output.try_clone()?)).stderr(Stdio::from(output));
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x00000200);}
    let child=command.spawn()?;fs::write(logs.join("upload-firefox-test.pid"),format!("{}\n",child.id()))?;
    println!("Started isolated Firefox test for v{version}; see build/logs/upload-firefox-test.log.");
    if local_only{return Ok(());}
    // Never expose signing secrets on a command line or in raw logs.
    let key=env::var("WEB_EXT_API_KEY").unwrap_or_default();let secret=env::var("WEB_EXT_API_SECRET").unwrap_or_default();
    if key.trim().is_empty()||secret.trim().is_empty(){return Err(err("Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET before explicit publishing."));}
    let result=npm().current_dir(repo).args(["exec","--yes","--package=web-ext@10.7.0","--","web-ext","sign","--source-dir"]).arg(&source)
        .arg("--artifacts-dir").arg(&artifacts).args(["--channel","listed","--approval-timeout","0","--no-input","--no-config-discovery"]).output()?;
    let redact=|bytes:&[u8]|String::from_utf8_lossy(bytes).replace(&key,"[redacted]").replace(&secret,"[redacted]");
    let message=format!("{}\n{}",redact(&result.stdout),redact(&result.stderr));
    fs::write(logs.join("upload.log"),&message)?;println!("{message}");
    if !result.status.success(){return Err(err("AMO submission failed; see redacted upload.log"));}
    println!("AMO accepted the submission request; approval may remain pending.");Ok(())
}
fn run()->Result<()>{
    let mut args=env::args().skip(1);
    let action=args.next().unwrap_or_else(||"package".into());
    let mut repo=None;let mut browser=String::new();let mut paths=[None,None,None];let mut local_only=false;
    while let Some(arg)=args.next(){match arg.as_str(){
        "--repo-dir"=>repo=Some(PathBuf::from(args.next().ok_or_else(||err("Missing repository path"))?)),
        "--browser"=>browser=args.next().ok_or_else(||err("Missing browser"))?,
        "--firefox-path"=>paths[0]=Some(args.next().ok_or_else(||err("Missing Firefox path"))?),
        "--chromium-path"=>paths[1]=Some(args.next().ok_or_else(||err("Missing Chromium path"))?),
        "--chrome-path"=>paths[2]=Some(args.next().ok_or_else(||err("Missing Chrome path"))?),
        "--local-only"=>local_only=true,_=>return Err(err(format!("Unknown argument: {arg}")))
    }}
    let repo=repo.unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")).canonicalize()?;
    if !repo.join("manifest.json").is_file(){return Err(err("Missing extension manifest"));}
    match action.as_str(){"package"=>{package(&repo)?;},"install"=>install(&repo,&browser,&paths)?,
        "publish"=>publish(&repo,local_only)?,_=>return Err(err("Expected package, install or publish"))}
    Ok(())
}
fn main(){if let Err(error)=run(){eprintln!("[ERROR] {error}");std::process::exit(1);}}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn manifest_conversion(){
        let base=json!({"manifest_version":3,"name":"test","description":"test","version":"1.0","action":{},
            "permissions":["storage","alarms"],"host_permissions":["storage"],"commands":{},"content_scripts":[],"icons":{}});
        let result=firefox_manifest(&base).unwrap();assert_eq!(result["manifest_version"],2);
        assert_eq!(result["browser_specific_settings"]["gecko"]["id"],ID);
        assert_eq!(result["permissions"],json!(["alarms","storage"]));
    }
}
