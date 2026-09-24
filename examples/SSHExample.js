import { Uploader, DebianUploadStrategy } from "../index.js";

const uploader = new Uploader();
uploader.setUploadStrategy(new DebianUploadStrategy());

const config = {
  host: "127.0.0.1",
  port: 22,
  username: "vboxuser",
  certRoute: "../id_rsa",
  repoPath: "../code",
  remoteRepoPath: "/home/vboxuser/code",
  projectName: "example",
};

// Packages the code, uploads it by SCP, installs Docker if needed and starts the stack
const { url } = await uploader.deploy(config, {
  onEvent: (event) => {
    if (event.type === "step") {
      console.log(
        `[${event.index}/${event.total}] ${event.label}: ${event.status}`,
      );
    }
  },
});
console.log(`Deployed at ${url}`);
