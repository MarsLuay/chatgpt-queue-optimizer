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
pub extern "C" fn cpo_browser_abi() -> u32 { 1 }

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
            if protected || (playback && h(37, 0, 0, 0) == 0) { continue; }
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
                    if playback && h(37, 0, 0, 0) != 0 { h(39, 0, 0, 0); }
                    changed_groups = changed_groups.saturating_add(1);
                }
            }
            if !playback { h(41, 0, 0, 0); } // legacy attribute recovery
        }
    }
    changed_groups
}

#[cfg(test)]
mod tests {
    use super::*;
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
