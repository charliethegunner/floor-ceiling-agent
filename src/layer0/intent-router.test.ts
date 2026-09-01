import { describe, test, expect } from 'vitest'
import { classifyIntent, computeHeuristicSignal, type IntentRouterOptions } from './intent-router'
import type { LlmClient } from '../CeilingAgent'

class ScriptedLlmClient implements LlmClient {
  lastPrompt = ''
  callCount = 0
  constructor(private readonly response: string) {}
  async complete(prompt: string): Promise<string> {
    this.lastPrompt = prompt
    this.callCount++
    return this.response
  }
}

function llmJson(kind: string, description: string, confidence: 'high' | 'low'): string {
  return JSON.stringify({ kind, description, confidence })
}

const NEVER_CALLED_CONFIRM = async (): Promise<boolean> => {
  throw new Error('confirm should not have been called in this mode')
}

// ---------------------------------------------------------------------------
// computeHeuristicSignal (Phase 13.4.1): pure, LLM-free, tested in isolation.
// ---------------------------------------------------------------------------

describe('computeHeuristicSignal: pure pattern scoring, no LLM involved', () => {
  test('a real instruction-shaped request is a clear winner for "instruction"', () => {
    const signal = computeHeuristicSignal('MOV RAX, RBX')
    expect(signal.winner).toBe('instruction')
  })

  test('a real patch-shaped request is a clear winner for "patch"', () => {
    const signal = computeHeuristicSignal('Write a TypeScript function that returns a number')
    expect(signal.winner).toBe('patch')
  })

  test('a real topology-shaped request is a clear winner for "topology"', () => {
    const signal = computeHeuristicSignal('Propose a module that exports a function and imports from another module, checking reachability')
    expect(signal.winner).toBe('topology')
  })

  test('a real claim-shaped request is a clear winner for "claim"', () => {
    const signal = computeHeuristicSignal('Claim that translateInstruction should return the correct value - verify that this assertion holds')
    expect(signal.winner).toBe('claim')
  })

  test('a real spatial-shaped request is a clear winner for "spatial"', () => {
    const signal = computeHeuristicSignal('Propose a sphere and a torus combined with a union operation, following SDF/CSG conventions within a bounding box')
    expect(signal.winner).toBe('spatial')
  })

  test('ordinary English containing common-word "opcodes" (OR, AND, CALL) does NOT false-positive as instruction', () => {
    // The real false-positive risk this heuristic has to guard against:
    // OR/AND/CALL are common English words, not just x86 mnemonics.
    const signal = computeHeuristicSignal('You can call the function and or return a value')
    expect(signal.winner).not.toBe('instruction')
  })

  test('a genuinely vague request with no domain vocabulary has no clear winner', () => {
    const signal = computeHeuristicSignal('Build something for the bracket connecting two beams without them touching')
    expect(signal.winner).toBeNull()
    expect(Object.values(signal.scores).every((s) => s === 0)).toBe(true)
  })

  test('a tie between two domains has no clear winner', () => {
    // "module" (topology) and "claim" (claim) each score exactly 1 - a tie,
    // not a winner, even though every score is nonzero.
    const signal = computeHeuristicSignal('a module and a claim')
    expect(signal.winner).toBeNull()
    expect(signal.scores.topology).toBe(signal.scores.claim)
  })
})

// ---------------------------------------------------------------------------
// classifyIntent: agreement, disagreement, and honest failure to classify.
// ---------------------------------------------------------------------------

describe('classifyIntent: two-signal agreement classifies correctly', () => {
  test('heuristic and LLM agreeing on "instruction" produces a well-formed CeilingRequest', async () => {
    const llm = new ScriptedLlmClient(llmJson('instruction', 'MOV RAX, RBX', 'high'))
    const result = await classifyIntent('MOV RAX, RBX', llm)

    expect(result.ok).toBe(true)
    expect(result.ok && result.request).toEqual({ kind: 'instruction', description: 'MOV RAX, RBX' })
  })

  test('heuristic and LLM agreeing on "spatial" produces the LLM-normalized description', async () => {
    const raw = 'Propose a sphere and a torus combined with a union operation, following SDF/CSG conventions within a bounding box'
    const normalized = 'A surface combining a sphere and a torus via a union operation, within a declared bounding box.'
    const llm = new ScriptedLlmClient(llmJson('spatial', normalized, 'high'))
    const result = await classifyIntent(raw, llm)

    expect(result.ok).toBe(true)
    expect(result.ok && result.request).toEqual({ kind: 'spatial', description: normalized })
  })

  test('the LLM receives the real raw request text in its prompt', async () => {
    const llm = new ScriptedLlmClient(llmJson('claim', 'x', 'high'))
    await classifyIntent('Claim that X should return Y - verify that this assertion holds', llm)
    expect(llm.lastPrompt).toContain('Claim that X should return Y - verify that this assertion holds')
    expect(llm.lastPrompt).toContain('"patch"') // the prompt documents all five domains, including the one the earlier design omitted
  })

  test('a fenced JSON response from the LLM is tolerated (Phase 5.1 parity, via the shared stripJsonFences)', async () => {
    const llm = new ScriptedLlmClient('```json\n' + llmJson('topology', 'a module description', 'high') + '\n```')
    const result = await classifyIntent('a module that exports and imports, checking reachability', llm)
    expect(result.ok).toBe(true)
    expect(result.ok && result.request.kind).toBe('topology')
  })
})

describe('classifyIntent: disagreement and unparseable responses are honest failures, never a guess', () => {
  test('heuristic and LLM disagreeing on a clear heuristic winner is reported as ambiguous, not silently resolved', async () => {
    const llm = new ScriptedLlmClient(llmJson('claim', 'reworded as a claim', 'high'))
    const result = await classifyIntent('Propose a module that exports a function and imports from another module, checking reachability', llm)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('ambiguous')
    expect(result.ok === false && result.reason === 'ambiguous' && result.candidates).toEqual(expect.arrayContaining(['topology', 'claim']))
  })

  test('a heuristically ambiguous request with a HIGH-confidence LLM signal is trusted and proceeds', async () => {
    const llm = new ScriptedLlmClient(llmJson('spatial', 'a normalized spatial description', 'high'))
    const result = await classifyIntent('Build something for the bracket connecting two beams without them touching', llm)

    expect(result.ok).toBe(true)
    expect(result.ok && result.request.kind).toBe('spatial')
  })

  test('a heuristically ambiguous request with a LOW-confidence LLM signal is NOT trusted - reported ambiguous', async () => {
    const llm = new ScriptedLlmClient(llmJson('spatial', 'a normalized spatial description', 'low'))
    const result = await classifyIntent('Build something for the bracket connecting two beams without them touching', llm)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('ambiguous')
  })

  test('a malformed (non-JSON) LLM response is reported ambiguous, never fuzzy-parsed or guessed', async () => {
    const llm = new ScriptedLlmClient('I think this is probably a spatial request, roughly.')
    const result = await classifyIntent('MOV RAX, RBX', llm)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('ambiguous')
    expect(result.ok === false && result.reason === 'ambiguous' && result.clarifyingQuestion).toContain('could not be parsed')
  })

  test('the clarifying question is a single string, never a rendered options structure', async () => {
    const llm = new ScriptedLlmClient('not json')
    const result = await classifyIntent('an ambiguous request', llm)
    expect(result.ok === false && result.reason === 'ambiguous' && typeof result.clarifyingQuestion).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Phase 13.4.4: ExecutionMode threading - the SAME type ActionExecutor
// already exports, no parallel "AutonomyMode" enum.
// ---------------------------------------------------------------------------

describe('classifyIntent: autonomy mode (Phase 13.4.4) reuses action-floor.ts\'s ExecutionMode', () => {
  test('default (no executionMode) behaves as "auto" - proceeds without ever calling confirm', async () => {
    const llm = new ScriptedLlmClient(llmJson('instruction', 'MOV RAX, RBX', 'high'))
    const result = await classifyIntent('MOV RAX, RBX', llm, { confirm: NEVER_CALLED_CONFIRM })
    expect(result.ok).toBe(true)
  })

  test('"auto" explicitly set behaves the same as the default', async () => {
    const llm = new ScriptedLlmClient(llmJson('instruction', 'MOV RAX, RBX', 'high'))
    const options: IntentRouterOptions = { executionMode: 'auto', confirm: NEVER_CALLED_CONFIRM }
    const result = await classifyIntent('MOV RAX, RBX', llm, options)
    expect(result.ok).toBe(true)
  })

  test('"auto-commit" also proceeds without confirmation at this checkpoint', async () => {
    const llm = new ScriptedLlmClient(llmJson('instruction', 'MOV RAX, RBX', 'high'))
    const result = await classifyIntent('MOV RAX, RBX', llm, { executionMode: 'auto-commit', confirm: NEVER_CALLED_CONFIRM })
    expect(result.ok).toBe(true)
  })

  test('"interactive" asks for confirmation, and proceeds when approved', async () => {
    const llm = new ScriptedLlmClient(llmJson('instruction', 'MOV RAX, RBX', 'high'))
    let seenMessage = ''
    const result = await classifyIntent('MOV RAX, RBX', llm, {
      executionMode: 'interactive',
      confirm: async (message) => {
        seenMessage = message
        return true
      },
    })

    expect(result.ok).toBe(true)
    expect(seenMessage).toContain('instruction')
    expect(seenMessage).toContain('MOV RAX, RBX')
  })

  test('"interactive" with a declining confirm reports a "declined" outcome carrying the classified request', async () => {
    const llm = new ScriptedLlmClient(llmJson('instruction', 'MOV RAX, RBX', 'high'))
    const result = await classifyIntent('MOV RAX, RBX', llm, { executionMode: 'interactive', confirm: async () => false })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('declined')
    expect(result.ok === false && result.reason === 'declined' && result.request).toEqual({ kind: 'instruction', description: 'MOV RAX, RBX' })
  })

  test('"dry-run" is deliberately treated the same as "interactive" at this checkpoint (documented design decision, not an oversight)', async () => {
    const llm = new ScriptedLlmClient(llmJson('instruction', 'MOV RAX, RBX', 'high'))

    const declined = await classifyIntent('MOV RAX, RBX', llm, { executionMode: 'dry-run', confirm: async () => false })
    expect(declined.ok).toBe(false)
    expect(declined.ok === false && declined.reason).toBe('declined')

    const approved = await classifyIntent('MOV RAX, RBX', llm, { executionMode: 'dry-run', confirm: async () => true })
    expect(approved.ok).toBe(true)
  })

  test('an ambiguous classification is reported before autonomy mode is ever consulted - confirm is never called', async () => {
    const llm = new ScriptedLlmClient('not json')
    const result = await classifyIntent('an ambiguous request', llm, { executionMode: 'interactive', confirm: NEVER_CALLED_CONFIRM })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('ambiguous')
  })
})
