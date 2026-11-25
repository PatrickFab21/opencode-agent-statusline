/**
 * Lectura de límites de suscripción (Claude y Codex/ChatGPT) y formateo.
 * Sin JSX ni APIs del host: se puede probar con `bun usage.ts`.
 *
 * Seguridad: los tokens solo se leen del disco local y se envían únicamente a
 * los endpoints oficiales de cada proveedor. Nunca se refrescan ni se escriben:
 * Claude Code y OpenCode siguen siendo los dueños de sus credenciales.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir, totalmem, freemem } from "node:os"
import { join } from "node:path"

export interface Window {
  percent: number
  resetsAt?: number // epoch ms
}

export interface Limits {
  status: "ok" | "stale" | "error" | "loading"
  fiveHour?: Window
  weekly?: Window
  /** Semanal por familia de modelo cuando el proveedor lo separa (opus, sonnet, fable). */
  byModel?: Record<string, Window>
  message?: string
  checkedAt?: number
  /** Si hay bloqueo por 429, cuándo se vuelve a intentar (epoch ms). */
  retryAt?: number
}

const HOME = homedir()
const TIMEOUT = 8_000

async function readJson(path: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  return xdg ? join(xdg, "opencode") : join(HOME, ".local", "share", "opencode")
}

/* ---------------- Claude ---------------- */

export async function fetchClaude(): Promise<Limits> {
  const creds = await readJson(join(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), ".credentials.json"))
  const oauth = creds?.claudeAiOauth
  if (!oauth?.accessToken) return { status: "error", message: "sin login de Claude Code" }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now())
    return { status: "error", message: "token de Claude vencido (abre Claude Code)" }

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new HttpError(res.status, retryAfter(res))
  const body: any = await res.json()
  const win = (w: any): Window | undefined =>
    w && typeof w.utilization === "number"
      ? { percent: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined }
      : undefined
  const byModel: Record<string, Window> = {}
  for (const fam of ["opus", "sonnet", "fable", "haiku"]) {
    const w = win(body[`seven_day_${fam}`])
    if (w) byModel[fam] = w
  }
  return {
    status: "ok",
    fiveHour: win(body.five_hour),
    weekly: win(body.seven_day),
    byModel,
    checkedAt: Date.now(),
  }
}

/* ---------------- Codex / ChatGPT ---------------- */

async function codexCredential(): Promise<{ access: string; account: string } | undefined> {
  // 1) La conexión OAuth que usa OpenCode para el proveedor "openai".
  const oc = (await readJson(join(dataDir(), "auth.json")))?.openai
  if (oc?.type === "oauth" && oc.access && oc.accountId && (!oc.expires || oc.expires > Date.now()))
    return { access: oc.access, account: oc.accountId }
  // 2) Respaldo: el login de Codex CLI.
  const cx = (await readJson(join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "auth.json")))?.tokens
  if (cx?.access_token && cx.account_id) return { access: cx.access_token, account: cx.account_id }
  return undefined
}

export async function fetchCodex(): Promise<Limits> {
  const cred = await codexCredential()
  if (!cred) return { status: "error", message: "sin login de ChatGPT" }
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${cred.access}`,
      "ChatGPT-Account-Id": cred.account,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new HttpError(res.status, retryAfter(res))
  const body: any = await res.json()
  const win = (w: any): Window | undefined =>
    w && typeof w.used_percent === "number"
      ? { percent: w.used_percent, resetsAt: typeof w.reset_at === "number" ? w.reset_at * 1000 : undefined }
      : undefined
  return {
    status: "ok",
    fiveHour: win(body.rate_limit?.primary_window),
    weekly: win(body.rate_limit?.secondary_window),
    checkedAt: Date.now(),
  }
}

export class HttpError extends Error {
  status: number
  retryAfterMs?: number
  constructor(status: number, retryAfterMs?: number) {
    super(`HTTP ${status}`)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after")
  if (!h) return undefined
  const secs = Number(h)
  if (Number.isFinite(secs)) return secs * 1000
  const at = Date.parse(h)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/* ---------------- Caché compartida en disco ----------------
 * Sobrevive a recargas del plugin y se comparte entre ventanas de OpenCode,
 * así el endpoint se consulta como mucho una vez por minuto en total.
 */

export type Provider = "claude" | "codex"

interface CacheFile {
  data?: Limits // último dato bueno
  fetchedAt?: number // cuándo se intentó por última vez
  blockedUntil?: number // no consultar antes de esto (429)
  strikes?: number // 429 seguidos, para backoff exponencial
}

export const REFRESH_MS = 60_000
const CACHE_DIR = join(HOME, ".cache", "opencode-statusline")
const cachePath = (p: Provider) => join(CACHE_DIR, `${p}.json`)

async function saveCache(p: Provider, c: CacheFile) {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(cachePath(p), JSON.stringify(c))
  } catch {}
}

/** Lee la caché de ccstatusline (Claude Code) si es más reciente que la nuestra. */
async function ccstatuslineClaude(newerThan: number): Promise<Limits | undefined> {
  const dir = join(HOME, ".cache", "ccstatusline")
  let best: { at: number; body: any } | undefined
  try {
    const { readdir } = await import("node:fs/promises")
    for (const name of await readdir(dir)) {
      if (!/^usage.*\.json$/.test(name)) continue
      const at = (await stat(join(dir, name))).mtimeMs
      if (at > newerThan && (!best || at > best.at)) best = { at, body: await readJson(join(dir, name)) }
    }
  } catch {
    return undefined
  }
  const b = best?.body
  if (!b || typeof b.sessionUsage !== "number") return undefined
  const resetMs = (s: any) => (typeof s === "string" ? Date.parse(s) : undefined)
  // Un dato cuya ventana de 5h ya venció no sirve.
  const sReset = resetMs(b.sessionResetAt)
  if (sReset && sReset < Date.now()) return undefined
  const weeklyReset = resetMs(b.weeklyResetAt)
  const byModel: Record<string, Window> = {}
  // ccstatusline guarda 0 cuando no hay límite separado; solo usamos valores > 0.
  if (b.weeklyOpusUsage > 0) byModel.opus = { percent: b.weeklyOpusUsage, resetsAt: weeklyReset }
  if (b.weeklySonnetUsage > 0) byModel.sonnet = { percent: b.weeklySonnetUsage, resetsAt: weeklyReset }
  if (b.fableUsage > 0) byModel.fable = { percent: b.fableUsage, resetsAt: resetMs(b.fableResetAt) }
  return {
    status: "ok",
    fiveHour: { percent: b.sessionUsage, resetsAt: sReset },
    weekly: typeof b.weeklyUsage === "number" ? { percent: b.weeklyUsage, resetsAt: weeklyReset } : undefined,
    byModel,
    checkedAt: best!.at,
  }
}

const inflight: Partial<Record<Provider, Promise<Limits>>> = {}

/**
 * Devuelve los límites usando la caché; solo consulta la red si el último
 * intento tiene más de un minuto y no hay bloqueo por 429 vigente.
 */
export function getLimits(p: Provider): Promise<Limits> {
  return (inflight[p] ??= load(p).finally(() => delete inflight[p]))
}

async function load(p: Provider): Promise<Limits> {
  const now = Date.now()
  const cache: CacheFile = (await readJson(cachePath(p))) ?? {}

  if (p === "claude") {
    const cc = await ccstatuslineClaude(cache.data?.checkedAt ?? 0)
    if (cc && now - (cc.checkedAt ?? 0) < REFRESH_MS) {
      await saveCache(p, { ...cache, data: cc })
      return cc
    }
  }

  const fresh = cache.fetchedAt && now - cache.fetchedAt < REFRESH_MS
  const blocked = cache.blockedUntil && now < cache.blockedUntil
  if (fresh || blocked) {
    const retryAt = blocked ? cache.blockedUntil : undefined
    if (cache.data) return { ...cache.data, status: blocked ? "stale" : cache.data.status, retryAt }
    return { status: blocked ? "stale" : "loading", retryAt }
  }

  try {
    const data = await (p === "claude" ? fetchClaude() : fetchCodex())
    if (data.status === "ok") {
      await saveCache(p, { data, fetchedAt: now })
      return data
    }
    await saveCache(p, { ...cache, fetchedAt: now })
    return cache.data ? { ...cache.data, status: "stale", message: data.message } : data
  } catch (err) {
    const next: CacheFile = { ...cache, fetchedAt: now }
    let message = err instanceof Error ? err.message : String(err)
    if (err instanceof HttpError && err.status === 429) {
      const strikes = (cache.strikes ?? 0) + 1
      const backoff = err.retryAfterMs ?? Math.min(30, 2 ** strikes) * 60_000 // 2, 4, 8, 16, 30 min
      next.strikes = strikes
      next.blockedUntil = now + backoff
      message = "límite de consultas"
    }
    await saveCache(p, next)
    const retryAt = next.blockedUntil
    return cache.data ? { ...cache.data, status: "stale", message, retryAt } : { status: "stale", message, retryAt }
  }
}

/* ---------------- Formato ---------------- */

/** 13 → "13.0%" (mismo estilo que ccstatusline). */
export const pct = (n: number | undefined) => (n === undefined ? "--" : `${n.toFixed(1)}%`)

/** 72000 → "72k", 1000000 → "1.0M". */
export function compact(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** ms → "3hr 57m", "18hr 25m", "2d 4hr", "45s". */
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}hr ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}hr`
}

export function bar(ratio: number, width = 16): { full: string; empty: string } {
  const r = Math.min(1, Math.max(0, ratio))
  const n = Math.round(r * width)
  return { full: "█".repeat(n), empty: "░".repeat(width - n) }
}

export function memory(): string {
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1)
  const total = totalmem()
  return `${gb(total - freemem())}G/${gb(total)}G`
}

/** Tokens que ocupan la ventana de contexto (misma suma que usa OpenCode). */
export function contextUsed(t: any): number {
  if (!t) return 0
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
}
