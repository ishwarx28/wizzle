import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_JAVASCRIPT_CHUNK_BYTES = 1_250_000;
const distDirectory = resolve("dist");
const indexHtml = await readFile(resolve(distDirectory, "index.html"), "utf8");
const entryPath = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];

if (!entryPath) {
  throw new Error("Could not find the JavaScript entry chunk in dist/index.html.");
}

const assetNames = await readdir(resolve(distDirectory, "assets"));
const javascriptAssets = await Promise.all(
  assetNames
    .filter((assetName) => assetName.endsWith(".js"))
    .map(async (assetName) => ({
      assetName,
      bytes: await stat(resolve(distDirectory, "assets", assetName)).then(
        (assetStat) => assetStat.size,
      ),
      source: await readFile(resolve(distDirectory, "assets", assetName), "utf8"),
    })),
);
const asyncBootstrapAsset = javascriptAssets.find(({ source }) =>
  source.includes("let __tla ="),
);

if (asyncBootstrapAsset) {
  throw new Error(
    `The ${asyncBootstrapAsset.assetName} chunk has an asynchronous top-level-await bootstrap; this can prevent the desktop UI from mounting.`,
  );
}

const largestJavascriptAsset = javascriptAssets.reduce((largest, asset) =>
  asset.bytes > largest.bytes ? asset : largest,
);
if (largestJavascriptAsset.bytes > MAX_JAVASCRIPT_CHUNK_BYTES) {
  throw new Error(
    `${largestJavascriptAsset.assetName} is ${largestJavascriptAsset.bytes.toLocaleString()} bytes; JavaScript chunk budget is ${MAX_JAVASCRIPT_CHUNK_BYTES.toLocaleString()} bytes.`,
  );
}

console.log(
  `JavaScript chunk budget passed: ${largestJavascriptAsset.bytes.toLocaleString()} / ${MAX_JAVASCRIPT_CHUNK_BYTES.toLocaleString()} bytes.`,
);
