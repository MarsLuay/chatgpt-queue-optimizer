//! Generate classic-script browser bindings from the actual compiled WASM
//! type/import/function/export sections. No wasm-bindgen, npm or network
//! dependency is needed; the DOM implementation remains in the host bridge.
use super::{err,Result};
use std::{collections::BTreeMap,fs,path::Path};
mod browser_abi{include!(concat!(env!("CARGO_MANIFEST_DIR"),"/../../rust/browser_abi.rs"));}
pub const OUTPUT:&str="rust-browser-bindings.js";
#[derive(Clone,Debug,PartialEq,Eq)]
struct Signature{params:Vec<u8>,results:Vec<u8>}
struct Reader<'a>{bytes:&'a [u8],pos:usize}
impl<'a> Reader<'a>{
    fn new(bytes:&'a [u8])->Self{Self{bytes,pos:0}}
    fn byte(&mut self)->Result<u8>{let v=*self.bytes.get(self.pos).ok_or_else(||err("Truncated WASM"))?;self.pos+=1;Ok(v)}
    fn leb(&mut self)->Result<u32>{
        let mut value=0u32;
        for shift in (0..35).step_by(7){
            let b=self.byte()?;
            if shift==28&&b&0xf0!=0{return Err(err("WASM u32 overflow"));}
            value|=((b&127) as u32)<<shift;
            if b&128==0{return Ok(value);}
        }
        Err(err("Invalid WASM LEB128"))
    }
    fn take(&mut self,n:usize)->Result<&'a [u8]>{
        let end=self.pos.checked_add(n).ok_or_else(||err("WASM section overflow"))?;
        let value=self.bytes.get(self.pos..end).ok_or_else(||err("Truncated WASM section"))?;
        self.pos=end;Ok(value)
    }
    fn name(&mut self)->Result<&'a str>{let n=self.leb()? as usize;Ok(std::str::from_utf8(self.take(n)?)?)}
    fn valtypes(&mut self)->Result<Vec<u8>>{let n=self.leb()? as usize;Ok(self.take(n)?.to_vec())}
    fn end(&self)->bool{self.pos==self.bytes.len()}
}
fn inspect(bytes:&[u8])->Result<BTreeMap<String,Signature>>{
    if !bytes.starts_with(b"\0asm\x01\0\0\0"){return Err(err("Invalid browser WASM header"));}
    let mut file=Reader::new(&bytes[8..]);
    let mut types=Vec::new();let mut function_types=Vec::new();
    let mut raw_exports=Vec::new();let mut host=false;let mut memory=false;
    while !file.end(){
        let section=file.byte()?;let length=file.leb()? as usize;
        let mut s=Reader::new(file.take(length)?);
        match section{
            1=>{
                for _ in 0..s.leb()?{
                    if s.byte()?!=0x60{return Err(err("Unsupported WASM function type"));}
                    types.push(Signature{params:s.valtypes()?,results:s.valtypes()?});
                }
            }
            2=>{
                for _ in 0..s.leb()?{
                    let module=s.name()?;let name=s.name()?;let kind=s.byte()?;
                    if module!="cpo"||name!="host"||kind!=0||host{return Err(err("Unexpected browser WASM import"));}
                    let index=s.leb()? as usize;
                    let signature=types.get(index).ok_or_else(||err("Invalid WASM import type"))?;
                    if signature.params!=[0x7f;4]||signature.results!=[0x7f]{return Err(err("Invalid cpo.host signature"));}
                    function_types.push(index);host=true;
                }
            }
            3=>{for _ in 0..s.leb()?{function_types.push(s.leb()? as usize);}}
            7=>{
                for _ in 0..s.leb()?{
                    let name=s.name()?.to_owned();let kind=s.byte()?;let index=s.leb()? as usize;
                    if name=="memory"&&kind==2{memory=true;}
                    if name.starts_with("cpo_"){
                        if kind!=0{return Err(err("Native browser export is not a function"));}
                        raw_exports.push((name,index));
                    }
                }
            }
            _=>continue
        }
        if !s.end(){return Err(err("Invalid browser WASM section framing"));}
    }
    if !host||!memory{return Err(err("Browser WASM must export memory and import cpo.host"));}
    let mut exports=BTreeMap::new();
    for (name,index) in raw_exports{
        let ty=*function_types.get(index).ok_or_else(||err("Invalid WASM function export index"))?;
        let signature=types.get(ty).ok_or_else(||err("Invalid WASM function type index"))?.clone();
        if signature.params.iter().any(|&v|v!=0x7f)||signature.results!=[0x7f]{return Err(err(format!("Unexpected browser ABI signature: {name}")));}
        if exports.insert(name,signature).is_some(){return Err(err("Duplicate WASM export"));}
    }
    if exports.get("cpo_browser_abi").map(|s|s.params.len())!=Some(0){return Err(err("Missing browser ABI version function"));}
    Ok(exports)
}
pub(super) fn queue_exports(bytes:&[u8])->Result<Vec<String>>{
    if !bytes.starts_with(b"\0asm\x01\0\0\0"){return Err(err("Invalid queue WASM header"));}
    let mut file=Reader::new(&bytes[8..]);let mut names=std::collections::BTreeSet::new();let mut memory=false;
    while !file.end(){
        let section=file.byte()?;let length=file.leb()? as usize;let mut s=Reader::new(file.take(length)?);
        if section!=7{continue;}
        for _ in 0..s.leb()?{
            let name=s.name()?;let kind=s.byte()?;let _index=s.leb()?;
            if name=="memory"&&kind==2{memory=true;}
            if name.starts_with("cpo_")&&(kind!=0||!names.insert(name.to_owned())){return Err(err("Invalid queue WASM export"));}
        }
        if !s.end(){return Err(err("Invalid queue export framing"));}
    }
    if !memory||!names.contains("cpo_queue_abi"){return Err(err("Missing queue WASM ABI or memory"));}
    Ok(names.into_iter().collect())
}
fn verify_bridge(source:&str,exports:&BTreeMap<String,Signature>)->Result<()>{
    // Catch a missing export before packaging. Only browser-core receivers
    // are inspected, excluding unrelated queue-engine string dispatch.
    for prefix in ["core.cpo_","this.exports.cpo_","this.exports?.cpo_"]{
        for (offset,_) in source.match_indices(prefix){
            let start=offset+prefix.len()-4;
            let name:String=source[start..].chars().take_while(|c|c.is_ascii_alphanumeric()||*c=='_').collect();
            if !exports.contains_key(&name){return Err(err(format!("Browser bridge references absent native export: {name}")));}
        }
    }
    Ok(())
}
// Mechanical DOM and handle operations are typed Rust descriptors.
#[derive(Clone,Copy)]
enum Primitive{WriteIndex,Length,IndexOrZero,SetAdd,Swap,AppendChild,ReplaceChildren,CharCode,PushPair,IndexLength,PushValue}
const HOST_PRIMITIVES:&[(u32,Primitive,&str)]=&[
    (5,Primitive::WriteIndex,"output"),
    (16,Primitive::Length,"accepted"),
    (17,Primitive::IndexOrZero,"accepted"),
    (20,Primitive::SetAdd,"redundant"),
    (23,Primitive::Swap,"accepted"),
    (115,Primitive::AppendChild,"uiNodes"),
    (122,Primitive::ReplaceChildren,"root"),
    (124,Primitive::CharCode,"value"),
    (125,Primitive::PushPair,"spans"),
    (130,Primitive::CharCode,"value"),
    (140,Primitive::IndexLength,"values"),
    (146,Primitive::Length,"result.messages"),
    (149,Primitive::PushValue,"parts"),
    (180,Primitive::IndexOrZero,"accepted"),
];
fn render_primitives()->String{
    use Primitive::*;
    let mut out=String::from("    function dispatchHostPrimitive(op,a,b,c,ctx){switch(op){\n");
    for &(op,kind,field) in HOST_PRIMITIVES{
        let body=match kind{
            WriteIndex=>format!("ctx.{field}[a]=b;return 1;"),
            Length=>format!("return ctx.{field}.length;"),
            IndexOrZero=>format!("return ctx.{field}[a]||0;"),
            SetAdd=>format!("ctx.{field}.add(a);return 1;"),
            Swap=>format!("[ctx.{field}[a],ctx.{field}[b]]=[ctx.{field}[b],ctx.{field}[a]];return 1;"),
            AppendChild=>format!("ctx.{field}[a].appendChild(ctx.{field}[b]);return 1;"),
            ReplaceChildren=>format!("ctx.{field}.replaceChildren(ctx.uiNodes[0]);return 1;"),
            CharCode=>format!("return ctx.{field}.charCodeAt(a)||0;"),
            PushPair=>format!("ctx.{field}.push([a,b]);return 1;"),
            IndexLength=>format!("return ctx.{field}[a].length;"),
            PushValue=>format!("ctx.{field}.push(ctx.replacement);return 1;"),
        };
        out.push_str(&format!("        case {op}:{body}\n"));
    }
    out.push_str("        default:throw new Error('Unknown Rust browser host operation: '+op);\n    }}\n");out
}

fn render(exports:&BTreeMap<String,Signature>)->Result<String>{
    let signatures=exports.iter().map(|(name,s)|(name.as_str(),s.params.len())).collect::<Vec<_>>();
    let signatures=serde_json::to_string(&signatures)?;
    let mut js=format!("// @generated by the Rust release utility from optimizer_browser.wasm. DO NOT EDIT.\n(() => {{\n    'use strict';\n    const ABI = {};\n    const signatures = Object.freeze({signatures}.map(row => Object.freeze(row)));\n",browser_abi::VERSION);
    js.push_str(&render_primitives());
    js.push_str(r#"    function instantiateModule(module, host) {
        if (!(module instanceof WebAssembly.Module) || typeof host !== 'function') throw new Error('Invalid browser WASM binding arguments');
        const imports = WebAssembly.Module.imports(module);
        if (imports.length !== 1 || imports[0].module !== 'cpo' || imports[0].name !== 'host' || imports[0].kind !== 'function') throw new Error('Browser WASM import mismatch');
        const descriptors = WebAssembly.Module.exports(module);
        const names = descriptors.filter(item => item.name.startsWith('cpo_'));
        if (names.length !== signatures.length || names.some(item => item.kind !== 'function')) throw new Error('Browser WASM export mismatch');
        const instance = new WebAssembly.Instance(module, {cpo:{host:(op,a,b,c)=>host(op>>>0,a>>>0,b>>>0,c>>>0)>>>0}});
        const core = instance.exports;
        if (!(core.memory instanceof WebAssembly.Memory) || !signatures.every(([name,arity])=>typeof core[name]==='function' && core[name].length===arity) || core.cpo_browser_abi()!==ABI) throw new Error('Browser WASM ABI mismatch');
        return core;
    }
    async function instantiate(bytes,host) {
        return instantiateModule(await WebAssembly.compile(bytes),host);
    }
    const api=Object.freeze({abi:ABI,signatures,instantiate,instantiateModule,dispatchHostPrimitive});
    globalThis.CpoBrowserWasmBindings=api;
    if(typeof module!=='undefined' && module.exports)module.exports=api;
})();
"#);
    Ok(js)
}
pub fn generate(_repo:&Path,stage:&Path)->Result<()>{
    let bytes=fs::read(stage.join("optimizer_browser.wasm"))?;
    let exports=inspect(&bytes)?;
    verify_bridge(&fs::read_to_string(stage.join(super::browser_bridge_bindings::OUTPUT))?,&exports)?;
    fs::write(stage.join(OUTPUT),render(&exports)?)?;
    println!("Generated {OUTPUT} ({} typed exports, ABI {})",exports.len(),browser_abi::VERSION);
    Ok(())
}
#[cfg(test)]
mod tests{
    use super::*;
    fn section(out:&mut Vec<u8>,id:u8,bytes:&[u8]){
        assert!(bytes.len()<128);out.extend([id,bytes.len() as u8]);out.extend(bytes);
    }
    fn fixture()->Vec<u8>{
        let mut out=b"\0asm\x01\0\0\0".to_vec();
        section(&mut out,1,&[2,0x60,4,0x7f,0x7f,0x7f,0x7f,1,0x7f,0x60,0,1,0x7f]);
        section(&mut out,2,&[1,3,b'c',b'p',b'o',4,b'h',b'o',b's',b't',0,0]);
        section(&mut out,3,&[1,1]);
        let mut exports=vec![2,6];exports.extend(b"memory");exports.extend([2,0,15]);exports.extend(b"cpo_browser_abi");exports.extend([0,1]);
        section(&mut out,7,&exports);out
    }
    #[test]fn deterministic_contract_and_missing_export(){
        let exports=inspect(&fixture()).unwrap();
        assert_eq!(exports.len(),1);
        assert!(verify_bridge("core.cpo_browser_abi()",&exports).is_ok());
        assert!(verify_bridge("this.exports.cpo_missing()",&exports).is_err());
        let source=render(&exports).unwrap();
        assert_eq!(source,render(&exports).unwrap());
        assert!(source.contains("[[\"cpo_browser_abi\",0]]"));
        assert!(!source.contains("eval("));
        assert!(source.contains("case 115:ctx.uiNodes[a].appendChild(ctx.uiNodes[b]);"));
        assert!(source.contains("case 180:return ctx.accepted[a]||0;"));
    }
    #[test]fn malformed_and_incompatible_imports_rejected(){
        let mut bytes=fixture();bytes.pop();assert!(inspect(&bytes).is_err());
        let mut bytes=fixture();let pos=bytes.windows(4).position(|v|v==b"host").unwrap();bytes[pos]=b'x';assert!(inspect(&bytes).is_err());
    }
}
