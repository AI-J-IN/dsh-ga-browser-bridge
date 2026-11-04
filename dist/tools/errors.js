/**
 * Error helpers — match br_mcp.py's error-string conventions.
 *
 * br_mcp.py returns plain strings from tools. Action-level errors use the
 * "[error] " prefix (e.g. "[error] unknown action: X (...)"), and unexpected
 * exceptions are rendered as "[error] <TypeName>: <message>".
 */
/** The "[error] " prefix used for action-level tool errors. */
export const ERROR_PREFIX = "[error] ";
/** Prefix a message with the "[error] " marker used by br_mcp.py action errors. */
export function errPrefix(msg) {
    return ERROR_PREFIX + msg;
}
/**
 * No-browser error string. Updated from br_mcp.py's _need_browser() for the
 * direct-CDP world (no GA master, no tmwd_cdp_bridge extension).
 */
export function noBrowserError() {
    return ("No browser tabs available. Check: (1) Chrome/Edge is open; " +
        "(2) debug port 9222 is open (chrome.exe --remote-debugging-port=9222); " +
        "(3) dsh-ga-browser-bridge plugin is running.");
}
/**
 * Render an unexpected exception the way br_mcp.py's tools/call handler does:
 * "[error] <Type>: <message>".
 */
export function unexpectedError(e) {
    const name = e instanceof Error ? e.constructor.name : "Error";
    const message = e instanceof Error ? e.message : String(e);
    return errPrefix(`${name}: ${message}`);
}
/** Render a value as a JSON string (objects) or String() (plain text). */
export function asResultString(value) {
    if (typeof value === "string")
        return value;
    return JSON.stringify(value);
}
//# sourceMappingURL=errors.js.map