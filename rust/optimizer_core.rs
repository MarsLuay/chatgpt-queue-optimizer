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
pub extern "C" fn cpo_abi_version() -> u32 { 1 }

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
