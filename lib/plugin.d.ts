export declare const name = "ga-browser-bridge";
export declare const inject: string[];
export interface PluginConfig {
    /** CDP debug host. Default '127.0.0.1'. */
    host?: string;
    /** CDP debug port. Default 9222. */
    port?: number;
    /**
     * When the debug port is closed, automatically launch Chrome with
     * --remote-debugging-port (reusing the user's default profile so login
     * state is preserved). Default true. When false, tools fail fast with a
     * message telling the user the exact launch command.
     *
     * NOTE: on Chrome 136+ the default profile CANNOT open a debug port, so
     * this only works with a separate DSH_BROWSER_USER_DATA_DIR. The extension
     * transport (extensionPort) does not have this limitation.
     */
    autoLaunchChrome?: boolean;
    /**
     * Loopback port the plugin listens on so the DSH Browser Bridge Chrome
     * extension can connect. Default 18765. Set to 0 to disable the
     * extension transport entirely (CDP-only mode).
     */
    extensionPort?: number;
    /**
     * Transport preference:
     *  - 'auto' (default): use the extension when it is connected, else CDP.
     *  - 'extension': require the extension; fail clearly if it is missing.
     *  - 'cdp': always use the debug port (ignore any connected extension).
     */
    transport?: 'auto' | 'extension' | 'cdp';
}
export declare function apply(ctx: any, rawConfig?: PluginConfig | null): void;
