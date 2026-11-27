use super::*;

#[test]
fn release_commands_and_environment_are_safe(){
    let repo=Path::new(".");
    let source=Path::new("firefox-src");
    let artifacts=Path::new("artifacts");
    let local=local_firefox_command(repo,source);
    let args=local.get_args().map(|a|a.to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert!(args.contains(&"run".into()));
    assert!(args.contains(&"--start-url".into()));
    assert!(!args.contains(&"--firefox-profile".into()));
    assert!(!args.contains(&"--keep-profile-changes".into()));
    for name in ["WEB_EXT_API_KEY","WEB_EXT_API_SECRET"]{assert!(local.get_envs().any(|(k,v)|k==name&&v.is_none()));}
    let submit=amo_command(repo,source,artifacts,"fixture-issuer","fixture-secret");
    let args=submit.get_args().map(|a|a.to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert!(args.contains(&"sign".into()));
    assert!(args.windows(2).any(|a|a[0]=="--channel"&&a[1]=="listed"));
    assert!(args.windows(2).any(|a|a[0]=="--approval-timeout"&&a[1]=="0"));
    assert!(args.contains(&"--no-input".into()));
    assert!(!args.join(" ").contains("fixture-secret"));
    assert!(!args.join(" ").contains("fixture-issuer"));
    assert!(submit.get_envs().any(|(k,v)|k=="WEB_EXT_API_KEY"&&v==Some(std::ffi::OsStr::new("fixture-issuer"))));
    assert!(submit.get_envs().any(|(k,v)|k=="WEB_EXT_API_SECRET"&&v==Some(std::ffi::OsStr::new("fixture-secret"))));
}
#[test]
fn credential_prompts_and_redaction(){
    let mut count=0;
    let values=read_credentials_with("".into(),"".into(),true,|_|{count+=1;Ok(if count==1{" issuer "}else{" secret "}.into())}).unwrap();
    assert_eq!(values,("issuer".into(),"secret".into()));
    assert_eq!(count,2);
    assert!(read_credentials_with("issuer".into(),"secret".into(),false,|_|panic!("Unexpected prompt")).is_ok());
    assert!(read_credentials_with("".into(),"".into(),false,|_|panic!("Unexpected prompt")).is_err());
    assert!(read_credentials_with("issuer".into(),"".into(),true,|_|Ok(" ".into())).is_err());
    let output=redact_release_output(b"issuer issuer-secret secret", "issuer", "issuer-secret");
    assert_eq!(output,"[redacted] [redacted] secret");
}
#[test]
fn platform_launchers_use_rust(){
    let repo=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let batch=fs::read_to_string(repo.join("upload.bat")).unwrap();
    assert!(batch.contains("managed-publish"));
    assert!(batch.contains(r#"--repo-dir "%REPO_ROOT%.""#));
    assert!(batch.to_ascii_lowercase().contains("pause >nul"));
    assert!(batch.contains("exit /b %UPLOAD_EXIT%"));
    let plist=fs::read_to_string(repo.join("upload.app/Contents/Info.plist")).unwrap();
    assert!(plist.contains("<key>CFBundleExecutable</key>"));
    assert!(plist.contains("<string>upload</string>"));
}
struct Fixture{_cleanup:Cleanup,root:PathBuf,remote:PathBuf}
impl Fixture{
    fn new()->Self{
        let dir=env::temp_dir().join(format!("cpo-release-flow-{}-{}",std::process::id(),fixture_stamp()));
        fs::create_dir_all(&dir).unwrap();
        let root=dir.join("local");let remote=dir.join("remote.git");
        fs::create_dir(&root).unwrap();
        let root=root.canonicalize().unwrap();
        checked(Command::new("git").args(["init","--bare"]).arg(&remote)).unwrap();
        checked(Command::new("git").current_dir(&root).args(["init","-b","main"])).unwrap();
        for (key,value) in [("user.name","CPO Test"),("user.email","test@example.invalid")]{checked(Command::new("git").current_dir(&root).args(["config",key,value])).unwrap();}
        fs::write(root.join("manifest.json"),r#"{"version":"1.0.7","name":"Demo"}"#).unwrap();
        checked(Command::new("git").current_dir(&root).args(["add","manifest.json"])).unwrap();
        checked(Command::new("git").current_dir(&root).args(["commit","-m","fixture"])).unwrap();
        checked(Command::new("git").current_dir(&root).args(["remote","add","origin"]).arg(&remote)).unwrap();
        checked(Command::new("git").current_dir(&root).args(["push","origin","main"])).unwrap();
        Self{_cleanup:Cleanup(dir),root,remote}
    }
    fn version(&self)->String{serde_json::from_slice::<Value>(&fs::read(self.root.join("manifest.json")).unwrap()).unwrap()["version"].as_str().unwrap().to_owned()}
    fn head(&self)->String{git_output(&self.root,&["rev-parse","HEAD"]).unwrap()}
    fn remote_head(&self)->String{git_output(&self.remote,&["rev-parse","refs/heads/main"]).unwrap()}
}
#[test]
fn failed_preflight_never_changes_version_or_submits(){
    let f=Fixture::new();let head=f.head();
    assert!(managed_publish_with(&f.root,||Err(err("preflight failure")),||panic!("credentials before preflight"),|_|panic!("submission before preflight")).is_err());
    assert_eq!(f.version(),"1.0.7");assert_eq!(f.head(),head);
}
#[test]
fn managed_publish_orders_validation_credentials_submission_and_commit(){
    let f=Fixture::new();let events=std::cell::RefCell::new(Vec::new());let before=f.head();
    managed_publish_with(&f.root,||{events.borrow_mut().push("preflight");assert_eq!(f.version(),"1.0.7");Ok(())},
        ||{events.borrow_mut().push("credentials");Ok(("key".into(),"secret".into()))},
        |values|{events.borrow_mut().push("submit");assert_eq!(values,("key".into(),"secret".into()));assert_eq!(f.version(),"1.0.8");assert_eq!(f.head(),before);Ok(())}).unwrap();
    assert_eq!(*events.borrow(),vec!["preflight","credentials","submit"]);
    assert_ne!(f.head(),before);assert_eq!(f.head(),f.remote_head());
}
#[test]
fn failed_submission_keeps_version_without_commit(){
    let f=Fixture::new();let before=f.head();
    assert!(managed_publish_with(&f.root,||Ok(()),||Ok(("key".into(),"secret".into())),|_|Err(err("simulated submission failure"))).is_err());
    assert_eq!(f.version(),"1.0.8");assert_eq!(f.head(),before);assert_eq!(f.remote_head(),before);
}
#[test]
fn failed_push_preserves_local_release_commit(){
    let f=Fixture::new();let before=f.head();
    assert!(managed_publish_with(&f.root,||Ok(()),||Ok(("key".into(),"secret".into())),|_|{
        fs::rename(&f.remote,f.remote.with_extension("offline"))?;Ok(())
    }).is_err());
    assert_eq!(f.version(),"1.0.8");assert_ne!(f.head(),before);
    assert!(git_output(&f.root,&["log","-1","--format=%s"]).unwrap().contains("1.0.8"));
}

#[test]
fn upload_settlement_preserves_local_and_remote_outcomes(){
    let events=std::cell::RefCell::new(Vec::new());
    let credential=||{events.borrow_mut().push("credentials");Ok(("issuer".into(),"secret".into()))};
    let submit=|_values|{events.borrow_mut().push("submit");Ok(())};
    assert!(finish_upload(false,false,true,credential,submit).is_err());
    assert_eq!(*events.borrow(),vec!["credentials","submit"]);
    events.borrow_mut().clear();
    assert!(finish_upload(false,true,true,credential,submit).is_ok());
    assert_eq!(*events.borrow(),vec!["credentials","submit"]);
    assert!(finish_upload(true,false,false,||panic!("credentials for local-only"),|_|panic!("local-only submitted")).is_ok());
    assert!(finish_upload(true,false,true,||panic!("credentials for local-only"),|_|panic!("local-only submitted")).is_err());
    assert!(finish_upload(false,false,false,||Err(err("missing credentials")),|_|panic!("submitted without credentials")).is_err());
}
