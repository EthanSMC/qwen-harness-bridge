import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve(import.meta.dirname, "../src/db/migrations");
const destination = resolve(import.meta.dirname, "../dist/db/migrations");

await rm(destination, { recursive: true, force: true });
await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });
