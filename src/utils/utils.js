import path from "path";

export const getAbsolutePath = (folderPath) => {
  if (path.isAbsolute(folderPath)) return folderPath;

  return path.join(process.cwd(), folderPath);
};

/**
 * Quotes a value for a POSIX shell (used to build the scripts sent to a remote
 * machine over ssh).
 * @param {String} value
 * @returns {String}
 */
export const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Formats a duration as "12s" / "3m 04s".
 * @param {Number} ms
 * @returns {String}
 */
export const formatDuration = (ms) => {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
};
