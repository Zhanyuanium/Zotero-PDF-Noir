import { rm } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
await rm(path.join(ROOT, "build"), { recursive: true, force: true });
console.log("cleaned build/");
