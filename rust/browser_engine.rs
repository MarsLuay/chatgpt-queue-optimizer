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
pub extern "C" fn cpo_browser_abi() -> u32 { 8 }

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
            let kind = h(2, 0, 0, 0);
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
        let raw_flags = h(13, raw, 0, 0);
        if raw_flags & IN_ROOT == 0 || raw_flags & EXCLUDED != 0 { continue; }
        if fallback && (raw_flags & (THREAD_BOTTOM | HAS_INPUT_OR_FORM) != 0 || trimmed_dom_length(raw,15) < 15) {
            continue;
        }
        let node = normalized(raw, selectors);
        let flags = h(13, node, 0, 0);
        let threshold = if fallback { 15 } else if flags & HAS_FORM != 0 { 80 } else { 1 };
        let text = trimmed_dom_length(node,threshold);
        if if fallback { fallback_valid(flags, text) } else { primary_valid(flags, text) } {
            h(15, node, raw, 0);
        }
    }
    let count = h(16, 0, 0, 0);
    for i in 0..count {
        let node = h(17, i, 0, 0);
        let canonical = h(19, node, 0, 0) != 0;
        let mut parent = accepted_parent(node);
        while parent != 0 {
            if canonical && h(19, parent, 0, 0) == 0 {
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
                if h(32, member, mode, 0) != 0 { protected = true; break; }
            }
            if protected || (playback && !playback_eligible(h(37, 0, 0, 0))) { continue; }
            let width = if playback { 0 } else { h(38, 0, 0, 0) };
            let height = if playback { 0 } else { h(38, 1, 0, 0) };
            let mut changed = false;
            // Restore/remove child sources before the principal element.
            for member in 1..count { changed |= h(33, member, mode, 0) != 0; }
            changed |= h(33, 0, mode, 0) != 0;
            if changed {
                if playback { h(39, 0, 0, 0); }
                h(40, mode, width.saturating_mul(height).saturating_mul(4), 0);
                changed_groups = changed_groups.saturating_add(1);
            }
        } else {
            let mut replaced = false;
            for member in 0..count {
                if h(35, member, 0, 0) != 0 { replaced = true; break; }
            }
            if replaced {
                for member in 0..count { h(36, member, 0, 0); }
            } else {
                let mut changed = false;
                for member in 1..count { changed |= h(34, member, 0, 0) != 0; }
                changed |= h(34, 0, 0, 0) != 0;
                if changed {
                    if playback && playback_reload_safe(h(37, 0, 0, 0)) { h(39, 0, 0, 0); }
                    changed_groups = changed_groups.saturating_add(1);
                }
            }
            if !playback { h(41, 0, 0, 0); } // legacy attribute recovery
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
        let flags=h(150,index,0,0);
        if flags&1!=0{h(151,0,((flags&2)==0) as u32,0);}
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
        let flags = h(70, index, mode, 0);
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
    h(96,0,0,0); // dispatch input
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
    for node in 0..count {
        for attr in 0..attrs {
            let value = h(102,node,attr,0);
            if value & 1 != 0 || value & 6 == 6 { return 1; }
        }
    }
    0
}
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn cpo_dom_incomplete_tool(count: u32) -> u32 {
    let mut tool = u32::MAX;
    for node in 0..count {
        if h(103,node,0,0) != 0 { tool = node; break; }
    }
    if tool == u32::MAX { return 0; }
    for node in 0..count {
        if h(104,node,0,0) != 0 { return 1; }
    }
    h(105,tool,0,0)
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
                    h(121,badge,i,2);
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
                    let entry=node(0);class(entry,"queue-log-entry");h(121,entry,i,3);
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
