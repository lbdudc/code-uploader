import fs from "fs";
import path from "path";
import UploadStrategy from "./UploadStrategy.js";
import { compressFolder, isScript, DEFAULT_EXCLUDES } from "../utils/zipUtils.js";
import { getAbsolutePath } from "../utils/utils.js";

/** Bookkeeping of a deployment made from the same folder: not for whoever gets the zip. */
const DEPLOYMENT_STATE = [".gp-deploy-state.json", ".gp-manifest.json"];

/**
 * Nothing is deployed: the generated app is zipped so that whoever receives it can run it
 * on any machine with Docker (no ssh access or cloud keys are handed to this tool). Used by
 * gispublisher's `--generate --zip`.
 *
 * Config: `repoPath` (the generated app), `file` (the zip to write), `name` (the folder
 * inside the zip) and `extraFiles` (README, start scripts: relative path -> content).
 */
class PackageStrategy extends UploadStrategy {
  plan() {
    return [
      {
        id: "package",
        label: "Create the zip",
        run: (ctx) => this._package(ctx),
      },
    ];
  }

  resolveUrl() {
    return null;
  }

  resultDetails(config, state) {
    return { file: state.file };
  }

  async _package(ctx) {
    const { config } = ctx;
    const source = getAbsolutePath(config.repoPath);
    if (!fs.existsSync(source)) throw new Error(`Folder not found: ${source}`);
    if (!config.file) throw new Error('"file" (where to save the package) is required');

    const file = path.resolve(config.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(file, { force: true });

    const { files, bytes } = await compressFolder(source, file, {
      excludes: [...DEFAULT_EXCLUDES, ...DEPLOYMENT_STATE],
      prefix: config.name || path.basename(file, ".zip"),
      extraFiles: config.extraFiles,
      isExecutable: isScript,
    });
    ctx.state.file = file;
    return { detail: `${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB` };
  }
}

export default PackageStrategy;
