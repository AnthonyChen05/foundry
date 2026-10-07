/**
 * Emits each named protocol schema as a standalone JSON Schema file under
 * schema/generated/<Name>.json. TypeBox schemas ARE JSON Schema; this makes
 * them consumable by client codegen without importing TypeBox.
 *
 * Run as part of `pnpm build` (see package.json) or directly: `pnpm --filter @foundry/protocol emit`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_SCHEMAS } from "../src/index.js";

const OUT_DIR = join(import.meta.dirname, "..", "schema", "generated");

// Deduplicate by name (several events may share one shape).
const byName = new Map<string, (typeof PROTOCOL_SCHEMAS)[number]["schema"]>();
for (const { name, schema } of PROTOCOL_SCHEMAS) {
  byName.set(name, schema);
}

mkdirSync(OUT_DIR, { recursive: true });
const names = [...byName.keys()].sort();
for (const name of names) {
  const schema = byName.get(name);
  if (!schema) continue;
  const emitted = { ...schema, $id: name, title: name };
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(emitted, null, 2) + "\n", "utf8");
}
console.log(`emitted ${String(names.length)} JSON Schema files to ${OUT_DIR}`);