//! Allocation-free conversation-window policy for the browser extension.
//! No DOM handles, strings, conversation contents, allocator, or external crates.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

const MIN_RECENT: u32 = 8;
const DEFAULT_WINDOW: u32 = 50;
const DEFAULT_BATCH: u32 = 25;

#[no_mangle]
pub extern "C" fn cpo_abi_version() -> u32 { 4 }

/// Retain the configured window and any explicitly expanded history.
/// Preserve the preexisting optimizer's behavior while moving policy to Rust.
#[no_mangle]
pub extern "C" fn cpo_visible_count(total: u32, configured: u32, expanded: u32) -> u32 {
    let configured = if configured == 0 { DEFAULT_WINDOW } else { configured };
    total.min(configured.max(expanded).max(MIN_RECENT))
}

#[no_mangle]
pub extern "C" fn cpo_expand_count(total: u32, visible: u32, batch: u32) -> u32 {
    let batch = if batch == 0 { DEFAULT_BATCH } else { batch };
    visible.saturating_add(batch).min(total)
}

/// First visible turn and last offscreen-rendering candidate are calculated
/// without allocating arrays or crossing the JS/WASM boundary for each node.
#[no_mangle]
pub extern "C" fn cpo_hidden_count(total: u32, visible: u32) -> u32 {
    total.saturating_sub(visible)
}

#[no_mangle]
pub extern "C" fn cpo_offscreen_end(total: u32) -> u32 {
    total.saturating_sub(MIN_RECENT)
}

/// A load-more banner never advertises more history than actually exists.
#[no_mangle]
pub extern "C" fn cpo_batch_count(hidden: u32, batch: u32) -> u32 {
    hidden.min(if batch == 0 { DEFAULT_BATCH } else { batch })
}

/// Relative resource units, not measured memory bytes. Media gets a larger
/// weight because decoded resources and rendering surfaces can be expensive.
#[no_mangle]
pub extern "C" fn cpo_resource_units(nodes: u32, text_chars: u32, images: u32,
    media: u32, surfaces: u32, truncated: u32) -> u32 {
    nodes.saturating_add(text_chars.div_ceil(128))
        .saturating_add(images.saturating_mul(32))
        .saturating_add(media.saturating_mul(128))
        .saturating_add(surfaces.saturating_mul(128))
        .saturating_add(truncated.saturating_mul(512))
}

/// Estimate the recent-window limit from the sampled average cost. A manual
/// history expansion is handled separately by the browser bridge.
#[no_mangle]
pub extern "C" fn cpo_adaptive_window(total: u32, configured: u32, sampled: u32,
    units: u32, budget: u32) -> u32 {
    let cap = cpo_visible_count(total, configured, 0);
    if sampled == 0 || units == 0 || budget == 0 { return cap; }
    let allowed = (u64::from(budget) * u64::from(sampled) / u64::from(units))
        .min(u64::from(u32::MAX)) as u32;
    cap.min(allowed.max(MIN_RECENT))
}

/// Approximate one uncompressed RGBA image surface. This is an estimate of
/// potential decoded storage, never a claim about resident or reclaimed RAM.
#[no_mangle]
pub extern "C" fn cpo_image_surface_bytes(width: u32, height: u32) -> u32 {
    width.saturating_mul(height).saturating_mul(4)
}

/// Reject active, seeked, or application-owned playback. The DOM bridge
/// supplies flags only after inspecting the real browser media element.
#[no_mangle]
pub extern "C" fn cpo_can_evict_playback(paused: u32, at_start: u32,
    has_stream: u32, has_protected_source: u32) -> u32 {
    (paused == 1 && at_start == 1 && has_stream == 0 && has_protected_source == 0) as u32
}

/// Bound the read-only history viewer's rendered window and disk reads.
#[no_mangle]
pub extern "C" fn cpo_history_page_count(total: u32, offset: u32, requested: u32) -> u32 {
    total.saturating_sub(offset).min(requested.clamp(1, 32))
}

/// Limit local snapshot payloads to 8 MiB of UTF-8 text and row overhead.
#[no_mangle]
pub extern "C" fn cpo_history_accept_bytes(used: u32, next: u32) -> u32 {
    (used <= 8_388_608 && next <= 8_388_608 - used) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visible_window_preserves_existing_behavior() {
        assert_eq!(cpo_visible_count(500, 50, 0), 50);
        assert_eq!(cpo_visible_count(500, 50, 75), 75);
        assert_eq!(cpo_visible_count(4, 50, 75), 4);
        assert_eq!(cpo_visible_count(100, 2, 0), 8);
        assert_eq!(cpo_visible_count(100, 0, 0), 50);
        assert_eq!(cpo_visible_count(0, 50, 0), 0);
    }
    #[test]
    fn adaptive_resource_budget() {
        assert_eq!(cpo_resource_units(100, 129, 2, 1, 1, 0), 422);
        assert_eq!(cpo_resource_units(u32::MAX, 0, 1, 0, 0, 1), u32::MAX);
        assert_eq!(cpo_adaptive_window(500, 50, 20, 4000, 4000), 20);
        assert_eq!(cpo_adaptive_window(500, 50, 20, 4000, 1), 8);
        assert_eq!(cpo_adaptive_window(4, 50, 4, 4000, 1), 4);
        assert_eq!(cpo_adaptive_window(500, 50, 0, 0, 4000), 50);
        assert_eq!(cpo_adaptive_window(500, 50, 20, 4000, 100000), 50);
        assert_eq!(cpo_adaptive_window(u32::MAX, u32::MAX, u32::MAX, 1, u32::MAX), u32::MAX);
    }
    #[test]
    fn bounded_history_paging() {
        assert_eq!(cpo_history_page_count(100, 0, 100), 32);
        assert_eq!(cpo_history_page_count(100, 95, 16), 5);
        assert_eq!(cpo_history_page_count(100, 101, 16), 0);
        assert_eq!(cpo_history_accept_bytes(8_388_600, 8), 1);
        assert_eq!(cpo_history_accept_bytes(8_388_600, 9), 0);
        assert_eq!(cpo_history_accept_bytes(u32::MAX, 1), 0);
    }
    #[test]
    fn media_eviction_policy() {
        assert_eq!(cpo_image_surface_bytes(1920, 1080), 8_294_400);
        assert_eq!(cpo_image_surface_bytes(u32::MAX, 4), u32::MAX);
        assert_eq!(cpo_can_evict_playback(1, 1, 0, 0), 1);
        assert_eq!(cpo_can_evict_playback(0, 1, 0, 0), 0);
        assert_eq!(cpo_can_evict_playback(1, 0, 0, 0), 0);
        assert_eq!(cpo_can_evict_playback(1, 1, 1, 0), 0);
        assert_eq!(cpo_can_evict_playback(1, 1, 0, 1), 0);
    }
    #[test]
    fn bounds_and_saturation() {
        assert_eq!(cpo_expand_count(500, 50, 25), 75);
        assert_eq!(cpo_expand_count(60, 50, 25), 60);
        assert_eq!(cpo_expand_count(u32::MAX, u32::MAX - 1, 25), u32::MAX);
        assert_eq!(cpo_hidden_count(500, 50), 450);
        assert_eq!(cpo_hidden_count(5, 50), 0);
        assert_eq!(cpo_offscreen_end(7), 0);
        assert_eq!(cpo_offscreen_end(100), 92);
        assert_eq!(cpo_batch_count(5, 25), 5);
    }
}
