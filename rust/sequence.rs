//! Sequence import parser. Host handles carry JS strings and values only.
//! Rust owns grammar, shape validation, trimming, line import and substitution.
use super::h;
const BAD:u32=u32::MAX;
const MAX:u32=8*1024*1024;
const DEPTH:u32=48;
fn ch(i:u32)->u32{h(130,i,0,0)}
fn white(c:u32)->bool{matches!(c,9..=13|32|160|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)}
fn hex(c:u32)->Option<u32>{match c{48..=57=>Some(c-48),65..=70=>Some(c-55),97..=102=>Some(c-87),_=>None}}
fn trim(mut a:u32,mut b:u32)->(u32,u32){while a<b&&white(ch(a)){a+=1;}while b>a&&white(ch(b-1)){b-=1;}(a,b)}
fn starts(a:u32,b:u32,s:&[u8])->bool{b-a>=s.len() as u32&&s.iter().enumerate().all(|(i,&v)|{let c=ch(a+i as u32);c==v as u32||(c>=65&&c<=90&&c+32==v as u32)})}
struct Parser{p:u32,end:u32}
impl Parser{
    fn peek(&self)->u32{if self.p<self.end{ch(self.p)}else{BAD}}
    fn ws(&mut self){while matches!(self.peek(),9|10|13|32){self.p+=1;}}
    fn take(&mut self,c:u32)->bool{if self.peek()==c{self.p+=1;true}else{false}}
    fn string(&mut self)->Option<u32>{
        if !self.take(34){return None}
        let out=h(131,0,0,0);let mut start=self.p;
        loop{
            let c=self.peek();
            match c{
                34=>{h(132,out,start,self.p);self.p+=1;return Some(h(134,out,0,0));}
                92=>{
                    h(132,out,start,self.p);self.p+=1;
                    let escaped=match self.peek(){34=>34,92=>92,47=>47,98=>8,102=>12,110=>10,114=>13,116=>9,117=>{
                        self.p+=1;let mut v=0;for _ in 0..4{v=v*16+hex(self.peek())?;self.p+=1;}h(133,out,v,0);start=self.p;continue;
                    },_=>return None};
                    self.p+=1;h(133,out,escaped,0);start=self.p;
                }
                0..=31|BAD=>return None,
                _=>self.p+=1
            }
        }
    }
    fn word(&mut self,s:&[u8],kind:u32)->Option<u32>{
        for &c in s{if !self.take(c as u32){return None;}}
        Some(h(135,kind,0,0))
    }
    fn digits(&mut self)->bool{let start=self.p;while matches!(self.peek(),48..=57){self.p+=1;}self.p!=start}
    fn number(&mut self)->Option<u32>{
        let start=self.p;self.take(45);
        if !self.take(48)&&!self.digits(){return None;}
        if self.take(46)&&!self.digits(){return None;}
        if self.take(101)||self.take(69){if !self.take(43){self.take(45);}if !self.digits(){return None;}}
        Some(h(136,start,self.p,0))
    }
    fn value(&mut self,depth:u32)->Option<u32>{
        if depth>DEPTH{return None;}self.ws();
        match self.peek(){
            34=>self.string(),
            91|123=>{
                let obj=self.take(123);if !obj{self.p+=1;}
                let out=h(135,if obj{2}else{1},0,0);let close=if obj{125}else{93};
                self.ws();if self.take(close){return Some(out);}
                loop{
                    self.ws();
                    let key=if obj{let k=self.string()?;self.ws();if !self.take(58){return None;}k}else{0};
                    let value=self.value(depth+1)?;
                    if h(137,out,key,value)==0{return None;}
                    self.ws();if self.take(close){return Some(out);}
                    if !self.take(44){return None;}
                }
            }
            110=>self.word(b"null",3),116=>self.word(b"true",4),102=>self.word(b"false",5),
            45|48..=57=>self.number(),_=>None
        }
    }
}
// Host value kinds: missing/null=0, string=1, array=2, object=3, other=4.
fn kind(v:u32)->u32{h(138,v,0,0)}
fn field(v:u32,f:u32)->u32{h(139,v,f,0)}
fn array(v:u32)->u32{h(140,v,0,0)}
fn at(v:u32,i:u32)->u32{h(141,v,i,0)}
fn output(v:u32,mode:u32)->bool{h(142,v,mode,0)!=0}
fn shape(v:u32)->bool{
    let mut list=v;let mut name=0;let mut objects=false;
    if kind(v)==3{list=field(v,1);name=field(v,0);if kind(name)!=1||kind(list)!=2{return false;}}
    else if kind(v)!=2{return false;}
    let count=array(list);
    if count>100000{return false;}
    if count>0&&kind(at(list,0))==3&&kind(v)==2{objects=true;}
    for i in 0..count{if kind(at(list,i))!=(if objects{3}else{1}){return false;}}
    if name!=0{output(name,1);}
    for i in 0..count{
        let mut item=at(list,i);
        if objects{
            let obj=item;item=0;
            for f in 2..=4{let value=field(obj,f);if h(143,value,0,0)!=0{item=value;break;}}
        }
        output(item,0);
    }
    true
}
#[no_mangle]
pub extern "C" fn cpo_sequence_import(length:u32)->u32{
    if length==0||length>MAX{return 0;}
    let (mut a,mut b)=trim(0,length);
    if starts(a,b,b"\x60\x60\x60"){
        a+=3;
        for lang in [b"javascript".as_slice(),b"json",b"text",b"js"]{
            if starts(a,b,lang){a+=lang.len() as u32;break;}
        }
        (a,b)=trim(a,b);
    }
    if b-a>=3&&starts(b-3,b,b"\x60\x60\x60"){b-=3;(a,b)=trim(a,b);}
    if a==b{return 0;}
    let mut p=Parser{p:a,end:b};
    if let Some(v)=p.value(0){p.ws();if p.p==b&&shape(v){return 1;}}
    h(144,0,0,0);
    // Historical plain-text import strips list bullets, numbers and spacing.
    let mut start=a;
    while start<b{
        let mut end=start;while end<b&&ch(end)!=10{end+=1;}
        let (mut left,right)=trim(start,end);
        while left<right&&(white(ch(left))||matches!(ch(left),45|42|0x2022|48..=57|46|41)){left+=1;}
        let (left,right)=trim(left,right);
        if left<right{h(145,left,right,0);}
        start=end.saturating_add(1);
    }
    (h(146,0,0,0)>0) as u32
}
// The host's string search is a primitive (no replacement or policy).
// Rust selects ordered non-overlapping matches and emits untouched spans.
#[no_mangle]
pub extern "C" fn cpo_sequence_substitute(length:u32,needle:u32)->u32{
    if needle==0{return 0;}
    let mut cursor=0;
    while cursor<=length{
        let found=h(147,cursor,0,0);
        if found==BAD{h(148,cursor,length,0);return 1;}
        if found<cursor||found>length||needle>length-found{return 0;}
        h(148,cursor,found,0);h(149,0,0,0);cursor=found+needle;
    }
    0
}
