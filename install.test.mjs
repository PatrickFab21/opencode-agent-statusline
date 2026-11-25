import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const bin = fileURLToPath(new URL("./install.mjs", import.meta.url))

async function fixture(t) {
  const configHome = await mkdtemp(join(tmpdir(), "agent-statusline-test-"))
  t.after(() => rm(configHome, { recursive: true, force: true }))
  const config = join(configHome, "opencode")
  const plugins = join(config, "plugins")
  return {
    config,
    plugins,
    run: () => spawnSync(process.execPath, [bin, "install"], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    }),
  }
}

test("installs once without changing OpenCode settings or overwriting user edits", async (t) => {
  const { config, plugins, run } = await fixture(t)
  await mkdir(config, { recursive: true })
  const settings = join(config, "cli.json")
  await writeFile(settings, '{"mouse":false}\n')
  assert.equal(run().status, 0)
  assert.match(run().stdout, /already installed/)
  assert.equal(await readFile(settings, "utf8"), '{"mouse":false}\n')

  const tui = join(plugins, "opencode-agent-statusline", "tui.tsx")
  assert.match(await readFile(tui, "utf8"), /Plugin\.define/)
  await writeFile(tui, "customized")
  const retry = run()
  assert.notEqual(retry.status, 0)
  assert.match(retry.stderr, /modified file/)
  assert.equal(await readFile(tui, "utf8"), "customized")
})

test("refuses to install alongside the original manual copy", async (t) => {
  const { plugins, run } = await fixture(t)
  const original = join(plugins, "statusline")
  await mkdir(original, { recursive: true })
  const tui = join(original, "tui.tsx")
  await writeFile(tui, 'const plugin = { id: "local.statusline" }')
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /manual copy/)
  assert.equal(await readFile(tui, "utf8"), 'const plugin = { id: "local.statusline" }')
})
