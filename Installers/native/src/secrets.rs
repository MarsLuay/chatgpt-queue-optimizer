//! Tracked working-tree PEM scanner. Never prints file contents.
use std::{fs,io::{self,BufRead,BufReader},path::{Path,PathBuf},process::{Command,Stdio}};
const PREFIX:&[u8]=b"-----BEGIN ";
const SUFFIX:&[u8]=b"-----";
const LABEL:&[u8]=b"PRIVATE KEY";

fn header(line:&[u8])->bool{
    let start=line.iter().position(|b|!b.is_ascii_whitespace()).unwrap_or(line.len());
    let end=line.iter().rposition(|b|!b.is_ascii_whitespace()).map_or(start,|i|i+1);
    let line=&line[start..end];
    let Some(label)=line.strip_prefix(PREFIX).and_then(|v|v.strip_suffix(SUFFIX)) else{return false;};
    label.windows(LABEL.len()).any(|v|v==LABEL)&&label.iter().all(|b|*b==b' '||b.is_ascii_digit()||b.is_ascii_uppercase())
}
fn scan(reader:impl BufRead)->io::Result<bool>{
    // Bounded streaming: a valid label may be arbitrarily long, so maintain
    // header recognition state over chunks instead of buffering entire files.
    let mut reader=reader;
    let mut state=HeaderState::default();
    loop{
        let buf=reader.fill_buf()?;
        if buf.is_empty(){return Ok(state.finish());}
        for &byte in buf{
            if matches!(byte,b'\n'|b'\r'){
                if state.finish(){return Ok(true);}
                state=HeaderState::default();
            }else{state.push(byte);}
        }
        let n=buf.len();reader.consume(n);
    }
}
#[derive(Default)]
struct HeaderState{prefix:usize,started:bool,invalid:bool,label_len:usize,matched:usize,found:bool,dashes:usize,trailing:bool}
impl HeaderState{
    fn push(&mut self,b:u8){
        if self.invalid{return;}
        if !self.started{if b.is_ascii_whitespace(){return;}self.started=true;}
        if self.prefix<PREFIX.len(){
            if b==PREFIX[self.prefix]{self.prefix+=1;}else{self.invalid=true;}
            return;
        }
        if self.trailing{if !b.is_ascii_whitespace(){self.invalid=true;}return;}
        if b==b'-'{self.dashes+=1;if self.dashes>SUFFIX.len(){self.invalid=true;}return;}
        if self.dashes>0{
            if self.dashes==SUFFIX.len()&&b.is_ascii_whitespace(){self.trailing=true;}else{self.invalid=true;}
            return;
        }
        if !(b==b' '||b.is_ascii_digit()||b.is_ascii_uppercase()){self.invalid=true;return;}
        self.label_len+=1;
        if !self.found{
            if b==LABEL[self.matched]{self.matched+=1;if self.matched==LABEL.len(){self.found=true;}}
            else{self.matched=usize::from(b==LABEL[0]);}
        }
    }
    fn finish(&self)->bool{!self.invalid&&self.prefix==PREFIX.len()&&self.found&&self.dashes==SUFFIX.len()}
}

#[cfg(unix)]
fn filename(bytes:&[u8])->io::Result<PathBuf>{
    use std::os::unix::ffi::OsStrExt;
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}
#[cfg(not(unix))]
fn filename(bytes:&[u8])->io::Result<PathBuf>{
    std::str::from_utf8(bytes).map(PathBuf::from).map_err(|_|io::Error::new(io::ErrorKind::InvalidData,"Invalid tracked path"))
}
#[derive(Default,Debug)]
struct Report{violations:Vec<PathBuf>,errors:Vec<PathBuf>}
fn check(root:&Path)->io::Result<Report>{
    let root=root.canonicalize()?;
    let output=Command::new("git").current_dir(&root).args(["ls-files","-z"]).stderr(Stdio::null()).output()?;
    if !output.status.success(){return Err(io::Error::new(io::ErrorKind::Other,"Could not enumerate tracked files"));}
    let mut report=Report::default();
    for name in output.stdout.split(|b|*b==0).filter(|v|!v.is_empty()){
        let relative=filename(name)?;
        let path=root.join(&relative);
        let meta=match fs::symlink_metadata(&path){Ok(v)=>v,Err(e) if e.kind()==io::ErrorKind::NotFound=>continue,Err(_)=>{report.errors.push(relative);continue;}};
        if meta.file_type().is_symlink()||!meta.is_file(){continue;}
        let resolved=match path.canonicalize(){Ok(v) if v.starts_with(&root)=>v,_=>{report.errors.push(relative);continue;}};
        match fs::File::open(resolved).and_then(|file|scan(BufReader::new(file))){
            Ok(true)=>report.violations.push(relative),Ok(false)=>{},Err(_)=>report.errors.push(relative)
        }
    }
    Ok(report)
}
pub fn run(root:&Path)->i32{
    match check(root){
        Err(_)=>{eprintln!("ERROR: tracked-file secret check could not inspect the repository.");2},
        Ok(report) if !report.errors.is_empty()=>{
            for path in report.errors{eprintln!("ERROR: tracked file could not be inspected safely: {:?}",path);}
            2
        },
        Ok(report) if !report.violations.is_empty()=>{
            for path in report.violations{eprintln!("ERROR: tracked file contains prohibited PEM private-key material: {:?}",path);}
            1
        },
        Ok(_)=>{println!("Tracked-file secret check passed.");0}
    }
}
pub fn require_clean(root:&Path)->super::Result<()>{
    if run(root)==0{Ok(())}else{Err(super::err("Tracked-file secret check failed"))}
}
#[cfg(test)]
mod tests{
    use super::*;
    fn marker(label:&str)->Vec<u8>{[PREFIX,label.as_bytes(),SUFFIX].concat()}
    #[test]fn pem_variants_and_chunk_boundaries(){
        for name in ["RSA PRIVATE KEY","EC PRIVATE KEY","ENCRYPTED PRIVATE KEY","OPENSSH PRIVATE KEY","PRIVATE KEY"]{
            let data=marker(name);
            assert!(header(&data));
            assert!(scan(BufReader::with_capacity(3,data.as_slice())).unwrap());
        }
        for name in ["CERTIFICATE","PUBLIC KEY","PRIVATE KEY lower","PRIVATE-KEY"]{
            let data=marker(name);
            assert!(!scan(BufReader::with_capacity(2,data.as_slice())).unwrap());
        }
        let long=marker(&format!("{} PRIVATE KEY","A".repeat(100_000)));
        assert!(scan(BufReader::with_capacity(7,long.as_slice())).unwrap());
        assert!(scan(BufReader::new([b"\t".as_slice(),marker("PRIVATE KEY").as_slice(),b" \r\n"].concat().as_slice())).unwrap());
    }
    #[test]fn tracked_only_and_redacted_reports(){
        let root=std::env::temp_dir().join(format!("cpo-secrets-{}-{}",std::process::id(),super::super::stamp()));
        fs::create_dir_all(&root).unwrap();let _cleanup=super::super::Cleanup(root.clone());
        assert!(Command::new("git").current_dir(&root).args(["init","--quiet"]).status().unwrap().success());
        let name="local-signing-key.pem";
        fs::write(root.join(name),marker("RSA PRIVATE KEY")).unwrap();
        assert!(check(&root).unwrap().violations.is_empty());
        assert!(Command::new("git").current_dir(&root).args(["add","-f",name]).status().unwrap().success());
        let report=check(&root).unwrap();
        assert_eq!(report.violations,vec![PathBuf::from(name)]);
        assert!(!format!("{report:?}").contains("BEGIN"));
        assert_eq!(run(&root),1);
        fs::write(root.join(name),b"not a key").unwrap();
        assert_eq!(run(&root),0);
    }
    #[test]fn actual_checkout_is_clean(){
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert_eq!(run(&root),0);
    }
}
