//! Browser effect sequencing and queue outcome dispatch.
pub(super) fn recovery_step(stage:u32,active:bool,success:bool,decision:u32)->u32{
    if !active{return 0;}
    let settle=|d|match d{4=>11,5=>8,6=>12,7=>13,_=>14};
    match stage{
        0=>match decision{1=>1,2=>4,_=>14},
        1=>if success{2}else{4},
        2=>if success{10}else{4},
        4=>if success{5}else{14},
        5=>if success{6}else{14},
        6=>if decision==3{7}else{settle(decision)},
        7=>if success{10}else{settle(decision)},
        8=>if success{9}else{settle(decision)},
        9=>if success{10}else{settle(decision)},
        _=>0
    }
}
#[no_mangle]
pub extern "C" fn cpo_worker_outcome(flags:u32)->u32{
    if flags&1==0{0}else if flags&2!=0{1}else if flags&4!=0{2}
    else if flags&24==24{3}else{4}
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn transitions(){
        assert_eq!(recovery_step(0,true,false,1),1);
        assert_eq!(recovery_step(1,true,true,0),2);
        assert_eq!(recovery_step(2,true,false,0),4);
        assert_eq!(recovery_step(4,true,true,0),5);
        assert_eq!(recovery_step(5,true,true,0),6);
        assert_eq!(recovery_step(6,true,false,3),7);
        assert_eq!(recovery_step(7,true,false,5),8);
        assert_eq!(recovery_step(8,true,true,0),9);
        assert_eq!(recovery_step(9,true,false,6),12);
        assert_eq!(recovery_step(9,true,true,6),10);
        assert_eq!(recovery_step(4,false,true,0),0);
        assert_eq!(cpo_worker_outcome(31),1);
        assert_eq!(cpo_worker_outcome(29),2);
        assert_eq!(cpo_worker_outcome(25),3);
    }
}
