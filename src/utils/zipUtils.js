import crypto from "crypto";
import JSZip from "jszip";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { pipeline } from "stream/promises";

// Folders that are never needed on the target: dependencies and VCS data are
// rebuilt/ignored by the Docker builds. (Note: *.zip is NOT excluded, the
// generated importer ships its data as zipped shapefiles.)
export const DEFAULT_EXCLUDES = ["node_modules", ".git", ".gradle"];

// Already compressed: deflating them again only burns CPU (the generated importer ships
// hundreds of MB of zipped shapefiles and GeoTIFFs)
const STORED_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".jar",
  ".tif",
  ".tiff",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".woff",
  ".woff2",
]);

const compressionFor = (relative) =>
  STORED_EXTENSIONS.has(path.extname(relative).toLowerCase())
    ? "STORE"
    : "DEFLATE";

/**
 * Returns the files below `dir` as paths relative to it (posix separators).
 * @param {String} dir
 * @param {String[]} excludes Directory/file names to skip at any depth
 * @param {String} [prefix]
 * @returns {Promise<String[]>}
 */
export const listFiles = async (
  dir,
  excludes = DEFAULT_EXCLUDES,
  prefix = "",
) => {
  const entries = await fsp.readdir(path.join(dir, prefix), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    if (excludes.includes(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(dir, excludes, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
};

/**
 * SHA-256 of every file below `srcDir` (streamed: nothing is held in memory).
 * @param {String} srcDir
 * @param {Object} [opts]
 * @param {String[]} [opts.excludes]
 * @returns {Promise<Record<string, string>>} relative posix path -> hex digest
 */
export const hashFolder = async (srcDir, opts = {}) => {
  const { excludes = DEFAULT_EXCLUDES } = opts;
  const files = await listFiles(srcDir, excludes);
  const hashes = {};

  const queue = [...files];
  const worker = async () => {
    for (let relative = queue.shift(); relative; relative = queue.shift()) {
      const hash = crypto.createHash("sha256");
      await pipeline(fs.createReadStream(path.join(srcDir, relative)), hash);
      hashes[relative] = hash.digest("hex");
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  // Same order whatever the workers finished first
  return Object.fromEntries(
    Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
};

/**
 * Compresses a folder into a zip file, streaming to disk (the whole archive is
 * never held in memory). Errors propagate to the caller.
 * @param {String} srcDir
 * @param {String} destFile
 * @param {Object} [opts]
 * @param {String[]} [opts.excludes]
 * @param {String[]} [opts.files] Only these files (relative, posix) instead of the whole folder
 * @returns {Promise<{files: Number, bytes: Number}>}
 */
export const compressFolder = async (srcDir, destFile, opts = {}) => {
  const { excludes = DEFAULT_EXCLUDES } = opts;
  const files = opts.files || (await listFiles(srcDir, excludes));

  const zip = new JSZip();
  for (const relative of files) {
    zip.file(relative, fs.createReadStream(path.join(srcDir, relative)), {
      compression: compressionFor(relative),
    });
  }

  await pipeline(
    zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE" }),
    fs.createWriteStream(destFile),
  );

  return { files: files.length, bytes: (await fsp.stat(destFile)).size };
};
