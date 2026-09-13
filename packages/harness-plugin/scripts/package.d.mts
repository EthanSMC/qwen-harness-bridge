export declare const HOST_PEER_PREFIX: string;
export declare const VENDOR_PREFIX: string;
export declare const CREDENTIAL_ASSIGNMENT: RegExp;
export declare const findCredentialAssignment: (text: string) => string | null;

export interface RuntimePackage {
  readonly directory: string;
  readonly version: string;
  readonly manifest: Record<string, unknown>;
}

export declare const runtimeClosure: (
  manifest: { dependencies?: Record<string, string> },
  fromDirectory: string,
) => Map<string, RuntimePackage>;

export interface TarEntryLike {
  readonly name: string;
  readonly data: Buffer;
}

export declare const assertCredentialFree: (
  entries: readonly TarEntryLike[],
  credentials?: readonly string[],
) => void;

export interface BuildArtifactOptions {
  readonly outFile: string;
  /** Values that must not appear anywhere in the archive. */
  readonly credentials?: readonly string[];
}

export interface BuiltArtifact {
  readonly outFile: string;
  readonly version: string;
  readonly entries: readonly string[];
  readonly vendoredDependencies: readonly string[];
  /** `<package>/<file>` for every vendored license text in the archive. */
  readonly vendoredLicenses: readonly string[];
  readonly manifest: Record<string, unknown>;
  readonly sha256: string;
}

export declare function buildArtifact(
  options: BuildArtifactOptions,
): BuiltArtifact;
