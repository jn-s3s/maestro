import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.resolve(HERE, "..", "resources");
const SOURCE = path.join(RESOURCES, "icon-source.png");

const PngTarget = { size: 256, name: "icon.png" };
const TrayTarget = { size: 32, name: "tray.png" };
const Tray2xTarget = { size: 64, name: "tray-2x.png" };
const IcoSizes = [16, 32, 48, 64, 128, 256];

async function isUpToDate(targetPath, sourcePath) {
    if (!existsSync(targetPath)) {
        return false;
    }
    const [srcStat, outStat] = await Promise.all([
        stat(sourcePath),
        stat(targetPath),
    ]);
    return outStat.mtimeMs >= srcStat.mtimeMs;
}

async function ensureSquarePng(input) {
    const meta = await sharp(input).metadata();
    if (meta.format !== "png") {
        throw new Error(
            `Source icon must be a PNG, got '${meta.format ?? "unknown"}'`,
        );
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width !== height) {
        throw new Error(`Source icon must be square, got ${width}x${height}`);
    }
    if (width < 256) {
        throw new Error(
            `Source icon must be at least 256x256, got ${width}x${height}`,
        );
    }
    return { width, height };
}

async function writePng(input, target) {
    const out = path.join(RESOURCES, target.name);
    if (await isUpToDate(out, input)) {
        return "skipped";
    }
    await sharp(input)
        .resize(target.size, target.size, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toFile(out);
    return "wrote";
}

async function writeIco(input) {
    const out = path.join(RESOURCES, "icon.ico");
    if (await isUpToDate(out, input)) {
        return "skipped";
    }
    const buffers = await Promise.all(
        IcoSizes.map((size) =>
            sharp(input)
                .resize(size, size, {
                    fit: "contain",
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .png()
                .toBuffer(),
        ),
    );
    const ico = buildIco(buffers, IcoSizes);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, ico);
    return "wrote";
}

function buildIco(pngBuffers, sizes) {
    const headerSize = 6;
    const entrySize = 16;
    const offset = headerSize + entrySize * sizes.length;
    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    const entries = [];
    const data = [];
    let cursor = offset;
    for (let i = 0; i < sizes.length; i += 1) {
        const size = sizes[i];
        const buf = pngBuffers[i];
        const entry = Buffer.alloc(entrySize);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);
        entry.writeUInt8(size >= 256 ? 0 : size, 1);
        entry.writeUInt8(0, 2);
        entry.writeUInt8(0, 3);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(buf.length, 8);
        entry.writeUInt32LE(cursor, 12);
        entries.push(entry);
        data.push(buf);
        cursor += buf.length;
    }
    return Buffer.concat([header, ...entries, ...data]);
}

async function main() {
    if (!existsSync(SOURCE)) {
        throw new Error(
            `Missing ${SOURCE}. Add a square PNG (>= 256x256) named icon-source.png under resources/`,
        );
    }
    const { width, height } = await ensureSquarePng(SOURCE);
    console.log(
        `source: ${width}x${height} -> ${path.relative(process.cwd(), SOURCE)}`,
    );
    const results = await Promise.all([
        writePng(SOURCE, PngTarget).then((r) => [PngTarget.name, r]),
        writePng(SOURCE, TrayTarget).then((r) => [TrayTarget.name, r]),
        writePng(SOURCE, Tray2xTarget).then((r) => [Tray2xTarget.name, r]),
        writeIco(SOURCE).then((r) => ["icon.ico", r]),
    ]);
    for (const [name, result] of results) {
        console.log(`  ${result}: ${name}`);
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
