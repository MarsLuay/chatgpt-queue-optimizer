//! Scheduled request and settlement guards for the background worker.
#[no_mangle]
pub extern "C" fn cpo_background_schedule_guard(kind:u32,flags:u32)->u32{
    match kind{
        0=>if flags&1==0{1}else if flags&2==0{2}else if flags&4==0{3}else{0},
        1=>if flags&1==0{1}else if flags&2==0{2}else{0},
        2=>if flags&1==0||flags&6==6{0}else{1},
        _=>u32::MAX
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn guards(){
        assert_eq!(cpo_background_schedule_guard(0,0),1);
        assert_eq!(cpo_background_schedule_guard(0,1),2);
        assert_eq!(cpo_background_schedule_guard(0,3),3);
        assert_eq!(cpo_background_schedule_guard(0,7),0);
        assert_eq!(cpo_background_schedule_guard(1,1),2);
        assert_eq!(cpo_background_schedule_guard(2,3),1);
        assert_eq!(cpo_background_schedule_guard(2,7),0);
    }
}
