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

/** Scripts the builds run directly: they must stay executable on the target. */
export const isScript = (relative) =>
  path.basename(relative) === "gradlew" || relative.endsWith(".sh");

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
 * @param {String} [opts.prefix] Put everything below this folder inside the zip
 * @param {Record<string, string|Buffer>} [opts.extraFiles] Files that are not on disk (relative path -> content)
 * @param {(relative: String) => Boolean} [opts.isExecutable] Files that keep the executable bit
 *   (a zip made on Windows has no permissions: scripts would not run after unzipping on Linux)
 * @returns {Promise<{files: Number, bytes: Number}>}
 */
export const compressFolder = async (srcDir, destFile, opts = {}) => {
  const { excludes = DEFAULT_EXCLUDES } = opts;
  const files = opts.files || (await listFiles(srcDir, excludes));

  const { prefix = "", extraFiles = {}, isExecutable = () => false } = opts;
  const inZip = (relative) => (prefix ? `${prefix}/${relative}` : relative);
  const modeOf = (relative) => (isExecutable(relative) ? 0o755 : 0o644);

  const zip = new JSZip();
  for (const relative of files) {
    zip.file(inZip(relative), fs.createReadStream(path.join(srcDir, relative)), {
      compression: compressionFor(relative),
      unixPermissions: modeOf(relative),
    });
  }
  for (const [relative, content] of Object.entries(extraFiles)) {
    zip.file(inZip(relative), content, {
      compression: "DEFLATE",
      unixPermissions: modeOf(relative),
    });
  }

  await pipeline(
    zip.generateNodeStream({
      streamFiles: true,
      compression: "DEFLATE",
      platform: "UNIX",
    }),
    fs.createWriteStream(destFile),
  );

  return {
    files: files.length + Object.keys(extraFiles).length,
    bytes: (await fsp.stat(destFile)).size,
  };
};
