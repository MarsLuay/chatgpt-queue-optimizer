//! Shared, validated local browser artifacts. Browser UI is platform-specific.
use super::{err,Result,ID,copy_tree,publish_path,stamp,Cleanup};
use std::{fs,path::{Path,PathBuf},io::Read};
use sha2::{Digest,Sha256};
use base64::Engine;
use serde_json::Value;
pub(super) const NAME:&str="ChatGPT Queue + Optimizer";
const KEY:&str="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0cV7LPS/vHIVWJGrcghAd2TIgknmbP4Xdq+INlbS8W638gPxBGtZRe0pyh8op8zzg0JrtctPBk7+AKZEg/5Iaa3J8xzh10uWiPUg3w4cqS3FlKeDfCYTzXzUtY3BgX4XlUKy+D8lSBioarW02Q+tY8+TdVB3B0BE7mNIswKCkiKwKSA/2DlkboEE7BdhWnFu8C8XBI7u+uco2xDgvaGdUCn28MEwfI8lxgkTIW6+Sn99pKS4wDQEMKlCGpRevxAg3mD5MBYZoA2C2v8vDfCBNw+4TvlrWuKUb7X5cg0PME1SDq03lWqHxJgXYDm5XHrn6dNO7Wbc4MlstG0XzqxlyQIDAQAB";
pub(super) fn prepare(repo:&Path,firefox:bool)->Result<(PathBuf,String)>{
    let expected:Value=serde_json::from_slice(&fs::read(repo.join("manifest.json"))?)?;
    let build=repo.join("build");
    if firefox{
        let bytes=fs::read(build.join("chatgpt-queue-optimizer-firefox-store.zip"))?;
        let mut zip=zip::ZipArchive::new(std::io::Cursor::new(&bytes))?;
        let mut entry=zip.by_name("manifest.json")?;
        if entry.size()>1048576{return Err(err("Invalid XPI manifest"));}
        let mut raw=String::new();entry.read_to_string(&mut raw)?;
        let m:Value=serde_json::from_str(&raw)?;
        if m["name"]!=NAME||m["manifest_version"]!=2||m["version"]!=expected["version"]||m["browser_specific_settings"]["gecko"]["id"]!=ID{return Err(err("Firefox package identity mismatch"));}
        let dir=build.join("local-firefox");fs::create_dir_all(&dir)?;
        let path=dir.join(format!("chatgpt-queue-optimizer-{:x}.xpi",Sha256::digest(&bytes)));
        if path.exists(){if fs::read(&path)?!=bytes{return Err(err("Cached XPI mismatch"));}}else{let temp=dir.join(format!("stage-{}-{}",std::process::id(),stamp()));fs::write(&temp,&bytes)?;publish_path(&temp,&path)?;}
        Ok((path.canonicalize()?,ID.into()))
    }else{
        let src=build.join("chrome-src");let mut m:Value=serde_json::from_slice(&fs::read(src.join("manifest.json"))?)?;
        if m["name"]!=NAME||m["manifest_version"]!=3||m["version"]!=expected["version"]{return Err(err("Chromium manifest mismatch"));}
        m["key"]=Value::String(KEY.into());
        let hash=Sha256::digest(base64::engine::general_purpose::STANDARD.decode(KEY)?);
        let id:String=hash[..16].iter().flat_map(|b|[char::from(b'a'+(b>>4)),char::from(b'a'+(b&15))]).collect();
        let dir=build.join("local-chromium");fs::create_dir_all(&dir)?;
        let stage=dir.join(format!("stage-{}-{}",std::process::id(),stamp()));
        fs::create_dir(&stage)?;let _cleanup=Cleanup(stage.clone());
        copy_tree(&src,&stage)?;fs::write(stage.join("manifest.json"),serde_json::to_vec_pretty(&m)?)?;
        let path=dir.join("extension");publish_path(&stage,&path)?;
        Ok((path.canonicalize()?,id))
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn local_chromium_key_is_stable(){
        let hash=Sha256::digest(base64::engine::general_purpose::STANDARD.decode(KEY).unwrap());
        let id:String=hash[..16].iter().flat_map(|b|[char::from(b'a'+(b>>4)),char::from(b'a'+(b&15))]).collect();
        assert_eq!(id.len(),32);
        assert!(id.bytes().all(|b|(b'a'..=b'p').contains(&b)));
    }
}
