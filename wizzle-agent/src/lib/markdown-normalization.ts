const FENCE_CONTAINER_LANGUAGES = new Set([
  "markdown",
  "md",
  "mdown",
  "mdx",
  "mkd",
  "mkdn",
  "plaintext",
  "text",
]);

interface FenceLine {
  indent: string;
  marker: string;
  suffix: string;
}

interface IndexedFenceLine extends FenceLine {
  index: number;
}

function parseFenceLine(line: string): FenceLine | null {
  const match = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);

  if (!match) {
    return null;
  }

  return {
    indent: match[1] ?? "",
    marker: match[2] ?? "",
    suffix: match[3] ?? "",
  };
}

function fenceLanguage(fence: FenceLine) {
  return fence.suffix.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function replaceFenceMarker(fence: FenceLine, length: number) {
  return `${fence.indent}${fence.marker[0]?.repeat(length) ?? ""}${fence.suffix}`;
}

function isBareFence(fence: FenceLine) {
  return !fence.suffix.trim();
}

function pairedInnerFences(fences: IndexedFenceLine[]) {
  if (fences.length < 2 || fences.length % 2 !== 0) {
    return false;
  }

  for (let index = 1; index < fences.length; index += 2) {
    if (!isBareFence(fences[index])) {
      return false;
    }
  }

  return true;
}

function findOuterCloser(
  lines: string[],
  openerIndex: number,
  markerCharacter: string | undefined,
) {
  const compatibleFences: IndexedFenceLine[] = [];

  for (let index = openerIndex + 1; index < lines.length; index += 1) {
    const fence = parseFenceLine(lines[index] ?? "");

    if (!fence || fence.marker[0] !== markerCharacter) {
      continue;
    }

    compatibleFences.push({ ...fence, index });
  }

  for (let candidateIndex = compatibleFences.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = compatibleFences[candidateIndex];
    if (!candidate || !isBareFence(candidate)) {
      continue;
    }

    const innerFences = compatibleFences.slice(0, candidateIndex);
    if (pairedInnerFences(innerFences)) {
      return {
        closer: candidate,
        maximumInnerFenceLength: Math.max(
          ...innerFences.map((fence) => fence.marker.length),
        ),
      };
    }
  }

  return null;
}

/**
 * Models sometimes wrap a fenced Markdown example in another fence of the same
 * length. Lengthening only the outer fence preserves the example as one block.
 */
export function normalizeNestedCodeFences(content: string) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);

  for (let openerIndex = 0; openerIndex < lines.length; openerIndex += 1) {
    const opener = parseFenceLine(lines[openerIndex] ?? "");

    if (!opener || !FENCE_CONTAINER_LANGUAGES.has(fenceLanguage(opener))) {
      continue;
    }

    const outerCloser = findOuterCloser(lines, openerIndex, opener.marker[0]);
    if (!outerCloser) {
      continue;
    }

    const outerFenceLength = Math.max(
      opener.marker.length,
      outerCloser.maximumInnerFenceLength + 1,
    );
    lines[openerIndex] = replaceFenceMarker(opener, outerFenceLength);
    lines[outerCloser.closer.index] = replaceFenceMarker(
      outerCloser.closer,
      outerFenceLength,
    );
    openerIndex = outerCloser.closer.index;
  }

  return lines.join(newline);
}
