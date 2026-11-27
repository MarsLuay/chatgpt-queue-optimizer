//! Browser-facing execution engine. JavaScript imports expose DOM primitives;
//! all traversal, filtering, indexing and eviction orchestration is Rust-owned.
//! Host handles are ephemeral integers, never pointers or retained DOM objects.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "cpo")]
extern "C" { fn host(op: u32, a: u32, b: u32, c: u32) -> u32; }

#[cfg(target_arch = "wasm32")]
#[inline]
fn h(op: u32, a: u32, b: u32, c: u32) -> u32 {
    unsafe { host(op, a, b, c) }
}

#[no_mangle]
pub extern "C" fn cpo_browser_abi() -> u32 { browser_abi::VERSION }
#[path="browser_abi.rs"]
mod browser_abi;
#[path="dom_facts.rs"]
mod dom_facts;

#[cfg(target_arch = "wasm32")]
mod sequence;

// Message transport readiness: read=1, action=2, snapshot=3, safety=4.
// A browser effect is allowed only after both native engines are loaded.
#[no_mangle]
pub extern "C" fn cpo_event_ready(kind:u32,flags:u32)->u32 {
    (kind>=1 && kind<=4 && flags&3==3) as u32
}

const MAX_TURNS: u32 = 32;
const MAX_NODES: u32 = 512;
const IN_ROOT: u32 = 1;
const EXCLUDED: u32 = 2;
const FORBIDDEN_TAG: u32 = 4;
const HAS_MARKER: u32 = 8;
const HAS_FORM: u32 = 16;
const HAS_INPUT_OR_FORM: u32 = 32;
const THREAD_BOTTOM: u32 = 64;
const FALLBACK_CONTENT: u32 = 128;

fn playback_eligible(flags: u32) -> bool { flags & 3 == 3 && flags & 12 == 0 }
fn playback_reload_safe(flags: u32) -> bool { flags & 3 == 3 && flags & 4 == 0 }

fn primary_valid(flags: u32, text: u32) -> bool {
    flags & IN_ROOT != 0 && flags & (EXCLUDED | FORBIDDEN_TAG) == 0 &&
    flags & HAS_MARKER != 0 && text >= if flags & HAS_FORM != 0 { 80 } else { 1 }
}

fn fallback_valid(flags: u32, text: u32) -> bool {
    flags & IN_ROOT != 0 && flags & (EXCLUDED | HAS_INPUT_OR_FORM) == 0 &&
    flags & FALLBACK_CONTENT != 0 && text >= 15
}

#[derive(Default)]
struct Sample {
    turns: u32, nodes: u32, text: u32, images: u32, media: u32,
    surfaces: u32, truncated: u32,
}
impl Sample {
    fn node(&mut self, kind: u32, length: u32) {
        self.nodes = self.nodes.saturating_add(1);
        match kind {
            1 => self.text = self.text.saturating_add(length),
            2 => self.images += 1,
            3 => self.media += 1,
            4 => self.surfaces += 1,
            _ => {}
        }
    }
    fn values(&self) -> [u32; 8] {
        let units = self.nodes.saturating_add(self.text.div_ceil(128))
            .saturating_add(self.images.saturating_mul(32))
            .saturating_add(self.media.saturating_mul(128))
            .saturating_add(self.surfaces.saturating_mul(128))
            .saturating_add(self.truncated.saturating_mul(512));
        [self.turns, self.nodes, self.text, self.images, self.media,
            self.surfaces, self.truncated, units]
    }
}

// Profiling ops 1..5: begin turn, classify current node, text length,
// advance walker, write output. Rust owns all loop limits and aggregation.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_collect_resources(total: u32) -> u32 {
    let mut sample = Sample::default();
    for index in (total.saturating_sub(MAX_TURNS)..total).rev() {
        if h(1, index, 0, 0) == 0 { continue; }
        let mut visited = 0;
        while visited < MAX_NODES {
            let kind = resource_kind();
            let len = if kind == 1 { h(3, 0, 0, 0) } else { 0 };
            sample.node(kind, len);
            visited += 1;
            if h(4, 0, 0, 0) == 0 { break; }
            if visited == MAX_NODES { sample.truncated += 1; }
        }
        sample.turns += 1;
    }
    for (index, value) in sample.values().into_iter().enumerate() {
        h(5, index as u32, value, 0);
    }
    1
}

// Read text through a browser TreeWalker and short UTF-16 transfers. Rust
// owns trimming and early termination. No entire message string is copied.
fn dom_whitespace(c:u16)->bool {
    matches!(c,9..=13|32|160|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
#[derive(Default)]
struct TrimmedCount { count:u32, pending:u32 }
impl TrimmedCount {
    fn add(&mut self, text:&[u16], limit:u32) {
        for &ch in text {
            if dom_whitespace(ch) {
                if self.count!=0 {self.pending=self.pending.saturating_add(1).min(limit);}
            } else {
                self.count=self.count.saturating_add(self.pending).saturating_add(1).min(limit);
                self.pending=0;
                if self.count>=limit {break;}
            }
        }
    }
}
#[cfg(target_arch="wasm32")]
fn trimmed_dom_length(node:u32,limit:u32)->u32 {
    if limit==0 || h(152,node,0,0)==0{return 0;}
    let mut count=TrimmedCount::default();
    let mut scratch=[0u16;256];
    loop {
        let len=h(153,scratch.as_mut_ptr() as u32,scratch.len() as u32,0);
        if len==0{break;}
        if len>scratch.len() as u32{core::arch::wasm32::unreachable();}
        count.add(&scratch[..len as usize],limit);
        // Volatile clearing prevents sensitive text from lingering in memory.
        for ch in &mut scratch[..len as usize]{unsafe{core::ptr::write_volatile(ch,0);}}
        if count.count>=limit{break;}
    }
    h(154,0,0,0);
    count.count
}
// Parent traversal uses one property read per host operation. The host
// returns a previously indexed candidate or the unindexed-node sentinel.
#[cfg(target_arch="wasm32")]
fn accepted_parent(node:u32)->u32 {
    h(155,node,0,0);
    loop{
        let id=h(156,0,0,0);
        if id!=u32::MAX{return id;}
    }
}
// Intersection delivery: now=1, previous=2, armed=4, in-flight=8,
// hidden=16. Output armed=1, intersecting=2, request expansion=4.
#[no_mangle]
pub extern "C" fn cpo_intersection_transition(flags:u32)->u32 {
    let now=flags&1!=0;
    let previous=flags&2!=0;
    let mut armed=flags&4!=0;
    if !now&&previous {armed=true;}
    let expand=now&&!previous&&armed&&flags&8==0&&flags&16!=0;
    if expand {armed=false;}
    (armed as u32)|((now as u32)<<1)|((expand as u32)<<2)
}

// Discovery ops 10..24. Query lists, closest() and DOM ordering are browser
// primitives. Rust decides candidate normalization, validity, redundancy and
// the final order (heap sort; no allocation or quadratic insertion sort).
#[cfg(target_arch = "wasm32")]
fn normalized(node: u32, selectors: u32) -> u32 {
    for i in 0..selectors {
        let turn = h(12, node, i, 0);
        if turn != 0 { return turn; }
    }
    node
}

#[cfg(target_arch = "wasm32")]
fn discover_pass(fallback: bool, selectors: u32) -> u32 {
    let count = h(10, fallback as u32, 0, 0);
    for i in 0..count {
        let raw = h(11, i, 0, 0);
        if raw == 0 { continue; }
        let raw_flags = message_flags(raw);
        if raw_flags & IN_ROOT == 0 || raw_flags & EXCLUDED != 0 { continue; }
        if fallback && (raw_flags & (THREAD_BOTTOM | HAS_INPUT_OR_FORM) != 0 || trimmed_dom_length(raw,15) < 15) {
            continue;
        }
        let node = normalized(raw, selectors);
        let flags = message_flags(node);
        let threshold = if fallback { 15 } else if flags & HAS_FORM != 0 { 80 } else { 1 };
        if !(if fallback { fallback_valid(flags,threshold) } else { primary_valid(flags,threshold) }) { continue; }
        let text = trimmed_dom_length(node,threshold);
        if if fallback { fallback_valid(flags, text) } else { primary_valid(flags, text) } {
            h(15, node, raw, 0);
        }
    }
    let count = h(16, 0, 0, 0);
    for i in 0..count {
        let node = h(17, i, 0, 0);
        let canonical = canonical_turn(node);
        let mut parent = accepted_parent(node);
        while parent != 0 {
            if canonical && !canonical_turn(parent) {
                h(20, parent, 0, 0);
            } else {
                h(20, node, 0, 0);
            }
            parent = accepted_parent(parent);
        }
    }
    let kept = h(21, 0, 0, 0);
    // In-place heap sort via host slots. compare returns 1 for left > right.
    for start in (0..kept / 2).rev() { sift(start, kept); }
    for end in (1..kept).rev() {
        h(23, 0, end, 0);
        sift(0, end);
    }
    kept
}

#[cfg(target_arch = "wasm32")]
fn sift(mut root: u32, end: u32) {
    while root < end / 2 {
        let mut child = root * 2 + 1;
        if child + 1 < end && h(22, child + 1, child, 0) != 0 { child += 1; }
        if h(22, child, root, 0) == 0 { break; }
        h(23, root, child, 0);
        root = child;
    }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_discover_messages(selectors: u32, allow_fallback: u32) -> u32 {
    let count = discover_pass(false, selectors);
    if count > 0 || allow_fallback == 0 { return count; }
    discover_pass(true, selectors)
}

// Media ops 30..40. A group is one image/picture or one audio/video and its
// sources. Rust owns eligibility, group ordering, restoration, and counters.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_execute_media(mode: u32) -> u32 {
    // 0 image eviction, 1 image restore, 2 playback eviction, 3 playback restore
    if mode > 3 { return 0; }
    let count = h(30, mode, 0, 0);
    let mut changed_groups = 0u32;
    for index in 0..count {
        let count = h(31, index, mode, 0);
        if count == 0 { continue; }
        let restoring = mode & 1 != 0;
        let playback = mode >= 2;
        if !restoring {
            let mut protected = false;
            for member in 0..count {
                if media_member_protected(member,playback) { protected = true; break; }
            }
            if protected || (playback && !playback_eligible(h(37, 0, 0, 0))) { continue; }
            let width = if playback { 0 } else { h(38, 0, 0, 0) };
            let height = if playback { 0 } else { h(38, 1, 0, 0) };
            let mut changed = false;
            // Restore/remove child sources before the principal element.
            for member in 1..count { changed |= stash_media_member(member,playback); }
            changed |= stash_media_member(0,playback);
            if changed {
                if playback { h(39, 0, 0, 0); }
                h(40, mode, width.saturating_mul(height).saturating_mul(4), 0);
                changed_groups = changed_groups.saturating_add(1);
            }
        } else {
            let mut replaced = false;
            for member in 0..count {
                if media_member_conflict(member) { replaced = true; break; }
            }
            if replaced {
                for member in 0..count { h(36, member, 0, 0); }
            } else {
                let mut changed = false;
                for member in 1..count { changed |= restore_media_member(member); }
                changed |= restore_media_member(0);
                if changed {
                    if playback && playback_reload_safe(h(37, 0, 0, 0)) { h(39, 0, 0, 0); }
                    changed_groups = changed_groups.saturating_add(1);
                }
            }
            if !playback {
                let flags=h(41,0,0,0);
                if flags&1!=0{h(184, u32::from(flags&14==2),0,0);}
            } // legacy attribute recovery
        }
    }
    changed_groups
}

// Cache TTLs and validity are shared by the optimizer and provider adapter.
// Age is a clamped elapsed millisecond count; JS owns timers and DOM references.
#[no_mangle]
pub extern "C" fn cpo_cache_ttl(kind: u32) -> u32 {
    match kind { 0 => 800, 1 | 2 => 8000, _ => 0 }
}

#[no_mangle]
pub extern "C" fn cpo_cache_valid(kind: u32, age: u32, flags: u32) -> u32 {
    (flags & 3 == 3 && age < cpo_cache_ttl(kind)) as u32
}

// Check expiry before walking cached handles. A disconnected node invalidates
// the entire cache; the host never needs to allocate a second reference list.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_cache_nodes_valid(kind: u32, age: u32, count: u32) -> u32 {
    if age >= cpo_cache_ttl(kind) { return 0; }
    for index in 0..count {
        if h(74, index, 0, 0) == 0 { return 0; }
    }
    1
}

#[no_mangle]
pub extern "C" fn cpo_mutation_delay() -> u32 { 700 }

#[no_mangle]
pub extern "C" fn cpo_window_visible(total: u32, target: u32, manual: u32, previous: u32, allow_shrink: u32) -> u32 {
    let desired = total.min(target.max(manual));
    if desired < previous && allow_shrink == 0 { total.min(previous) } else { desired }
}

fn window_action(index: u32, total: u32, visible: u32, offscreen: bool) -> u32 {
    let start = total.saturating_sub(visible);
    if index < start { 1 }
    else if offscreen && index < total.saturating_sub(8) { 2 }
    else { 0 }
}

// Window execution. Set media context to the current turn and use the same
// native media execution routines, without recursive JS/WASM calls.
// 50 selects a turn and reads its hidden bit; 51 updates class flags;
// 52/53 are lazy-loading DOM primitives.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_apply_window(total: u32, visible: u32, flags: u32) -> u32 {
    for index in 0..total {
        let action = window_action(index, total, visible, flags & 1 != 0);
        let was_hidden = h(50, index, 0, 0) != 0;
        if action == 1 {
            if !was_hidden {
                // Journal the affected turn before any media mutation.
                // A trap after eviction must still leave a discoverable root.
                h(51,1,0,0);
                cpo_execute_media(0);
                if flags & 2 != 0 { cpo_execute_media(2); }
            }
        } else {
            if was_hidden {
                cpo_execute_media(1);
                cpo_execute_media(3);
            }
            let count = h(52, 0, 0, 0);
            for image in 0..count { h(53, image, 0, 0); }
        }
        h(51, action, 0, 0);
    }
    1
}

// Restoration is intentionally separate from normal window policy. Restore
// every supplied root, including a partially mutated turn, before clearing
// markers. Never hide, evict or add lazy-loading attributes in recovery.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_restore_window(total:u32)->u32{
    for index in 0..total{
        h(50,index,0,0);
        cpo_execute_media(1);
        cpo_execute_media(3);
        h(51,0,0,0);
    }
    1
}

// Media journal recovery: host yields only still-live weak references.
// 150 selects an entry and reports source conflict; 151 restores or abandons
// the entry. This also covers sources moved outside their original turn.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_restore_journal(count:u32)->u32{
    for index in 0..count{
        if h(150,index,0,0)!=0{
            if media_member_conflict(0){h(36,0,0,0);}
            else{restore_media_member(0);}
        }
        h(151,0,0,0);
    }
    1
}

// Snapshot capture is explicit and bounded. Host holds the text fragments only
// for the current call; Rust decides selection, traversal, role and truncation.
// Ops 60..65: begin turn, next text, exclusion, length, append, emit row.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_capture_history(total: u32, offset: u32) -> u32 {
    if offset > total { return 0; }
    let end = total.min(offset.saturating_add(16));
    for index in offset..end {
        let role = h(60, index, 0, 0);
        if role == 0 { return 0; }
        let mut visited = 0u32;
        let mut chars = 0u32;
        let mut truncated = false;
        while h(61, 0, 0, 0) != 0 {
            visited += 1;
            if visited > 4096 || chars >= 32768 { truncated = true; break; }
            if h(62, 0, 0, 0) != 0 { continue; }
            let length = h(63, 0, 0, 0);
            let take = length.min(32768 - chars);
            if take > 0 {
                h(64, take, 0, 0);
                chars += take;
            }
            if take < length { truncated = true; break; }
        }
        h(65, index, role, truncated as u32);
    }
    1
}

// Mutation flags: identity-attribute=1, target inside turn=2, child
// count present=4; child flags: extension banner=1, turn marker=2.
// Rust processes every provider mutation for weak-cache invalidation even
// after a structural change has been found.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_process_mutations(count: u32, mode: u32, empty: u32) -> u32 {
    let mut structural = false;
    for index in 0..count {
        let selector=if mode==1{"[data-testid*=\"conversation-turn\"], [data-message-author-role], [data-message-id], article"}else{"[data-testid^=\"conversation-turn\"], [data-message-author-role]"};
        let mut flags=h(70,index,selector.as_ptr() as u32,selector.len() as u32);
        let attribute=DomFact::read(186,0,0);
        if attribute.one_of(&["data-testid","data-message-author-role","data-message-id"]){flags|=1;}
        if mode == 1 {
            while h(73, 0, 0, 0) != 0 {}
        }
        if flags & 1 != 0 { structural = true; }
        if flags & 4 != 0 {
            let children = h(71, 0, 0, 0);
            let mut banner_only = true;
            let mut changed_turns = false;
            for child in 0..children {
                let kind = h(72, child, mode, 0);
                banner_only &= kind & 1 != 0;
                changed_turns |= kind & 2 != 0;
            }
            if (mode == 1 || !banner_only) &&
                (changed_turns || flags & 2 == 0 || (mode == 0 && empty != 0)) {
                structural = true;
            }
        }
        if mode == 0 && structural { break; }
    }
    structural as u32
}

// Provider selectors are compatibility data. Rust owns selector-priority
// traversal, duplicate elimination and early termination; the host exposes
// DOM queries and the provider-specific predicate as opaque primitives.
// Ops 80 query selector, 81 candidate status (seen/allowed),
// 82 accept node. A failed query is treated as empty, as before.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_selectors(count: u32, first_only: u32) -> u32 {
    let mut accepted = 0u32;
    for selector in 0..count {
        let candidates = h(80,selector,0,0);
        for candidate in 0..candidates {
            let flags = h(81,candidate,selector,0);
            if flags & 3 != 2 { continue; }
            h(82,candidate,selector,0);
            accepted = accepted.saturating_add(1);
            if first_only != 0 { return accepted; }
        }
    }
    accepted
}

// Provider DOM interaction: browser primitives are synchronous host imports.
// Rust controls the ordering, including input events after mutation.
// provider: 1 ChatGPT, 2 Gemini, 3 Claude. mode: 0 clear, 1 queued write.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_composer_write(provider: u32, mode: u32, flags: u32) -> u32 {
    if !(1..=3).contains(&provider) || mode > 1 || flags & 1 == 0 { return 0; }
    h(90,0,0,0); // focus if available
    if flags & 2 != 0 { h(91,0,0,0); } // textarea value
    else {
        if mode == 1 || provider == 1 { h(92,0,0,0); } // replace children
        h(93, (mode == 1 || provider == 1) as u32,0,0); // clear text
        if mode == 1 {
            h(94,0,0,0); // remove ql-blank
            if flags & 4 != 0 { h(95,0,0,0); } // insert paragraph
        } else if provider == 2 { h(94,1,0,0); } // Gemini empty editor
    }
    h(96,u32::from(flags&4!=0),0,0); // native chooses insertion/deletion event
    1
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_composer_read(provider: u32, flags: u32) -> u32 {
    if flags & 1 == 0 { return 0; }
    if flags & 2 != 0 { h(97,0,0,0); return 1; }
    if h(97,1,0,0) != 0 { return 1; }
    if provider == 1 {
        let count = h(98,0,0,0);
        for child in 0..count { h(97,2,child,0); }
    }
    1
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_click(flags: u32) -> u32 {
    if flags & 7 != 7 { return 0; } // exists, enabled, connected
    h(99,0,0,0)
}
// Submission stage: flags: composer=1, pending draft=2, unchanged text=4,
// button present=8, enabled=16, identity valid=32, connected=64.
// 0 missing composer, 1 preserve draft, 2 write, 3 changed draft,
// 4 missing button, 5 disabled button, 6 click, 7 invalid target,
// 8 restore only if text still belongs to this attempt.
#[no_mangle]
pub extern "C" fn cpo_dom_submit_stage(stage: u32, flags: u32) -> u32 {
    if stage == 2 { return if flags & (4|32|64) == (4|32|64) { 8 } else { 3 }; }
    if flags & 32 == 0 { return 7; }
    if flags & (1|64) != (1|64) { return 0; }
    if stage == 0 { return if flags & 2 != 0 { 1 } else { 2 }; }
    if flags & 4 == 0 { return 3; }
    if flags & 8 == 0 { return 4; }
    if flags & 16 == 0 { return 5; }
    6
}
// Walk a browser-owned event target's ancestor chain. Host operations
// expose only current-node facts and selector predicates, never policy.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_event_ancestor(count:u32)->u32{
    while h(161,0,0,0)!=0{
        if h(162,0,0,0)!=0{return 0;}
        for i in 0..count{
            if h(163,i,0,0)!=0{return i+1;}
        }
        h(164,0,0,0);
    }
    0
}
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_normalize_turn(count:u32)->u32{
    if h(165,0,0,0)==0{return 0;}
    for i in 0..count{
        if h(166,i,0,0)!=0{return i+2;}
    }
    1
}
#[no_mangle]
pub extern "C" fn cpo_dom_last_assistant(flags:u32)->u32{
    (flags&1!=0||(flags&2==0&&flags&(4|8)!=0)) as u32
}
// Observe DOM ancestry without retaining an additional traversal list.
// 100 reports current ancestor role: 0 outside, 1 latest, 2 historical,
// 3 unrelated ancestor; 101 advances.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_active_surface() -> u32 {
    loop {
        match h(100,0,0,0) {
            0|1 => return 1,
            2 => return 0,
            _ => { h(101,0,0,0); }
        }
    }
}
#[no_mangle]
pub extern "C" fn cpo_dom_role(flags: u32) -> u32 {
    if flags & 1 != 0 { 1 } else if flags & 2 != 0 { 2 }
    else if flags & 4 != 0 { 1 } else if flags & 8 != 0 { 2 } else { 0 }
}
// Composer/send candidate flags: editable/action=1, extension UI=2,
// message body=4, weak selector=8, canonical composer context=16.
#[no_mangle]
pub extern "C" fn cpo_dom_candidate(mode: u32, flags: u32) -> u32 {
    if flags & 1 == 0 { return 0; }
    if mode == 0 && flags & 6 != 0 { return 0; }
    (flags & 8 == 0 || flags & 16 != 0) as u32
}

// Assistant/tool observation. Rust walks candidate attributes, recognizes
// explicit errors/incomplete states and only requests text when needed.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_error_stop(count: u32, attrs: u32) -> u32 {
    if attrs!=dom_facts::ERROR_ATTRIBUTES.len() as u32{return 0;}
    for node in 0..count {
        for attr in 0..attrs {
            let value=DomFact::read(102,node,attr);
            if value.one_of(dom_facts::ERROR_VALUES)||
                (dom_facts::ERROR_ATTRIBUTES[attr as usize]=="data-error"&&value.one_of(&["true","1","yes"])){return 1;}
        }
    }
    0
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_incomplete_tool(count:u32,selectors:u32,attrs:u32)->u32{
    if selectors!=dom_facts::TOOL_SELECTORS.len() as u32||attrs!=dom_facts::TOOL_ATTRIBUTES.len() as u32{return 0;}
    let mut tool=u32::MAX;
    'find:for node in 0..count{
        for selector in 0..selectors{
            if h(103,node,selector,0)!=0{tool=node;break 'find;}
        }
    }
    if tool==u32::MAX{return 0;}
    for node in 0..count{
        for attr in 0..attrs{
            let state=DomFact::read(104,node,attr);
            if state.len!=0{
                if state.one_of(dom_facts::TOOL_STATES){return 1;}
                break;
            }
        }
    }
    if h(105,tool,0,0)==0{return 0;}
    provider_text::host_empty_or_equal() as u32
}

// UI rendering primitives. Rust defines the tree, classes, order, controls
// and render bounds; host supplies dynamic text and executes DOM operations.
// All UI nodes belong to a call-local detached fragment until publication.
#[cfg(target_arch = "wasm32")]
mod ui {
    use super::h;
    fn node(tag:u32)->u32 {h(110,tag,0,0)}
    fn literal(op:u32,n:u32,s:&str){h(op,n,s.as_ptr() as u32,s.len() as u32);}
    fn class(n:u32,s:&str){literal(111,n,s)}
    fn text(n:u32,s:&str){literal(112,n,s)}
    fn style(n:u32,s:&str){literal(113,n,s)}
    fn dynamic(n:u32,row:u32,field:u32){h(114,n,row,field);}
    fn dynamic_class(n:u32,row:u32,field:u32){
        let len=h(181,row,field,0);
        if len!=0&&(0..len).all(|i|super::class_token_char(h(182,i,0,0))){h(121,n,row,field);}
    }
    fn append(parent:u32,child:u32){h(115,parent,child,0);}
    fn flags(row:u32)->u32{h(116,row,0,0)}
    fn button(parent:u32,row:u32,action:u32,label:&str,css:&str,styles:&str){
        let n=node(4);class(n,css);text(n,label);style(n,styles);
        h(117,n,row,action);append(parent,n);
    }
    fn item(parent:u32,tag:u32,css:&str,value:&str)->u32{
        let n=node(tag);class(n,css);text(n,value);append(parent,n);n
    }
    fn dynamic_item(parent:u32,tag:u32,css:&str,row:u32,field:u32)->u32{
        let n=node(tag);class(n,css);dynamic(n,row,field);append(parent,n);n
    }
    // Kinds 0 messages, 1 sequences, 2 scheduled, 3 running jobs,
    // 4 logs, 5 optimizer statistics, 6 history rows, 7 popup status.
    #[no_mangle]
    pub extern "C" fn cpo_ui_render(kind:u32,count:u32,limit:u32)->u32 {
        match kind {
            0=>{
                let shown=count.min(limit);
                for i in 0..shown {
                    let row=node(0);class(row,"message-item");
                    style(row,"display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px");
                    let label=dynamic_item(row,1,"",i,0);
                    style(label,"flex:1;overflow-wrap:anywhere");
                    let controls=node(0);style(controls,"display:flex;gap:4px");append(row,controls);
                    button(controls,i,1,"Edit","","width:auto;padding:4px 6px;font-size:10px");
                    button(controls,i,2,"×","","width:auto;padding:4px 7px;font-size:12px;background:var(--danger);color:#fff");
                    append(0,row);
                }
                if shown<count{
                    let n=node(4);class(n,"message-list-load-more");dynamic(n,shown,1);
                    h(117,n,shown,3);append(0,n);
                }
            }
            1=>{
                if count==0{
                    let n=item(0,5,"","Save a sequence first");h(119,n,3,0);
                }else{
                    for i in 0..count{
                        let n=dynamic_item(0,5,"",i,0);h(118,n,i,0);
                    }
                    let sep=item(0,5,"","────────────");h(119,sep,1,0);
                    let edit=item(0,5,"","Edit selected sequence...");literal(120,edit,"__edit_selected_sequence__");
                }
            }
            2=>{
                if count==0{item(0,0,"instance-empty","No scheduled messages");}
                for i in 0..count{
                    let row=node(0);class(row,"scheduled-row");
                    let main=node(0);class(main,"scheduled-row-main");append(row,main);
                    let info=dynamic_item(main,0,"scheduled-info",i,0);
                    append(info,node(6));
                    let badge=dynamic_item(info,1,"scheduled-status-badge",i,1);
                    dynamic_class(badge,i,2);
                    let actions=node(0);class(actions,"scheduled-actions");append(main,actions);
                    let mask=flags(i);
                    if mask&1!=0{button(actions,i,4,"Cancel","","");}
                    if mask&2!=0{button(actions,i,5,"Retry","","");}
                    if mask&4!=0{button(actions,i,6,"Delete","scheduled-delete-btn","");}
                    append(0,row);
                }
            }
            3=>{
                if count==0{item(0,0,"instance-empty","No running instances");}
                for i in 0..count{
                    let row=node(0);class(row,"instance-row");
                    dynamic_item(row,0,"instance-info",i,0);
                    let controls=node(0);style(controls,"display:flex;gap:4px;align-items:center");append(row,controls);
                    if flags(i)&1!=0{button(controls,i,7,"Retry","instance-stop-btn","background:var(--accent-2);color:var(--accent-2-text)");}
                    button(controls,i,8,"Stop","instance-stop-btn","");
                    append(0,row);
                }
            }
            4=>{
                if count==0{item(0,0,"queue-log-empty","No automation logs yet");}
                for i in (count.saturating_sub(30)..count).rev(){
                    let entry=node(0);class(entry,"queue-log-entry");dynamic_class(entry,i,3);
                    dynamic_item(entry,0,"queue-log-meta",i,0);
                    dynamic_item(entry,0,"queue-log-message",i,1);
                    if flags(i)&1!=0{dynamic_item(entry,0,"queue-log-details",i,2);}
                    append(0,entry);
                }
            }
            5=>{
                item(0,7,"","Stats:");
                for i in 0..count{append(0,node(6));dynamic_item(0,1,"",i,0);}
            }
            6=>{
                if count>16{return 0;}
                for i in 0..count{
                    let row=node(2);class(row,"turn");
                    dynamic_item(row,3,"",i,0);
                    dynamic_item(row,8,"",i,1);
                    if flags(i)&1!=0{item(row,8,"notice","This turn was truncated by the snapshot limit.");}
                    append(0,row);
                }
            }
            7=>{
                if count!=1{return 0;}
                dynamic_item(0,1,"popup-status-message",0,0);
                if flags(0)&1!=0{button(0,0,9,"Dismiss","popup-status-dismiss","");}
            }
            _=>return 0,
        }
        h(122,0,0,0)
    }
    // Scan UTF-16 prompt placeholders without copying the entire text into
    // linear memory. Report ranges only; the host materializes matched names.
    #[no_mangle]
    pub extern "C" fn cpo_ui_variables(length:u32)->u32{
        let mut i=0;let mut opened=None;
        while i<length {
            let ch=h(124,i,0,0);
            let next=if i+1<length{h(124,i+1,0,0)}else{0};
            if matches!(ch,10|13|0x2028|0x2029){opened=None;i+=1;continue;}
            if let Some(start)=opened {
                if ch==125&&next==125{
                    h(125,start,i,0);opened=None;i+=2;continue;
                }
            }else if ch==123&&next==123{
                opened=Some(i+2);i+=2;continue;
            }
            i+=1;
        }
        1
    }
    // Saved sequence operations: save=0, load=1, delete=2.
    #[no_mangle]
    pub extern "C" fn cpo_ui_saved_sequence(action:u32,flags:u32)->u32{
        if flags&1==0{return 0;}
        if action>2 || (action!=0&&flags&2==0){return 0;}
        h(126,action,0,0)
    }
    // Sequence edit effects: add=0, replace=1, remove=2, clear=3.
    // A missing or empty input is rejected before any mutation.
    #[no_mangle]
    pub extern "C" fn cpo_ui_sequence_edit(action:u32,index:u32,len:u32,flags:u32)->u32{
        let valid=match action{0=>flags&1!=0,1=>index<len&&flags&1!=0,2=>index<len,3=>true,_=>false};
        if !valid{return 0;}
        h(123,action,index,0)
    }
}
#[no_mangle]
pub extern "C" fn cpo_ui_next_limit(total:u32,shown:u32)->u32 { total.min(shown.saturating_add(100)) }
// Save/load/delete selection: explicit valid name wins, then selected,
// then first available. 0 none, 1 explicit, 2 selected, 3 first.
#[no_mangle]
pub extern "C" fn cpo_ui_sequence_select(flags:u32,count:u32)->u32{
    if count==0{0}else if flags&1!=0{1}else if flags&2!=0{3}else if flags&4!=0{2}else{3}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dom_trim_and_intersection() {
        let mut count=TrimmedCount::default();
        count.add(&[32,0xfeff,97,32,32],80);
        assert_eq!(count.count,1);
        count.add(&[98,32],80);
        assert_eq!(count.count,4);
        count.add(&[99,100],6);
        assert_eq!(count.count,6);
        assert_eq!(cpo_intersection_transition(1|4|16),6);
        assert_eq!(cpo_intersection_transition(2),1);
        assert_eq!(cpo_intersection_transition(1|4|8|16),3);
        assert_eq!(cpo_intersection_transition(1|2|16),2);
    }
    #[test]
    fn provider_interaction_policy() {
        assert_eq!(cpo_dom_submit_stage(0,1|32|64),2);
        assert_eq!(cpo_dom_submit_stage(0,1|2|32|64),1);
        assert_eq!(cpo_dom_submit_stage(1,1|4|8|16|32|64),6);
        assert_eq!(cpo_dom_submit_stage(1,1|8|16|32|64),3);
        assert_eq!(cpo_dom_submit_stage(2,4|32|64),8);
        assert_eq!(cpo_dom_submit_stage(2,4|64),3);
        assert_eq!(cpo_dom_candidate(0,1|8),0);
        assert_eq!(cpo_dom_candidate(0,1|8|16),1);
        assert_eq!(cpo_dom_candidate(0,1|4|16),0);
    }
    #[test]
    fn window_and_cache_policy() {
        assert_eq!(cpo_window_visible(100, 8, 33, 50, 1), 33);
        assert_eq!(cpo_window_visible(100, 8, 0, 33, 0), 33);
        assert_eq!(cpo_window_visible(100, 8, 0, 33, 1), 8);
        assert_eq!(window_action(89, 100, 10, true), 1);
        assert_eq!(window_action(90, 100, 10, true), 2);
        assert_eq!(window_action(92, 100, 10, true), 0);
        assert_eq!(window_action(0, 4, 4, true), 0);
        assert_eq!(cpo_cache_valid(0, 799, 3), 1);
        assert_eq!(cpo_cache_valid(0, 800, 3), 0);
        assert_eq!(cpo_cache_valid(1, 7999, 1), 0);
        assert_eq!(cpo_cache_valid(2, 7999, 3), 1);
    }
    #[test]
    fn candidate_validation() {
        assert!(primary_valid(IN_ROOT | HAS_MARKER, 1));
        assert!(!primary_valid(IN_ROOT | HAS_MARKER | HAS_FORM, 79));
        assert!(primary_valid(IN_ROOT | HAS_MARKER | HAS_FORM, 80));
        assert!(!primary_valid(IN_ROOT | HAS_MARKER | FORBIDDEN_TAG, 100));
        assert!(!primary_valid(IN_ROOT | HAS_MARKER | EXCLUDED, 100));
        assert!(fallback_valid(IN_ROOT | FALLBACK_CONTENT, 15));
        assert!(!fallback_valid(IN_ROOT | FALLBACK_CONTENT | HAS_INPUT_OR_FORM, 15));
    }
    #[test]
    fn playback_safety_flags() {
        assert!(playback_eligible(3));
        assert!(!playback_eligible(1));
        assert!(!playback_eligible(7));
        assert!(!playback_eligible(11));
        assert!(playback_reload_safe(11));
        assert!(!playback_reload_safe(7));
    }
    #[test]
    fn resource_accumulation() {
        let mut sample = Sample::default();
        for kind in [0, 1, 2, 3, 4] { sample.node(kind, 129); }
        sample.turns = 1;
        assert_eq!(sample.values(), [1, 5, 129, 1, 1, 1, 0, 295]);
        sample.text = u32::MAX;
        sample.node(1, 1);
        assert_eq!(sample.text, u32::MAX);
        assert_eq!(MAX_TURNS * MAX_NODES, 16384);
    }
}

#[no_mangle]
pub extern "C" fn cpo_message_predicate(mode:u32,flags:u32,text:u32)->u32{
    match mode{0=>primary_valid(flags,text) as u32,1=>fallback_valid(flags,text) as u32,_=>0}
}
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_first_matching_selector(count:u32)->u32{
    for i in 0..count{if h(160,i,0,0)!=0{return i+1;}}
    0
}

 // Combined DOM-ordered turn discovery first, selector-priority fallback
 // only on query failure. Node identity is an opaque host primitive.
 #[cfg(target_arch="wasm32")]
 #[no_mangle]
 pub extern "C" fn cpo_provider_turns(selectors:u32)->u32{
    let combined=h(167,0,0,0);
    let mut accepted=0u32;
    if combined!=u32::MAX{
        for i in 0..combined{if h(169,i,0,0)==1{accepted=accepted.saturating_add(1);}}
    }else{
        for selector in 0..selectors{
            let count=h(168,selector,0,0);
            for i in 0..count{if h(169,i,0,0)==1{accepted=accepted.saturating_add(1);}}
        }
    }
    accepted
 }


// Incremental ECMAScript whitespace normalization over UTF-16 code units.
// No heap allocations or normalized copies; preserve unpaired surrogates.
#[cfg(any(test,target_arch="wasm32"))]
mod provider_text {
    pub const CHUNK:usize=1024;
    fn whitespace(c:u16)->bool{
        matches!(c,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
    }
    struct Normalized<I>{source:I,started:bool,pending:bool,held:Option<u16>}
    impl<I:Iterator<Item=u16>> Normalized<I>{
        fn new(source:I)->Self{Self{source,started:false,pending:false,held:None}}
    }
    impl<I:Iterator<Item=u16>> Iterator for Normalized<I>{
        type Item=u16;
        fn next(&mut self)->Option<u16>{
            if let Some(unit)=self.held.take(){return Some(unit);}
            for unit in self.source.by_ref(){
                if whitespace(unit){
                    if self.started{self.pending=true;}
                }else{
                    self.started=true;
                    if self.pending{
                        self.pending=false;self.held=Some(unit);return Some(32);
                    }
                    return Some(unit);
                }
            }
            None
        }
    }
    pub fn equal<A:Iterator<Item=u16>,B:Iterator<Item=u16>>(a:A,b:B)->bool{
        Normalized::new(a).eq(Normalized::new(b))
    }
    #[cfg(target_arch="wasm32")]
    struct Source{side:u32,offset:u32,buffer:[u16;CHUNK],pos:usize,len:usize,done:bool}
    #[cfg(target_arch="wasm32")]
    impl Source{
        fn new(side:u32)->Self{Self{side,offset:0,buffer:[0;CHUNK],pos:0,len:0,done:false}}
    }
    #[cfg(target_arch="wasm32")]
    impl Iterator for Source{
        type Item=u16;
        fn next(&mut self)->Option<u16>{
            if self.pos==self.len{
                if self.done{return None;}
                let count=super::h(173,self.side,self.offset,self.buffer.as_mut_ptr() as u32) as usize;
                if count>CHUNK{core::arch::wasm32::unreachable();}
                if count==0{self.done=true;return None;}
                self.offset=self.offset.checked_add(count as u32).unwrap_or_else(||core::arch::wasm32::unreachable());
                self.pos=0;self.len=count;self.done=count<CHUNK;
            }
            let unit=self.buffer[self.pos];self.pos+=1;Some(unit)
        }
    }
    #[cfg(target_arch="wasm32")]
    impl Drop for Source{
        fn drop(&mut self){for unit in &mut self.buffer{unsafe{core::ptr::write_volatile(unit,0);}}}
    }
    #[cfg(target_arch="wasm32")]
    pub fn host_equal()->bool{equal(Source::new(0),Source::new(1))}
    #[cfg(target_arch="wasm32")]
    pub fn host_empty_or_equal()->bool{
        let mut left=Normalized::new(Source::new(0)).peekable();
        left.peek().is_none()||left.eq(Normalized::new(Source::new(1)))
    }
    #[cfg(test)]
    mod tests{
        use super::*;
        fn compare(a:&str,b:&str)->bool{equal(a.encode_utf16(),b.encode_utf16())}
        #[test]fn whitespace_and_exact_boundaries(){
            assert!(compare("  a\n\t b \u{feff}","a b"));
            assert!(compare("   ","\n"));
            assert!(!compare("a b","ab"));
            assert!(!compare("a b","a B"));
            assert!(!compare("same prefix","same prefix extra"));
            assert!(compare(&format!("{}  \n  b","a".repeat(CHUNK-1)),&format!("{} b","a".repeat(CHUNK-1))));
            assert!(equal([0xd800,32,0xdc00].into_iter(),[0xd800,9,0xdc00].into_iter()));
            assert!(!equal([0xd800].into_iter(),[0xfffd].into_iter()));
        }
    }
}
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_exact_text()->u32{provider_text::host_equal() as u32}

// Native owns iteration, role selection, history-cache eligibility, exact
// candidate verification and assistant-only inspection. JS only reads DOM
// properties and transfers metadata to the separate native queue engine.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_scan_turns(count:u32,cache:u32,exact:u32)->u32{
    for index in 0..count{
        let role=cpo_dom_role(h(170,index,0,0));
        let cacheable=(cache!=0&&index<count.saturating_sub(2)) as u32;
        let facts=h(171,role,cacheable,0);
        let matched=exact!=0&&facts&2!=0&&role!=2&&provider_text::host_equal();
        let assistant=if role==2{h(174,0,0,0)&14}else{0};
        let flags=u32::from(matched)|assistant|((facts&1)<<4);
        if h(175,index,role,flags)!=1{return 0;}
    }
    1
}


// Provider observation order and signal selection. The host exposes
// selector queries, DOM properties and the queue engine's semantic matcher.
// Output uses the queue generation observation flags.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_observe_generation(provider:u32)->u32{
    if !(1..=3).contains(&provider){return u32::MAX;}
    let chat=provider==1;
    let mut flags=0u32;
    if chat&&h(176,0,0,0)!=0{flags|=8;}
    // A canonical stop selector wins. Avoid scanning every button for the
    // semantic fallback when the canonical control is present.
    if chat&&h(176,1,0,0)!=0{flags|=1;}
    else if h(176,2,provider,0)!=0{flags|=1;}
    if h(176,3,provider,0)!=0{flags|=2;}
    h(176,4,provider,0);
    if chat&&h(176,5,0,0)!=0{flags|=4;}
    h(176,6,provider,0);
    if h(176,7,provider,0)!=0{flags|=16;}
    flags
}


// Native retry precedence: newest matching button in the latest turn,
// then the first matching alert, then newest active-surface match.
// Host query batches return only semantically eligible button handles.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_retry()->u32{
    let latest=h(177,0,0,0);
    if latest>0{return h(178,latest-1,0,0);}
    let alerts=h(177,1,0,0);
    for alert in 0..alerts{
        let count=h(177,2,alert,0);
        if count>0{return h(178,count-1,0,0);}
    }
    let count=h(177,3,0,0);
    for index in (0..count).rev(){
        if h(178,index,1,0)==1{return 1;}
    }
    0
}

// The compatibility contract always observes root, composer and send
// action in that order. Message discovery and route classification are
// performed only for providers with conversation optimization support.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_diagnostics(optimizer:u32)->u32{
    let mut flags=0;
    for signal in 0..3{
        if h(179,signal,0,0)!=0{flags|=1<<signal;}
    }
    if optimizer!=0{
        h(179,3,0,0);
        if h(179,4,0,0)!=0{flags|=8;}
    }
    flags
}


// Deduplicate an existing DOM handle list without extracting message text.
// Keep canonical descendants over generic wrappers; otherwise keep ancestors.
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_provider_deduplicate(count:u32)->u32{
    for i in 0..count{
        let node=h(180,i,0,0);
        let canonical=canonical_turn(node);
        let mut parent=accepted_parent(node);
        while parent!=0{
            if canonical&&!canonical_turn(parent){h(20,parent,0,0);}
            else{h(20,node,0,0);}
            parent=accepted_parent(parent);
        }
    }
    h(21,0,0,0)
}


// Fixed-size host fact transport; long values cannot masquerade as short
// exact markers. Prefix checks still see their leading code units.
#[cfg(target_arch="wasm32")]
struct DomFact{units:[u16;128],len:u32}
#[cfg(target_arch="wasm32")]
impl DomFact{
    fn read(op:u32,a:u32,b:u32)->Self{
        let mut value=Self{units:[0;128],len:0};
        value.len=h(op,a,b,value.units.as_mut_ptr() as u32);value
    }
    fn one_of(&self,values:&[&str])->bool{
        self.len<=self.units.len() as u32&&values.iter().any(|v|fact_eq(&self.units[..self.len as usize],v))
    }
    fn starts(&self,prefix:&str)->bool{
        self.len>=prefix.len() as u32&&prefix.bytes().enumerate().all(|(i,b)|self.units.get(i)==Some(&(b as u16)))
    }
}
#[cfg(target_arch="wasm32")]
impl Drop for DomFact{fn drop(&mut self){for unit in &mut self.units{unsafe{core::ptr::write_volatile(unit,0);}}}}
fn fact_eq(units:&[u16],ascii:&str)->bool{
    units.len()==ascii.len()&&units.iter().zip(ascii.bytes()).all(|(&a,b)|{
        let lower=if (65..=90).contains(&a){a+32}else{a};lower==b as u16
    })
}
fn class_token_char(c:u32)->bool{matches!(c,45|48..=57|95|97..=122)}
#[cfg(target_arch="wasm32")]
fn resource_kind()->u32{
    match h(2,0,0,0){
        3=>1,
        1=>{
            let tag=DomFact::read(183,0,0);
            if tag.one_of(&["img"]){2}else if tag.one_of(&["video","audio"]){3}
            else if tag.one_of(&["canvas","iframe"]){4}else{0}
        }
        _=>0
    }
}
#[cfg(target_arch="wasm32")]
fn message_flags(node:u32)->u32{
    let mut flags=h(13,node,0,0);
    if DomFact::read(183,1,node).one_of(&["script","style","nav","aside","header","footer"]){flags|=FORBIDDEN_TAG;}
    if flags&HAS_MARKER!=0{flags|=FALLBACK_CONTENT;}
    flags
}
#[cfg(target_arch="wasm32")]
fn canonical_turn(node:u32)->bool{
    h(19,node,0,0)!=0||DomFact::read(183,1,node).one_of(&["article"])||
        DomFact::read(183,2,node).starts("conversation-turn")
}
#[cfg(target_arch="wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_message_flags(node:u32)->u32{message_flags(node)}
#[cfg(test)]
#[test]
fn raw_fact_matching_and_css_tokens(){
    assert!(fact_eq(&[69,82,82,79,82],"error"));
    assert!(!fact_eq(&[101,114,114,111,114,45],"error"));
    assert!(b"queue-active_12".iter().all(|&c|class_token_char(c as u32)));
    assert!(!b"bad class".iter().all(|&c|class_token_char(c as u32)));
}


// Source strings stay browser-owned. Inspect a bounded UTF-16 stream for
// application-owned URLs; oversize attributes are protected without copying.
const MEDIA_LIMIT:u32=8192;
const MEDIA_PREFIXES:[&[u8];3]=[b"blob:",b"data:",b"mediasource:"];
struct MediaScan{boundary:bool,mask:u8,position:usize}
impl MediaScan{
    fn new()->Self{Self{boundary:true,mask:0,position:0}}
    fn unit(&mut self,unit:u16)->bool{
        if dom_whitespace(unit)||unit==44{
            self.boundary=true;self.mask=0;self.position=0;return false;
        }
        if self.boundary{self.mask=7;self.position=0;self.boundary=false;}
        if self.mask==0{return false;}
        let lower=if (65..=90).contains(&unit){unit+32}else{unit};
        for (index,prefix) in MEDIA_PREFIXES.iter().enumerate(){
            let bit=1u8<<index;
            if self.mask&bit==0{continue;}
            if prefix.get(self.position).copied().map(u16::from)!=Some(lower){self.mask&=!bit;}
            else if self.position+1==prefix.len(){return true;}
        }
        self.position+=1;false
    }
}
#[cfg(target_arch="wasm32")]
fn media_source(member:u32,attribute:u32)->(bool,bool){
    let length=h(32,member,attribute,0);
    if length==0{return (false,false);}
    if length>MEDIA_LIMIT{return (true,true);}
    let mut scan=MediaScan::new();
    let mut scratch=[0u16;256];
    let mut offset=0;
    while offset<length{
        let take=(length-offset).min(scratch.len() as u32);
        let read=h(185,offset,scratch.as_mut_ptr() as u32,take);
        if read!=take{core::arch::wasm32::unreachable();}
        let protected=scratch[..read as usize].iter().any(|&unit|scan.unit(unit));
        for unit in &mut scratch[..read as usize]{unsafe{core::ptr::write_volatile(unit,0);}}
        if protected{return (true,true);}
        offset+=read;
    }
    (true,false)
}
#[cfg(target_arch="wasm32")]
fn media_member_protected(member:u32,playback:bool)->bool{
    media_source(member,0).1||media_source(member,1).1||
        (playback&&member==0&&media_source(member,2).1)
}
#[cfg(target_arch="wasm32")]
fn stash_media_member(member:u32,playback:bool)->bool{
    // Preserve the old source ordering: picture children lose srcset;
    // image roots lose srcset then src; playback loses src only.
    let candidates=if playback{1}else if member==0{3}else{2};
    let mut mask=0u32;
    for attribute in [1,0]{
        if candidates&(1<<attribute)==0{continue;}
        let (present,protected)=media_source(member,attribute);
        if protected{return false;}
        if present{mask|=1<<attribute;}
    }
    mask!=0&&h(33,member,mask,0)!=0
}
// Raw host flags: journal exists=1, original value exists=2, current
// attribute exists=4, current differs from original=8. Native code alone
// settles conflict, missing-attribute restoration and journal retirement.
#[cfg(target_arch="wasm32")]
fn media_member_conflict(member:u32)->bool{
    (0..2).any(|attribute|h(35,member,attribute,0)&13==13)
}
#[cfg(target_arch="wasm32")]
fn restore_media_member(member:u32)->bool{
    let src=h(35,member,0,0);let srcset=h(35,member,1,0);
    if src&1==0{return false;}
    if src&13==13||srcset&13==13{h(36,member,0,0);return false;}
    let mask=u32::from(src&6==2)|(u32::from(srcset&6==2)<<1);
    h(34,member,mask,0)!=0
}
#[cfg(test)]
#[test]
fn protected_media_prefixes_and_boundaries(){
    let protected=|s:&str|{let mut scanner=MediaScan::new();s.encode_utf16().any(|u|scanner.unit(u))};
    assert!(protected("blob:object"));
    assert!(protected("a.png 1x, DATA:image/png;base64,x"));
    assert!(protected("a.png\u{feff}MediaSource:x"));
    assert!(!protected("https://example.test/blob:x"));
    assert!(!protected("prefixdata:x"));
    assert!(!protected("data"));
    let mut scanner=MediaScan::new();
    assert!(!"a.png, med".encode_utf16().any(|u|scanner.unit(u)));
    assert!("iasource:foo".encode_utf16().any(|u|scanner.unit(u)));
}
