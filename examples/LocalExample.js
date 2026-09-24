import { Uploader, LocalUploadStrategy } from "../index.js";

const uploader = new Uploader();
uploader.setUploadStrategy(new LocalUploadStrategy());

// Runs <repoPath>/deploy/docker-compose.yml with the local Docker
const { url } = await uploader.deploy(
  { repoPath: "./code", projectName: "example" },
  {
    onEvent: (event) => {
      if (event.type === "step") {
        console.log(
          `[${event.index}/${event.total}] ${event.label}: ${event.status}`,
        );
      }
    },
  },
);
console.log(`Deployed at ${url}`);
