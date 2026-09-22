import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.resolve(HERE, "..", "resources");
const SOURCE = path.join(RESOURCES, "icon-source.png");

const PNG_TARGET = { size: 256, name: "icon.png" };
const TRAY_TARGET = { size: 32, name: "tray.png" };
const TRAY_2X_TARGET = { size: 64, name: "tray-2x.png" };
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/**
 * Reports whether an output file is newer than the source it was built from.
 *
 * @param {string} targetPath - The generated file to check.
 * @param {string} sourcePath - The source icon it was derived from.
 * @returns {Promise<boolean>} True when the target exists and is up to date.
 */
async function isUpToDate(targetPath, sourcePath) {
    if (!existsSync(targetPath)) {
        return false;
    }
    const [sourceStat, outputStat] = await Promise.all([
        stat(sourcePath),
        stat(targetPath),
    ]);
    return outputStat.mtimeMs >= sourceStat.mtimeMs;
}

/**
 * Validates that the source icon is a square PNG large enough to downscale.
 *
 * @param {string} input - Path to the source image.
 * @returns {Promise<{width: number, height: number}>} The source dimensions.
 * @throws When the source is not a square PNG of at least 256x256.
 */
async function ensureSquarePng(input) {
    const metadata = await sharp(input).metadata();
    if (metadata.format !== "png") {
        throw new Error(
            `Source icon must be a PNG, got '${metadata.format ?? "unknown"}'`,
        );
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
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

/**
 * Writes one resized PNG target, skipping it when already up to date.
 *
 * @param {string} input - Path to the source image.
 * @param {{size: number, name: string}} target - The size and file name to build.
 * @returns {Promise<string>} Either "wrote" or "skipped".
 */
async function writePng(input, target) {
    const output = path.join(RESOURCES, target.name);
    if (await isUpToDate(output, input)) {
        return "skipped";
    }
    await sharp(input)
        .resize(target.size, target.size, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toFile(output);
    return "wrote";
}

/**
 * Writes the multi-size Windows icon, skipping it when already up to date.
 *
 * @param {string} input - Path to the source image.
 * @returns {Promise<string>} Either "wrote" or "skipped".
 */
async function writeIco(input) {
    const output = path.join(RESOURCES, "icon.ico");
    if (await isUpToDate(output, input)) {
        return "skipped";
    }
    const buffers = await Promise.all(
        ICO_SIZES.map((size) =>
            sharp(input)
                .resize(size, size, {
                    fit: "contain",
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .png()
                .toBuffer(),
        ),
    );
    const ico = buildIco(buffers, ICO_SIZES);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(output, ico);
    return "wrote";
}

/**
 * Assembles an ICO container from pre-rendered PNG frames.
 *
 * @param {Buffer[]} pngBuffers - One encoded PNG per entry, same order as sizes.
 * @param {number[]} sizes - Edge length in pixels for each entry.
 * @returns {Buffer} The complete ICO file contents.
 */
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
        const buffer = pngBuffers[i];
        const entry = Buffer.alloc(entrySize);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);
        entry.writeUInt8(size >= 256 ? 0 : size, 1);
        entry.writeUInt8(0, 2);
        entry.writeUInt8(0, 3);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(buffer.length, 8);
        entry.writeUInt32LE(cursor, 12);
        entries.push(entry);
        data.push(buffer);
        cursor += buffer.length;
    }
    return Buffer.concat([header, ...entries, ...data]);
}

/**
 * Regenerates every icon asset that is out of date with the source PNG.
 *
 * @returns {Promise<void>} Resolves once all targets have been reported.
 * @throws When the source icon is missing or is not a square PNG of at
 * least 256x256.
 */
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
        writePng(SOURCE, PNG_TARGET).then((r) => [PNG_TARGET.name, r]),
        writePng(SOURCE, TRAY_TARGET).then((r) => [TRAY_TARGET.name, r]),
        writePng(SOURCE, TRAY_2X_TARGET).then((r) => [TRAY_2X_TARGET.name, r]),
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
