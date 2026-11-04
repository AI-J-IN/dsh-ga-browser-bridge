/**
 * Error helpers — match br_mcp.py's error-string conventions.
 *
 * br_mcp.py returns plain strings from tools. Action-level errors use the
 * "[error] " prefix (e.g. "[error] unknown action: X (...)"), and unexpected
 * exceptions are rendered as "[error] <TypeName>: <message>".
 */
/** The "[error] " prefix used for action-level tool errors. */
export declare const ERROR_PREFIX = "[error] ";
/** Prefix a message with the "[error] " marker used by br_mcp.py action errors. */
export declare function errPrefix(msg: string): string;
/**
 * No-browser error string. Updated from br_mcp.py's _need_browser() for the
 * direct-CDP world (no GA master, no tmwd_cdp_bridge extension).
 */
export declare function noBrowserError(): string;
/**
 * Render an unexpected exception the way br_mcp.py's tools/call handler does:
 * "[error] <Type>: <message>".
 */
export declare function unexpectedError(e: unknown): string;
/** Render a value as a JSON string (objects) or String() (plain text). */
export declare function asResultString(value: unknown): string;
