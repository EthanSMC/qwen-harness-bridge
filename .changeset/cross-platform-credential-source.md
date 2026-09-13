---
"@qhb/harness-plugin": minor
---

Select the connector credential source per platform: the macOS Keychain stays the
default on darwin, and a host without it configures a bounded file or environment
source that fails closed when the source is missing, ambiguous or unreadable.
No credential value reaches the configuration, the journal, the logs or the
packaged artifact.

The packaged artifact no longer vendors a native binding: the durable journal uses
the built-in `node:sqlite`, and the archive carries the LICENSE text of every
package it vendors.

The live rehearsal runner can boot a resident Harness host and keep the connector
journal in a caller-owned directory across runs.
