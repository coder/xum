#!/usr/bin/env bun
/**
 * Writes `<file>.br` and `<file>.gz` next to each large hashed top-level asset in <dir> (the
 * Vite renderer build), so `xum server` can send them precompressed (#5943).
 * Usage: bun scripts/precompress-static.ts dist
 */
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import * as zlib from "zlib";
import { isHashedStaticAssetName, PRECOMPRESSED_ENCODINGS } from "../src/node/orpc/staticAssets";

const COMPRESSIBLE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".svg", ".json", ".wasm"]);
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
// Brotli quality 11 took ~9x longer than 9 on the full bundle (18.5 s vs 2.1 s) for ~8% smaller
// output (5.08 vs 5.53 MiB), so 9 it is.
const { BROTLI_PARAM_QUALITY, BROTLI_PARAM_SIZE_HINT } = zlib.constants;
const compress = (encoding: "br" | "gzip", data: Buffer) =>
  encoding === "br"
    ? brotli(data, { params: { [BROTLI_PARAM_QUALITY]: 9, [BROTLI_PARAM_SIZE_HINT]: data.length } })
    : gzip(data, { level: 9 });
const exists = (filePath: string) => fs.stat(filePath).then(Boolean, () => false);

const dir = process.argv[2];
if (!dir) throw new Error("usage: bun scripts/precompress-static.ts <dir>");
const startMs = performance.now();
const totals = { files: 0, raw: 0, br: 0, gzip: 0 };

const names = await fs.readdir(dir);
await Promise.all(
  names.map(async (name) => {
    const filePath = path.join(dir, name);
    if (!isHashedStaticAssetName(name) || !COMPRESSIBLE_EXTENSIONS.has(path.extname(name))) return;
    const outputs = PRECOMPRESSED_ENCODINGS.map((e) => ({ ...e, path: filePath + e.extension }));
    // Hashed names never change content, and vite's emptyOutDir:false keeps old chunks in a
    // local dist/, so existing outputs are still valid.
    if ((await Promise.all(outputs.map((o) => exists(o.path)))).every(Boolean)) return;
    const data = await fs.readFile(filePath);
    if (data.length < 1024) return;
    await Promise.all(
      outputs.map(async (output) => {
        const compressed = await compress(output.encoding, data);
        // Write then rename: an interrupted build must not leave a truncated output that the
        // skip check above would trust on the next run.
        const tempPath = `${output.path}.${process.pid}.tmp`;
        await fs.writeFile(tempPath, compressed);
        await fs.rename(tempPath, output.path);
        totals[output.encoding] += compressed.length;
      })
    );
    totals.files += 1;
    totals.raw += data.length;
  })
);

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
console.log(
  `Precompressed ${totals.files} files: ${mib(totals.raw)} raw, ${mib(totals.br)} br, ` +
    `${mib(totals.gzip)} gzip in ${Math.round(performance.now() - startMs)} ms`
);
