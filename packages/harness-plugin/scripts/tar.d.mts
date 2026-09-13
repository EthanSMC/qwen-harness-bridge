export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
}

export declare function createTar(entries: readonly TarEntry[]): Buffer;

export declare function readTar(archive: Buffer): TarEntry[];
