import { mkdir, mkdtemp, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildExtension } from "./build.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const actual = join(root, "dist", "extension");
const approvedTemp = join(tmpdir(), "opencode");

async function files(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await files(join(directory, entry.name), name));
    else if (entry.isFile()) found.push(name);
  }
  return found.sort();
}

export async function assertDirectoriesMatch(expectedDirectory, actualDirectory) {
  const expectedFiles = await files(expectedDirectory);
  const actualFiles = await files(actualDirectory);
  const differences = [];
  for (const name of new Set([...expectedFiles, ...actualFiles])) {
    if (!expectedFiles.includes(name)) differences.push(`多余: ${name}`);
    else if (!actualFiles.includes(name)) differences.push(`缺失: ${name}`);
    else if (!(await readFile(join(expectedDirectory, name))).equals(await readFile(join(actualDirectory, name)))) differences.push(`过期: ${name}`);
  }
  if (differences.length) throw new Error(`dist/extension 与当前构建不一致：\n${differences.join("\n")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(approvedTemp, { recursive: true });
  const expected = await mkdtemp(join(approvedTemp, "openchamber-custom-provider-usage-test-check-"));
  try {
    // mkdtemp reserves a unique, ours-only path; remove the empty reservation so
    // buildExtension can safely create its marked output directory there.
    await rmdir(expected);
    await buildExtension(expected);
    await assertDirectoriesMatch(expected, actual);
    console.log("dist/extension 与当前构建一致");
  } finally {
    await rm(expected, { recursive: true, force: true });
  }
}
