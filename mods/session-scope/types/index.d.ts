export type Scope = string

declare module 'claude-code' {
  interface PluginState {
    'session-scope': { scope: Scope }
  }
}
