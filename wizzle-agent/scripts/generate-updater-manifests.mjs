import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [artifactRoot, repository, tag, version, note = "Wizzle update"] = process.argv.slice(2);
if (!artifactRoot || !repository || !tag || !version) {
  throw new Error(
    "Usage: generate-updater-manifests.mjs <artifact-root> <repository> <tag> <version> [note]",
  );
}

const platformArtifacts = {
  linux: "wizzle-linux-appimage",
  macos: "wizzle-macos-dmg",
  windows: "wizzle-windows-exe",
};

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(entryPath) : [entryPath];
  });
}

const outputDirectory = path.join(artifactRoot, "update-manifests");
fs.mkdirSync(outputDirectory, { recursive: true });

for (const [platform, artifactDirectory] of Object.entries(platformArtifacts)) {
  const directory = path.join(artifactRoot, artifactDirectory);
  const signaturePath = filesBelow(directory).find((file) => file.endsWith(".sig"));
  if (!signaturePath) {
    throw new Error(`No signed updater artifact was found for ${platform}.`);
  }
  const updaterPath = signaturePath.slice(0, -4);
  if (!fs.existsSync(updaterPath)) {
    throw new Error(`The signed updater package is missing for ${platform}.`);
  }
  const fileName = path.basename(updaterPath);
  const downloadUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
  const manifest = {
    version,
    notes: note,
    pub_date: new Date().toISOString(),
    url: downloadUrl,
    signature: fs.readFileSync(signaturePath, "utf8").trim(),
  };
  fs.writeFileSync(
    path.join(outputDirectory, `${platform}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
