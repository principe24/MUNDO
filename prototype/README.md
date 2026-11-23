# MUNDO Engine — isolated foundation prototype

This is a standalone JavaScript prototype, **not** the imported MUNDO Studio application.

Run with Node.js 20+: `cd prototype && npm test`.

Modules:
- Engine: ordered system lifecycle, asynchronous update and bounded delta.
- VirtualFiles: in-memory text file store, normalized absolute paths, snapshots.
- PluginManager: explicit registration, activation, deactivation, shutdown.

Limitations: no disk persistence, sandboxing, game renderer, multiplayer, asset pipeline or compatibility integration yet. Plugins execute trusted JavaScript only. Never load untrusted plugins without isolation.

Next: import the actual MUNDO Studio source, map existing interfaces, integrate these concepts selectively, add persistence and security boundaries, then run end-to-end tests.
