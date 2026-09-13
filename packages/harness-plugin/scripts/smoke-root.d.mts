export declare const hasNodeModulesAncestor: (directory: string) => boolean;
export declare const hasRepositoryAncestor: (directory: string) => boolean;
export declare const isInsideRepository: (
  directory: string,
  repositoryRoot: string,
) => boolean;
export declare const createCleanRoot: (options: {
  repositoryRoot: string;
  label: string;
}) => string;
export declare const linkHostPeers: (options: {
  extensionRoot: string;
  packageRoot: string;
  peers: readonly string[];
}) => string[];
