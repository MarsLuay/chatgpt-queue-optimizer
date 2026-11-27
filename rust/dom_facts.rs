//! Native vocabulary shared by queue catalogs and browser observations.
pub const ERROR_ATTRIBUTES:&[&str]=&["data-message-status","data-message-state","data-stop-reason","data-finish-reason","data-status","data-state","data-error"];
pub const ERROR_VALUES:&[&str]=&["error","failed","failure","assistant-error","assistant_error","error-stop","error_stop"];
pub const TOOL_SELECTORS:&[&str]=&["[data-tool-call]","[data-tool-result]","[data-tool-state]","[data-tool-status]","[data-testid*=\"tool-call\"]","[data-testid*=\"tool-result\"]"];
pub const TOOL_ATTRIBUTES:&[&str]=&["data-tool-call","data-tool-result","data-tool-state","data-tool-status","data-testid","data-testid"];
pub const TOOL_STATES:&[&str]=&["active","incomplete","pending","running","waiting"];
