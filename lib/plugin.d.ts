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
     */
    autoLaunchChrome?: boolean;
}
export declare function apply(ctx: any, rawConfig?: PluginConfig | null): void;
