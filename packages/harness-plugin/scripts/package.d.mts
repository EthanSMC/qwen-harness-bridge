export interface BuildArtifactOptions {
  readonly outFile: string;
  /** Values that must not appear anywhere in the archive. */
  readonly credentials?: readonly string[];
}

export interface BuiltArtifact {
  readonly outFile: string;
  readonly version: string;
  readonly entries: readonly string[];
}

/** Matches a quoted literal assigned to a credential-looking key. */
export declare const CREDENTIAL_ASSIGNMENT: RegExp;

export declare function buildArtifact(
  options: BuildArtifactOptions,
): BuiltArtifact;
