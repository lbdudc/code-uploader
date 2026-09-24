import JSZip from "jszip";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { pipeline } from "stream/promises";

// Folders that are never needed on the target: dependencies and VCS data are
// rebuilt/ignored by the Docker builds. (Note: *.zip is NOT excluded, the
// generated importer ships its data as zipped shapefiles.)
export const DEFAULT_EXCLUDES = ["node_modules", ".git", ".gradle"];

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
 * Compresses a folder into a zip file, streaming to disk (the whole archive is
 * never held in memory). Errors propagate to the caller.
 * @param {String} srcDir
 * @param {String} destFile
 * @param {Object} [opts]
 * @param {String[]} [opts.excludes]
 * @returns {Promise<{files: Number, bytes: Number}>}
 */
export const compressFolder = async (srcDir, destFile, opts = {}) => {
  const { excludes = DEFAULT_EXCLUDES } = opts;
  const files = await listFiles(srcDir, excludes);

  const zip = new JSZip();
  for (const relative of files) {
    zip.file(relative, fs.createReadStream(path.join(srcDir, relative)));
  }

  await pipeline(
    zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE" }),
    fs.createWriteStream(destFile),
  );

  return { files: files.length, bytes: (await fsp.stat(destFile)).size };
};
