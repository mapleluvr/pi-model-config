import { quarantineArtifact } from "../../atomic-file.ts";

const [filePath, timestamp] = process.argv.slice(2);
if (!filePath || !timestamp) process.exit(2);

quarantineArtifact(filePath, timestamp, {
  mode: 0o600,
  afterSecureMode() {
    process.exit(86);
  },
});
process.exit(3);
