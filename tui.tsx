/** @jsxImportSource @opentui/solid */
/**
 * statusline — barra de estado estilo ccstatusline para OpenCode v2.
 *
 *   Model: Opus 5.5 (high) | Provider: Claude Agent | Session 5h: 13.0% | Reset: 3hr 52m | Weekly: 3.0%
 *   Context: [█░░░░░░░░░░░░░░░] 72k/1.0M (7%) | Mem: 26.1G/31.4G
 *   Agents: ◀ 1/2 ▶ Google | Session 5h: -- | Reset: -- | Weekly: --
 *
 * La primera línea muestra los límites del proveedor del modelo activo
 * (Claude para "claude-agent"/"anthropic", Codex para "openai"). La segunda
 * muestra contexto y memoria; la tercera recorre los demás proveedores de subagentes.
 *
 * Comandos: /statusline para las cuotas y /agent-provider para avanzar.
 */
import { Plugin } from "@opencode/plugin/tui"
import { Show, createMemo, createSignal } from "solid-js"
import { collectAgentProviders, cycleProvider, providerIndex, recordedAgentUsage } from "./agent-providers.ts"
import {
  REFRESH_MS,
  bar,
  compact,
  contextUsed,
  getLimits,
  memory,
  pct,
  span,
  type Limits,
  type Provider,
} from "./usage.ts"

const C = {
  label: "#6f8f8f",
  model: "#5fd7af",
  provider: "#d787af",
  five: "#d7d7d7",
  session: "#af87d7",
  reset: "#d7af5f",
  ctx: "#5f87d7",
  week: "#87afff",
  mem: "#5faf87",
  sep: "#5c5c5c",
  ok: "#5faf5f",
  warn: "#d7af00",
  bad: "#d75f5f",
  dim: "#6c6c6c",
}

const tone = (p: number | undefined) => (p === undefined ? C.dim : p >= 90 ? C.bad : p >= 70 ? C.warn : undefined)

const providerOf = (id: string | undefined): Provider | undefined =>
  id === "openai" ? "codex" : id === "claude-agent" || id === "anthropic" ? "claude" : undefined

interface Seg {
  text: string
  fg?: string
}

export default Plugin.define({
  id: "local.statusline",
  setup(ctx) {
    const [tick, setTick] = createSignal(0)
    const bump = () => setTick((n) => n + 1)
    const selectedByRoot = new Map<string, string>()

    /* ---------- límites de suscripción ---------- */
    const state: Record<Provider, Limits> = {
      claude: { status: "loading" },
      codex: { status: "loading" },
    }
    let disposed = false

    // getLimits usa la caché compartida en disco: consulta la red como mucho
    // una vez por minuto y respeta los bloqueos por 429.
    async function refresh(p: Provider) {
      try {
        const next = await getLimits(p)
        if (!disposed) state[p] = next
      } catch {}
    }
    const refreshAll = async () => {
      await Promise.all([refresh("claude"), refresh("codex")])
      if (!disposed) bump()
    }

    /* ---------- datos de la sesión ---------- */
    const currentSession = (): string | undefined => {
      const r = ctx.ui.router.current() as { type?: string; sessionID?: string }
      return r?.type === "session" ? r.sessionID : undefined
    }
    const location = () => ctx.location ?? ctx.data.location.default()

    const modelInfo = (providerID?: string, modelID?: string) => {
      if (!providerID || !modelID) return undefined
      for (const m of (ctx.data.location.model.list(location()) ?? []) as any[]) {
        if ((m?.id === modelID || m?.modelID === modelID) && m?.providerID === providerID) return m
      }
      return undefined
    }

    const PROVIDER_NAMES: Record<string, string> = {
      "claude-agent": "Claude Agent",
      anthropic: "Anthropic",
      openai: "OpenAI",
      opencode: "OpenCode Zen",
    }
    const providerName = (providerID?: string): string | undefined => {
      if (!providerID) return undefined
      try {
        for (const p of (ctx.data.location.provider.list(location()) ?? []) as any[]) {
          if (p?.id === providerID && typeof p.name === "string" && p.name) return p.name
        }
      } catch {}
      return PROVIDER_NAMES[providerID] ?? providerID
    }

    const agentsFor = (sessionID: string) => {
      const root = ctx.data.session.root(sessionID)
      const family = ctx.data.session.family(root).map((id) => {
        const child = ctx.data.session.get(id)
        return { id, model: child?.model, tokens: child?.tokens, cost: child?.cost, messages: ctx.data.session.message.list(id) }
      })
      // La primera fila ya muestra el proveedor activo y su cuota de cuenta.
      const mainID = activeModel(sessionID).providerID
      const mainQuota = providerOf(mainID)
      const providers = collectAgentProviders(root, family).filter((id) =>
        id !== mainID && (!mainQuota || providerOf(id) !== mainQuota),
      )
      return { root, family, providers, index: providerIndex(providers, selectedByRoot.get(root)) }
    }

    const moveAgentProvider = (direction: -1 | 1) => {
      const id = currentSession()
      if (!id) return
      const { root, providers } = agentsFor(id)
      if (providers.length < 2) return
      const next = cycleProvider(providers, selectedByRoot.get(root), direction)
      if (next) {
        selectedByRoot.set(root, next)
        bump()
      }
    }

    const activeModel = (sessionID?: string) => {
      const sel = (ctx.ui.model.current() ?? {}) as any
      const ses = sessionID ? ((ctx.data.session.get(sessionID) as any)?.model ?? {}) : {}
      const providerID: string | undefined = sel.providerID ?? ses.providerID
      const modelID: string | undefined = sel.modelID ?? sel.id ?? ses.id ?? ses.modelID
      const info = modelInfo(providerID, modelID)
      return {
        providerID,
        modelID,
        variant: sel.variant as string | undefined,
        name: (info?.name as string | undefined) ?? modelID ?? "—",
        context: info?.limit?.context as number | undefined,
      }
    }

    const lastWindow = (sessionID: string) => {
      const msgs = (ctx.data.session.message.list(sessionID) ?? []) as any[]
      let tokens: any
      let model: any
      for (const m of msgs) {
        if (m?.type !== "assistant" || !m.tokens) continue
        if (contextUsed(m.tokens) > 0) {
          tokens = m.tokens
          model = m.model
        }
      }
      return { tokens, model }
    }

    /* ---------- construcción de las líneas ---------- */
    const SEP: Seg = { text: " | ", fg: C.sep }

    const FAMILY_LABEL: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", fable: "Fable", haiku: "Haiku" }
    const familyOf = (name?: string) => /opus|sonnet|fable|haiku/i.exec(name ?? "")?.[0].toLowerCase()

    /** Texto de espera cuando no hay dato todavía. */
    const waiting = (l: Limits) =>
      l.retryAt && l.retryAt > Date.now() ? ` (reintenta en ${span(l.retryAt - Date.now())})` : ""

    /** Límites del modelo activo: Session 5h | Reset | Weekly [familia]. */
    const primarySegs = (p: Provider, modelName: string): Seg[] => {
      const l = state[p]
      const stale = l.status === "stale" ? "*" : ""
      if (!l.fiveHour && !l.weekly) return [{ text: `Session 5h: --${waiting(l)}`, fg: C.dim }]
      const fam = familyOf(modelName)
      const famWeek = fam ? l.byModel?.[fam] : undefined
      const week = famWeek ?? l.weekly
      const reset = l.fiveHour?.resetsAt ? span(l.fiveHour.resetsAt - Date.now()) : "--"
      return [
        { text: "Session 5h: ", fg: C.five },
        { text: pct(l.fiveHour?.percent) + stale, fg: tone(l.fiveHour?.percent) ?? C.five },
        SEP,
        { text: "Reset: ", fg: C.reset },
        { text: reset, fg: C.reset },
        SEP,
        { text: famWeek ? `Weekly ${FAMILY_LABEL[fam!]}: ` : "Weekly: ", fg: C.week },
        { text: pct(week?.percent) + stale, fg: tone(week?.percent) ?? C.week },
      ]
    }

    const agentSegs = (providerID: string, usage: { tokens: number; cost: number }): Seg[] => {
      const p = providerOf(providerID)
      const name = { text: providerName(providerID) ?? providerID, fg: C.provider }
      if (!p) {
        const cost = usage.cost >= 0.01 ? `$${usage.cost.toFixed(2)}`
          : usage.cost >= 0.000001 ? `~$${usage.cost.toFixed(6).replace(/0+$/, "")}` : "<$0.000001"
        return [
          name,
          SEP,
          { text: `Tokens: ${usage.tokens > 0 ? compact(usage.tokens) : "--"}`, fg: C.ctx },
          ...(usage.cost > 0 ? [SEP, { text: `Est. cost: ${cost}`, fg: C.reset }] : []),
          SEP,
          { text: "Account quota: --", fg: C.dim },
        ]
      }
      const l = state[p]
      const stale = l.status === "stale" ? "*" : ""
      const reset = l.fiveHour?.resetsAt ? span(l.fiveHour.resetsAt - Date.now()) : "--"
      return [
        name,
        SEP,
        { text: "Session 5h: ", fg: C.five },
        { text: pct(l.fiveHour?.percent) + stale, fg: tone(l.fiveHour?.percent) ?? C.five },
        SEP,
        { text: "Reset: ", fg: C.reset },
        { text: reset, fg: C.reset },
        SEP,
        { text: "Weekly: ", fg: C.week },
        { text: pct(l.weekly?.percent) + stale, fg: tone(l.weekly?.percent) ?? C.week },
      ]
    }

    const build = (sessionID: string): Seg[][] => {
      const m = activeModel(sessionID)
      const session = ctx.data.session.get(sessionID) as any
      const win = lastWindow(sessionID)
      const primary = providerOf(m.providerID)

      // Línea 1
      const l1: Seg[] = [
        { text: "Model: ", fg: C.model },
        { text: m.name + (m.variant ? ` (${m.variant})` : ""), fg: C.model },
      ]
      const prov = providerName(m.providerID)
      if (prov) l1.push(SEP, { text: "Provider: ", fg: C.label }, { text: prov, fg: C.provider })
      const created = session?.time?.created
      if (primary) l1.push(SEP, ...primarySegs(primary, m.name))
      if (typeof created === "number") l1.push(SEP, { text: `Time: ${span(Date.now() - created)}`, fg: C.session })
      const cost = session?.cost
      if (typeof cost === "number" && cost > 0) l1.push(SEP, { text: `$${cost.toFixed(2)}`, fg: C.reset })

      // Línea 2
      const used = contextUsed(win.tokens)
      const limit =
        modelInfo(win.model?.providerID, win.model?.id ?? win.model?.modelID)?.limit?.context ?? m.context
      const l2: Seg[] = []
      if (limit) {
        const ratio = used / limit
        const b = bar(ratio)
        const color = ratio >= 0.9 ? C.bad : ratio >= 0.7 ? C.warn : C.ctx
        l2.push(
          { text: "Context: [", fg: C.ctx },
          { text: b.full, fg: color },
          { text: b.empty, fg: C.sep },
          { text: "] ", fg: C.ctx },
          { text: `${compact(used)}/${compact(limit)} (${Math.round(ratio * 100)}%)`, fg: color },
        )
      } else {
        l2.push({ text: `Context: ${compact(used)}`, fg: C.ctx })
      }
      l2.push(SEP, { text: `Mem: ${memory()}`, fg: C.mem })

      return [l1, l2]
    }

    /* ---------- render ---------- */
    const Line = () => {
      const agents = createMemo(() => {
        tick()
        const id = currentSession()
        if (!id) return undefined
        const { root, family, providers, index } = agentsFor(id)
        const provider = providers[index]
        if (!provider) return undefined
        return { count: providers.length, index, segments: agentSegs(provider, recordedAgentUsage(root, family, provider)) }
      })
      const rows = createMemo<Seg[][]>(() => {
        tick()
        const id = currentSession()
        if (!id) return []
        try {
          return build(id)
        } catch (err) {
          return [[{ text: `statusline: ${err instanceof Error ? err.message : String(err)}`, fg: C.bad }]]
        }
      })
      return (
        <Show when={rows().length > 0}>
          <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} minHeight={rows().length + (agents() ? 2 : 1)}>
            {rows().map((segs) => (
              <text wrapMode="none">
                {segs.map((s) => (
                  <span style={{ fg: s.fg }}>{s.text}</span>
                ))}
              </text>
            ))}
            <Show when={agents()}>{(view) => (
              <box flexDirection="row" flexShrink={0} height={1}>
                <text fg={C.label} flexShrink={0}>{"Agents: "}</text>
                <Show when={view().count > 1}>
                  <text fg={C.provider} flexShrink={0} selectable={false} onMouseUp={(event) => {
                    if (event.button !== 0) return
                    event.stopPropagation()
                    moveAgentProvider(-1)
                  }}>{"◀ "}</text>
                  <text fg={C.label} flexShrink={0}>{`${view().index + 1}/${view().count}`}</text>
                  <text fg={C.provider} flexShrink={0} selectable={false} onMouseUp={(event) => {
                    if (event.button !== 0) return
                    event.stopPropagation()
                    moveAgentProvider(1)
                  }}>{" ▶ "}</text>
                </Show>
                <text wrapMode="none">
                  {view().segments.map((s) => <span style={{ fg: s.fg }}>{s.text}</span>)}
                </text>
              </box>
            )}</Show>
          </box>
        </Show>
      )
    }

    const removeLine = ctx.ui.slot({ append: "app", render: () => <Line /> })

    // El keymap debe registrarse dentro del árbol de la app y en modo global.
    const removeCmd = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "local.statusline.agents.next",
              title: "Status line: next subagent provider",
              group: "Status line",
              palette: true,
              slash: { name: "agent-provider" },
              run: () => moveAgentProvider(1),
            },
            {
              id: "local.statusline.refresh",
              title: "Status line: refresh limits",
              group: "Status line",
              palette: true,
              slash: { name: "statusline" },
              run: async () => {
                await refreshAll()
                const fmt = (name: string, l: Limits) =>
                  `${name}: sesión ${pct(l.fiveHour?.percent)} · semanal ${pct(l.weekly?.percent)}` +
                  (l.message ? ` (${l.message})` : "") +
                  waiting(l)
                ctx.ui.toast.show({
                  title: "Límites actualizados",
                  message: `${fmt("Claude", state.claude)}\n${fmt("Codex", state.codex)}`,
                  variant: "info",
                  duration: 5000,
                })
              },
            },
          ],
        }))
        return null
      },
    })

    const stops = [
      ctx.data.on("session.usage.updated", () => bump()),
      ctx.data.on("session.model.selected", () => bump()),
      ctx.data.on("session.execution.succeeded", () => void refreshAll()),
    ]
    // Una sola actualización por minuto: límites, Time, Reset y memoria.
    // (El contexto también se actualiza al terminar cada respuesta.)
    const minute = setInterval(() => void refreshAll(), REFRESH_MS)
    void refreshAll()

    return () => {
      disposed = true
      clearInterval(minute)
      for (const s of stops) s()
      removeLine()
      removeCmd()
    }
  },
})
