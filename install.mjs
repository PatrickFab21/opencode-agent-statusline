#!/usr/bin/env node
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
const files = ["tui.tsx", "usage.ts", "agent-providers.ts"]
const marker = ".npm-installer.json"
const config = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
const plugins = join(config, "plugins")
const target = join(plugins, pkg.name)
const sha256 = (data) => createHash("sha256").update(data).digest("hex")

async function exists(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

async function install() {
  const legacy = join(plugins, "statusline")
  if ((await exists(join(legacy, "tui.tsx"))) &&
      (await readFile(join(legacy, "tui.tsx"), "utf8")).includes('id: "local.statusline"')) {
    throw new Error(`A manual copy already exists at ${legacy}. Move it outside the plugins directory before installing to avoid duplicate statuslines.`)
  }

  const existing = await exists(target)
  if (existing) {
    const managed = existing.isDirectory() && await exists(join(target, marker))
    const manifest = managed ? JSON.parse(await readFile(join(target, marker), "utf8")) : undefined
    if (manifest?.name !== pkg.name) {
      throw new Error(`Refusing to overwrite an unmanaged plugin at ${target}.`)
    }
    // Preserve edits made after a previous install. A matching marker by
    // itself is not permission to overwrite files the user has customized.
    for (const file of files) {
      const actual = sha256(await readFile(join(target, file)))
      if (actual !== manifest.files?.[file]) throw new Error(`Refusing to overwrite modified file ${join(target, file)}.`)
    }
    if ((await readdir(target)).some((file) => file !== marker && !files.includes(file))) {
      throw new Error(`Refusing to overwrite ${target}: it contains additional files.`)
    }
    if (manifest.version === pkg.version) {
      console.log(`${pkg.name} ${pkg.version} is already installed at ${target}`)
      return
    }
  }

  await mkdir(plugins, { recursive: true })
  const stage = await mkdtemp(join(config, ".agent-statusline-"))
  const next = join(stage, "plugin")
  const backup = join(stage, "previous")
  let keepBackup = false
  try {
    await mkdir(next)
    const hashes = {}
    for (const file of files) {
      await copyFile(new URL(`./${file}`, import.meta.url), join(next, file), constants.COPYFILE_EXCL)
      hashes[file] = sha256(await readFile(join(next, file)))
    }
    await writeFile(join(next, marker), JSON.stringify({ name: pkg.name, version: pkg.version, files: hashes }), { flag: "wx" })
    if (existing) {
      await rename(target, backup)
      keepBackup = true
    }
    try {
      await rename(next, target)
    } catch (error) {
      if (keepBackup) {
        try {
          await rename(backup, target)
          keepBackup = false
        } catch {
          throw new Error(`Could not complete the update. Your previous copy is still at ${backup}.`, { cause: error })
        }
      }
      throw error
    }
    keepBackup = false
  } finally {
    if (!keepBackup) await rm(stage, { recursive: true, force: true })
  }
  console.log(`Installed ${pkg.name} ${pkg.version} at ${target}`)
  console.log("Open an OpenCode session, or use /reload if it is already running.")
}

const args = process.argv.slice(2)
try {
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) console.log(pkg.version)
  else if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(`Usage: ${pkg.name} [install|--version|--help]`)
  } else if (args.length === 0 || (args.length === 1 && args[0] === "install")) await install()
  else throw new Error(`Unknown arguments. Run ${pkg.name} --help.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
