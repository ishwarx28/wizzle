import { readFile } from "node:fs/promises";

export async function load(url, context, nextLoad) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol === "file:" && parsedUrl.pathname.endsWith(".txt")) {
    parsedUrl.search = "";
    const content = await readFile(parsedUrl, "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(content)};`,
    };
  }

  return nextLoad(url, context);
}
