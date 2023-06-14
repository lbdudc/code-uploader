import JSZip from 'jszip';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';

// Code from https://github.com/Stuk/jszip/issues/386

/**
 * Compresses a folder into a zip file
 * @param {String} srcDir 
 * @param {String} destFile 
 */
export const compressFolder = async (srcDir, destFile) => {
  console.log('Compressing folder', srcDir, 'to', destFile);
  const start = Date.now();
  try {
    const zip = await createZipFromFolder(srcDir);

    // Await the end of the async zip generation
    await zip.generateAsync({ type: 'nodebuffer' }).then((content) => {
      // Once the zip is async generated, save it to disk
      fs.writeFileSync(destFile, content);
    });

    console.log('Zip written successfully:', Date.now() - start, 'ms');

  } catch (ex) {
    console.error('Error creating zip', ex);
  }
};

/**
 * Returns a flat array of absolute paths of all files recursively contained in the dir
 * @param {String} dir 
 * @returns {Promise<String[]>}
 */
const getFilePathsRecursively = async (dir) => {
  // returns a flat array of absolute paths of all files recursively contained in the dir
  const list = await fsp.readdir(dir);
  const statPromises = list.map(async (file) => {
    const fullPath = path.resolve(dir, file);
    const stat = await fsp.stat(fullPath);
    if (stat && stat.isDirectory()) {
      return getFilePathsRecursively(fullPath);
    }
    return fullPath;
  });

  return (await Promise.all(statPromises)).flat(Infinity);
};


/**
 * Creates a zip file from a folder
 * @param {String} dir 
 * @returns {Promise<JSZip>}
 */
const createZipFromFolder = async (dir) => {
  const absRoot = path.resolve(dir);
  const filePaths = await getFilePathsRecursively(dir);
  return filePaths.reduce((z, filePath) => {
    const relative = filePath.replace(absRoot, '');
    // create folder trees manually :(
    const zipFolder = path
      .dirname(relative)
      .split(path.sep)
      .reduce((zf, dirName) => zf.folder(dirName), z);

    zipFolder.file(path.basename(filePath), fs.createReadStream(filePath));
    return z;
  }, new JSZip());
};