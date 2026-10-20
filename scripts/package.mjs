import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, outputMarked } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function filesIn(directory, prefix = "") {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await filesIn(join(directory, entry.name), relative));
    else if (entry.isFile()) result.push({ name: relative, data: await readFile(join(directory, entry.name)) });
  }
  return result;
}

// A deterministic ZIP writer using the standard STORE method, avoiding platform ZIP tooling/dependencies.
export function createZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.replaceAll("\\", "/"), "utf8");
    const crc = crc32(file.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8); header.writeUInt16LE(1, 12); // DOS date: 1980-01-01, valid minimum ZIP date.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(file.data.length, 18); header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, file.data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10); entry.writeUInt16LE(1, 14); // DOS date: 1980-01-01.
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(file.data.length, 20); entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + file.data.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 0) throw new Error("打包不再接受参数：站点在扩展面板中配置");
    const extension = await buildExtension();
    const files = (await filesIn(extension)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const archive = createZip(files);
    const output = join(root, "dist", "openchamber-custom-provider-usage.zip");
    await mkdir(dirname(output), { recursive: true });
    const temporary = await mkdtemp(join(dirname(output), ".openchamber-custom-provider-usage-zip-"));
    const temporaryArchive = join(temporary, "package.zip");
    const backup = join(temporary, "previous.zip");
    let previous = false;
    let preserveTemporary = false;
    try {
      await writeFile(temporaryArchive, archive);
      try { await rename(output, backup); previous = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      try { await rename(temporaryArchive, output); }
      catch (error) {
        if (previous) {
          try { await rename(backup, output); previous = false; }
          catch { preserveTemporary = true; console.error(`ZIP 恢复失败，旧档案暂存于：${backup}`); }
        }
        throw error;
      }
    } finally {
      if (!preserveTemporary) await rm(temporary, { recursive: true, force: true });
    }
    console.log(`ZIP 已生成：${output} (${createHash("sha256").update(archive).digest("hex")})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "打包失败");
    if (await outputMarked()) console.error("扩展目录当前仍存在本项目的旧产物。");
    else console.error("扩展目录当前没有可确认的本项目构建产物。");
    console.error("ZIP 未能确认与扩展目录一致；已有 ZIP 可能是旧版或本次版本，请勿假定两者一致。");
    process.exitCode = 1;
  }
}
