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
pub extern "C" fn cpo_browser_abi() -> u32 { 2 }

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
        if fallback && (raw_flags & (THREAD_BOTTOM | HAS_INPUT_OR_FORM) != 0 || h(14, raw, 15, 0) < 15) {
            continue;
        }
        let node = normalized(raw, selectors);
        let flags = h(13, node, 0, 0);
        let threshold = if fallback { 15 } else if flags & HAS_FORM != 0 { 80 } else { 1 };
        let text = h(14, node, threshold, 0);
        if if fallback { fallback_valid(flags, text) } else { primary_valid(flags, text) } {
            h(15, node, raw, 0);
        }
    }
    let count = h(16, 0, 0, 0);
    for i in 0..count {
        let node = h(17, i, 0, 0);
        let canonical = h(19, node, 0, 0) != 0;
        let mut parent = h(18, node, 0, 0);
        while parent != 0 {
            if canonical && h(19, parent, 0, 0) == 0 {
                h(20, parent, 0, 0);
            } else {
                h(20, node, 0, 0);
            }
            parent = h(18, parent, 0, 0);
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
                // Set hidden only after media operations succeed; an interrupted
                // native pass can safely be retried by the compatibility path.
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

#[cfg(test)]
mod tests {
    use super::*;
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
