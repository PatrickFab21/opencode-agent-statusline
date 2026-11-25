import { contextUsed } from "./usage.ts"

type Model = { providerID?: string }
type Tokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
type Usage = { tokens?: Tokens; cost?: number }
type Message = Usage & { type?: string; model?: Model }
type Child = Usage & { id: string; model?: Model; messages?: readonly Message[] }

export function collectAgentProviders(rootID: string, family: readonly Child[]): string[] {
  const providers = new Set<string>()
  for (const child of family) {
    if (child.id === rootID) continue
    const reported = child.messages?.flatMap((message) =>
      message.type === "assistant" && message.model?.providerID ? [message.model.providerID] : [],
    )
    for (const provider of reported?.length ? reported : [child.model?.providerID]) {
      if (provider) providers.add(provider)
    }
  }
  return [...providers].sort()
}

export function providerIndex(providers: readonly string[], selected?: string): number {
  return Math.max(0, selected ? providers.indexOf(selected) : -1)
}

export function cycleProvider(providers: readonly string[], selected: string | undefined, direction: -1 | 1) {
  if (!providers.length) return undefined
  return providers[(providerIndex(providers, selected) + direction + providers.length) % providers.length]
}

export function recordedAgentUsage(rootID: string, family: readonly Child[], providerID: string) {
  let tokens = 0
  let cost = 0
  for (const child of family) {
    if (child.id === rootID) continue
    const messages = child.messages?.filter((message) => message.type === "assistant") ?? []
    const hasOtherProvider = messages.some((message) =>
      message.model?.providerID && message.model.providerID !== providerID,
    )
    const records = child.model?.providerID === providerID && !hasOtherProvider && child.tokens
      ? [child]
      : messages.filter((message) => message.model?.providerID === providerID)
    for (const entry of records) {
      tokens += contextUsed(entry.tokens)
      cost += entry.cost ?? 0
    }
  }
  return { tokens, cost }
}
