# ADR 0002: Policy command roles and bounded search domains

Status: Accepted correction for Issue #10; implementation and independent verification pending.

## Context

Approval cannot override path containment or protected-resource denial. Raw administrative argument fallbacks, lost forwarded compiler semantics and shared short-option syntax currently violate that boundary. Conversely, scanning every repository descendant, including ignored dependencies, rejects an ordinary safe repository-wide ripgrep search. Requiring users to search only tiny subtrees does not meet the approved automatic-search outcome.

## Decision

Keep the public CanonicalAction shape and three policy classes unchanged. Parse every admitted external command through a finite command-specific role grammar before classification. Administrative paths receive the same canonical containment, protected-resource and final fingerprint checks as automatic actions. Unsupported or ambiguous forms are denied; supported contained package installation, Git push and deployment remain approval-required. Preserve destructive semantics through explicitly supported package-script forwarding. Interpret attached short-option values according to the selected executable, not a shared equals-sign heuristic. Explicit forbidden capabilities retain priority over every approval effect.

For ripgrep content searches, inspect the actual admitted candidate-file domain rather than all ignored filesystem entries. A policy-owned read-only helper may invoke only the immutable registered canonical ripgrep executable in filename-enumeration mode. Construct arguments from parsed path-selection roles using `--files`, NUL-delimited output and `--no-config`; never invoke a shell, forward search patterns/pattern-file options, enable preprocessing, or execute the requested content search during classification. Preserve admitted hidden/ignore/glob/type/depth selection semantics and explicit operand behavior. Direct pattern-file and path operands are separately validated before enumeration.

Enumeration must match the execution environment contract. If RIPGREP_CONFIG_PATH is nonempty and the requested command does not explicitly disable configuration, deny it instead of enumerating one domain and executing another. The trusted execution adapter must preserve the action and relevant environment through execution, as it must preserve executable, cwd and argv; an arbitrary per-action enumerator or caller-owned list cannot establish authority. Recheck at the final guard. Fail closed on any unsupported selection/configuration mode or ambiguous result.

Bound each enumeration to 10,000 candidate paths, 2 MiB output and 2 seconds elapsed time. Use no shell, close stdin, bound stderr, and do not expose its raw output or errors. A timeout, truncation, malformed NUL output, non-successful result or out-of-root/protected selected candidate denies the action. Inspect selected filenames and metadata only, not file contents. Empty domains require a valid completed enumeration, not a missing or failed helper. A metadata-only fast path is permissible only when it proves every possible selected file is safe; it must not turn uncertainty or a scan limit into authorization.

Grep and native tools must not inherit ripgrep ignore semantics. Retain bounded safe handling for explicitly supported grep modes. Executable-less native content search requires a trusted resolver's concrete file scope in touchedPaths; an unspecified or recursive directory scope is not proven safe by a parent path alone. The later composition adapter must faithfully execute the resolved scope. No OS sandbox or arbitrary-script analysis is claimed.

## Evidence and compatibility

Add actual-ripgrep tests for a repository with ignored dependency/VCS trees exceeding the old scan bound, hidden and no-ignore selection, include/exclude overrides, protected selected files, explicit operands, symlinks, filenames with delimiters and bounded helper failures. Establish positive ordinary root search plus unconditional denial when protected content is selected. Verify actual grep short-option interpretation separately. Use counter-only real Harness runtime tests for administrative denial and forwarded destructive approval; never execute pushes, installs, deletion or environment dumps as probes.

The registered ripgrep executable already represents a local tool dependency; do not silently substitute a different executable or download a binary during policy evaluation. Tests and CI must provide the actual supported tool for interoperability evidence, with any missing prerequisite made explicit. This correction adds no public endpoint, wire field, database migration or new approval bypass. Rollback retains persisted state and disables unverified policy composition rather than claiming the reverted guard remains safe.
