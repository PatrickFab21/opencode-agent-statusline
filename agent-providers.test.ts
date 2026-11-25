import assert from "node:assert/strict"
import { test } from "node:test"
import { collectAgentProviders, cycleProvider, recordedAgentUsage } from "./agent-providers.ts"

test("groups subagents and excludes the root session", () => {
  const family = [
    { id: "root", model: { providerID: "openai" } },
    { id: "c1", model: { providerID: "google" } },
    { id: "c2", model: { providerID: "google" } },
    { id: "c3", model: { providerID: "claude-agent" } },
  ]
  const providers = collectAgentProviders("root", family)
  assert.deepEqual(providers, ["claude-agent", "google"])
  assert.equal(cycleProvider(providers, "google", 1), "claude-agent")
  assert.equal(cycleProvider(providers, "claude-agent", -1), "google")
  assert.equal(cycleProvider([], undefined, 1), undefined)
})

test("uses recorded messages to separate usage in a mixed-provider subagent", () => {
  const google = { providerID: "google" }
  const openai = { providerID: "openai" }
  const family = [{
    id: "child",
    model: google,
    tokens: { input: 210 },
    cost: 0.012,
    messages: [
      { type: "assistant", model: google, tokens: { input: 100, output: 3 }, cost: 0.002 },
      { type: "assistant", model: openai, tokens: { input: 107 }, cost: 0.01 },
    ],
  }]
  assert.deepEqual(recordedAgentUsage("root", family, "google"), { tokens: 103, cost: 0.002 })
  assert.deepEqual(collectAgentProviders("root", family), ["google", "openai"])
})
