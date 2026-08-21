import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, {
  AssembleContext, formatCurrentClock, formatCurrentDate, PromptAssembly,
  renderContextSnapshot, renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'

/**
 * Every assembly carries the plugin's own built-ins — `harness:identity`
 * (order −100), the `harness:clock` date/time fact (order −98), and
 * `deployment:persona` (order 0, from config). Tests about registry MECHANICS
 * strip them with {@link contributed} to stay focused on their own sections;
 * the built-ins' behavior is pinned by its own describe.
 */
const BUILT_IN = ['harness:identity', 'harness:clock', 'deployment:persona']
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
function contributed(assembly: PromptAssembly): PromptAssembly['sections'] {
  return assembly.sections.filter(section => !BUILT_IN.includes(section.name))
}

/** The assembled clock text — dynamic per assembly, so full-prompt assertions splice it in. */
function clockText(assembly: PromptAssembly): string {
  const section = assembly.sections.find(entry => entry.name === 'harness:clock')
  if (section === undefined) throw new Error('harness:clock section missing from assembly')
  return section.text
}

/** Shape of the per-assembly `current_date` prompt variable. */
function expectCurrentDateVariable(value: unknown): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \((Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\)$/)
}

/** Full clock-fact shape: date, weekday, local time, and `UTC±HH:MM` offset. */
const CLOCK_TEXT = /^Today's date is \d{4}-\d{2}-\d{2} \(.+\)\. Current local time is \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)\.$/

describe('SystemPrompt', () => {
  describe('built-in sections', () => {
    it('registers the harness identity and the configured deployment persona', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { persona: 'You are DeepSeek Harness.' })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(s => s.name)).toEqual([
        'harness:identity',
        'harness:clock',
        'deployment:persona',
      ])
      expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\n${clockText(assembly)}\n\nYou are DeepSeek Harness.`)
      // The names are reserved by the plugin — one owner per section.
      expect(() => ctx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: 'imposter' }))
        .toThrow('prompt section "deployment:persona" is already registered')
    })

    it('renders no persona section for a persona-less deployment (empty default)', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      const assembly = await ctx.systemPrompt.assemble()
      expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\n${clockText(assembly)}`)
    })

    it('can omit the harness identity for a deployment that owns the complete persona', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, {
        includeHarnessIdentity: false,
        persona: 'You are a helpful software engineer assistant.',
      })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(section => section.name)).toEqual(['harness:clock', 'deployment:persona'])
      expect(renderPrompt(assembly)).toBe(`${clockText(assembly)}\n\nYou are a helpful software engineer assistant.`)
    })

    it('can suppress runtime context without evaluating providers or accepting waterfall additions', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
      let providerCalls = 0
      ctx.systemPrompt.context({
        name: 'policy',
        order: 0,
        text: () => `policy ${++providerCalls}`,
      })
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        assembly.contexts.push({ name: 'late', text: 'late context' })
        return next()
      })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.contexts).toEqual([])
      expect(providerCalls).toBe(0)
    })

    it('tolerates a schema-bypassing direct construction (persona omitted)', async () => {
      // ctx.plugin validates + defaults the config first; a direct construction
      // skips the schema, so the ctor's `?? ''` narrowing is what fires.
      const ctx = new Context()
      const service = new SystemPrompt(ctx, {})
      const assembly = await service.assemble()
      expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\n${clockText(assembly)}`)
    })

    it('omits the clock section when includeCurrentDate is false, keeping identity and persona', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { includeCurrentDate: false, persona: 'You are DeepSeek Harness.' })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(section => section.name)).toEqual(['harness:identity', 'deployment:persona'])
      expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\nYou are DeepSeek Harness.`)
    })

    it('renders a fresh clock fact by default and exposes it as the {{current_date}} variable', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)

      const first = await ctx.systemPrompt.assemble()
      const second = await ctx.systemPrompt.assemble()
      // Present by default and fresh per assembly.
      expect(clockText(first)).toMatch(CLOCK_TEXT)
      expect(clockText(second)).toMatch(/^Today's date is \d{4}-\d{2}-\d{2} \(.+\)\./)
      expectCurrentDateVariable(first.variables.current_date)

      // Personas can reference the variable exactly like {{model}}/{{cwd}}.
      const personaCtx = new Context()
      await personaCtx.plugin(SystemPrompt, { persona: 'Today is {{current_date}}.' })
      const personaAssembly = await personaCtx.systemPrompt.assemble()
      expectCurrentDateVariable(personaAssembly.variables.current_date)
      expect(renderPrompt(personaAssembly))
        .toBe(`${IDENTITY}\n\n${clockText(personaAssembly)}\n\nToday is ${personaAssembly.variables.current_date}.`)
    })
  })

  describe('clock formatting', () => {
    it('formats a fixed local date with weekday and the UTC offset', () => {
      const fixed = new Date(2026, 7, 20, 22, 53)
      expect(formatCurrentDate(fixed)).toBe('2026-08-20 (Thursday)')
      expect(formatCurrentClock(fixed))
        .toMatch(/^Today's date is 2026-08-20 \(Thursday\)\. Current local time is 22:53 \(UTC[+-]\d{2}:\d{2}\)\.$/)
    })

    it('zero-pads month, day, hour, and minute', () => {
      const fixed = new Date(2026, 0, 5, 9, 7)
      expect(formatCurrentDate(fixed)).toBe('2026-01-05 (Monday)')
      expect(formatCurrentClock(fixed))
        .toMatch(/^Today's date is 2026-01-05 \(Monday\)\. Current local time is 09:07 \(UTC[+-]\d{2}:\d{2}\)\.$/)
    })

    it('defaults to the current instant', () => {
      expect(formatCurrentClock()).toMatch(CLOCK_TEXT)
      expect(formatCurrentDate()).toMatch(/^\d{4}-\d{2}-\d{2} \(.+\)$/)
    })
  })

  it('assembles sections in order with context-resolved text and collected tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: 'You are DeepSeek Harness.' })

    ctx.systemPrompt.section({ name: 'cwd', order: 20, text: () => 'cwd: /tmp' })
    ctx.systemPrompt.section({ name: 'rules', order: 10, text: 'Be precise.' })
    ctx.systemPrompt.context({ name: 'later', order: 20, text: () => 'context 2' })
    ctx.systemPrompt.context({ name: 'earlier', order: 10, text: 'context 1' })
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'echo', description: 'echo back', parameters: {} }] }))

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(s => s.name)).toEqual(['harness:identity', 'harness:clock', 'deployment:persona', 'rules', 'cwd'])
    expect(assembly.sections.map(s => s.text)).toEqual([IDENTITY, clockText(assembly), 'You are DeepSeek Harness.', 'Be precise.', 'cwd: /tmp'])
    expect(assembly.contexts).toEqual([
      { name: 'earlier', text: 'context 1' },
      { name: 'later', text: 'context 2' },
    ])
    expect(assembly.tools).toEqual([{ name: 'echo', description: 'echo back', parameters: {} }])
    expectCurrentDateVariable(assembly.variables.current_date)
    expect(Object.keys(assembly.variables)).toEqual(['current_date'])
    expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\n${clockText(assembly)}\n\nYou are DeepSeek Harness.\n\nBe precise.\n\ncwd: /tmp`)
    expect(renderContextSnapshot(assembly)).toBe('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\ncontext 1\n\ncontext 2')
  })

  it('resolves section text providers against the assemble context, at each assemble call', async () => {
    // The context is HOW per-agent sections work (the loop passes { agent });
    // this spec stays agent-agnostic and smuggles a marker through a plain field.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let calls = 0
    ctx.systemPrompt.section({
      name: 'dynamic',
      order: 0,
      text: (context: AssembleContext) => `call ${++calls} for ${(context as { who?: string }).who ?? 'nobody'}`,
    })

    expect(contributed(await ctx.systemPrompt.assemble({ who: 'alice' } as AssembleContext))[0]!.text).toBe('call 1 for alice')
    expect(contributed(await ctx.systemPrompt.assemble())[0]!.text).toBe('call 2 for nobody')
  })

  it('removes contributions when the contributing fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.section({ name: 'scoped', order: 0, text: 'scoped section' })
      inner.systemPrompt.context({ name: 'scoped-context', order: 0, text: 'scoped context' })
      inner.systemPrompt.tools(() => ({ schemas: [{ name: 'scoped-tool', description: '', parameters: {} }] }))
      inner.systemPrompt.variable('scoped_var', () => 'v')
    }, { inject: ['systemPrompt'] }))

    const before = await ctx.systemPrompt.assemble()
    expect(contributed(before)).toHaveLength(1)
    expect(before.contexts).toHaveLength(1)
    expect(before.variables).toEqual({ scoped_var: 'v', current_date: before.variables.current_date })
    await fiber.dispose()
    const assembly = await ctx.systemPrompt.assemble()
    expect(contributed(assembly)).toHaveLength(0)
    expect(assembly.contexts).toHaveLength(0)
    // The built-ins belong to the service fiber, so they survive the plugin's disposal.
    expect(assembly.sections.map(s => s.name)).toEqual(BUILT_IN)
    expect(assembly.tools).toHaveLength(0)
    expectCurrentDateVariable(assembly.variables.current_date)
    expect(Object.keys(assembly.variables)).toEqual(['current_date'])
  })

  it('rejects a duplicate section name (a double-loaded plugin must fail, not double its text)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'dup', order: 0, text: 'first' })
    expect(() => ctx.systemPrompt.section({ name: 'dup', order: 1, text: 'second' }))
      .toThrow('prompt section "dup" is already registered')
    // The failed registration leaked nothing; the original stays intact.
    const assembly = await ctx.systemPrompt.assemble()
    expect(contributed(assembly).map(s => s.text)).toEqual(['first'])
  })

  it('rejects a non-finite section order', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    expect(() => ctx.systemPrompt.section({ name: 'bad-order', order: Number.NaN, text: 'x' }))
      .toThrow('order must be a finite number')
    expect(contributed(await ctx.systemPrompt.assemble())).toEqual([])
  })

  it('rejects duplicate and non-finite context registrations without leaking', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'first' })
    expect(() => ctx.systemPrompt.context({ name: 'policy', order: 2, text: 'second' }))
      .toThrow('prompt context "policy" is already registered')
    expect(() => ctx.systemPrompt.context({ name: 'bad', order: Number.NaN, text: 'x' }))
      .toThrow('prompt context "bad" order must be a finite number')
    expect((await ctx.systemPrompt.assemble()).contexts).toEqual([{ name: 'policy', text: 'first' }])
  })

  it('rolls back a section when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    // Throw on the first emit only. Note the rollback path itself emits
    // system-prompt/change, so a multi-shot guard would also fire on rollback;
    // a single-shot guard isolates the register's own emit.
    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.section({ name: 'p', order: 0, text: 'persona' })).toThrow('boom change listener')
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(0) // nothing leaked

    // Subsequent listener-free register contributes exactly once.
    off()
    ctx.systemPrompt.section({ name: 'p', order: 0, text: 'persona' })
    expect(contributed(await ctx.systemPrompt.assemble()).map(s => s.name)).toEqual(['p'])
  })

  it('rolls back a tool provider when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: '', parameters: {} }] }))).toThrow('boom change listener')
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0) // nothing leaked

    off()
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: '', parameters: {} }] }))
    expect((await ctx.systemPrompt.assemble()).tools.map(t => t.name)).toEqual(['t'])
  })

  it('snapshots tool-provider membership before evaluating an assembly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let added = false
    ctx.systemPrompt.tools(() => {
      if (!added) {
        added = true
        ctx.systemPrompt.tools(() => ({
          schemas: [{ name: 'late', description: '', parameters: {} }],
        }))
      }
      return { schemas: [{ name: 'first', description: '', parameters: {} }] }
    })

    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['first'])
    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['first', 'late'])
  })

  it('rolls back a variable when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.variable('v', () => 'x')).toThrow('boom change listener')
    const leaked = await ctx.systemPrompt.assemble()
    expectCurrentDateVariable(leaked.variables.current_date)
    expect(Object.keys(leaked.variables)).toEqual(['current_date']) // nothing leaked

    off()
    ctx.systemPrompt.variable('v', () => 'x')
    const after = await ctx.systemPrompt.assemble()
    expect(after.variables).toEqual({ v: 'x', current_date: after.variables.current_date })
  })

  it('composes multiple system-prompt/assemble waterfall listeners in order, with the context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'base', order: 0, text: 'base' })

    // Listener A appends a section, then delegates.
    const contexts: AssembleContext[] = []
    ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, context, next) => {
      contexts.push(context)
      assembly.sections.push({ name: 'from-a', text: 'a' })
      return next()
    })
    // Listener B (registered later, runs after A) sees A's contribution.
    const seen: string[][] = []
    ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, _context, next) => {
      seen.push(assembly.sections.map(s => s.name))
      return next()
    })

    const passed: AssembleContext = {}
    const assembly = await ctx.systemPrompt.assemble(passed)
    expect(seen).toEqual([['harness:identity', 'harness:clock', 'deployment:persona', 'base', 'from-a']])
    expect(assembly.sections.map(s => s.name)).toEqual(['harness:identity', 'harness:clock', 'deployment:persona', 'base', 'from-a'])
    expect(contexts[0]).toBe(passed) // the caller's context reaches listeners
  })

  it('lets a waterfall listener short-circuit by not calling next()', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'real', order: 0, text: 'real' })

    ctx.on('system-prompt/assemble', async () => {
      return { sections: [], contexts: [], tools: [], variables: {} } satisfies PromptAssembly
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections).toHaveLength(0)
  })

  it('restores one complete section after the assembly waterfall', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'complete', order: 10, text: 'Exact prompt.', complete: true })
    ctx.systemPrompt.section({ name: 'extra', order: 20, text: 'extra' })
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const complete = assembly.sections.find(section => section.name === 'complete')
      if (complete === undefined) throw new Error('complete section missing before waterfall')
      complete.text = 'mutated'
      assembly.sections.push({ name: 'late', text: 'late' })
      return next()
    }, { prepend: true })

    expect((await ctx.systemPrompt.assemble()).sections).toEqual([
      { name: 'complete', text: 'Exact prompt.' },
    ])
  })

  it('rejects multiple effective complete sections', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'first', order: 10, text: 'first', complete: true })
    ctx.systemPrompt.section({ name: 'second', order: 20, text: 'second', complete: true })

    await expect(ctx.systemPrompt.assemble())
      .rejects.toThrow('multiple complete prompt sections are active: "first", "second"')
  })

  it('assembles snapshots so one-step mutations do not leak into future assemblies', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'base', order: 0, text: 'base' })
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: 'tool', parameters: { type: 'object', properties: {} } }] }))

    const first = await ctx.systemPrompt.assemble()
    first.sections[0]!.name = 'mutated'
    first.sections[0]!.text = 'mutated'
    first.contexts.push({ name: 'mutated', text: 'mutated' })
    first.tools[0]!.description = 'mutated'
    const firstParameters = first.tools[0]!.parameters as { properties: Record<string, unknown> }
    firstParameters.properties['leak'] = { type: 'string' }

    const second = await ctx.systemPrompt.assemble()
    expect(second.sections.map(section => section.name)).toEqual(['harness:identity', 'harness:clock', 'deployment:persona', 'base'])
    expect(second.sections[0]!.text).toBe(IDENTITY)
    expect(second.contexts).toEqual([])
    expect(second.tools).toEqual([{ name: 't', description: 'tool', parameters: { type: 'object', properties: {} } }])
  })

  it('filters out empty section text from renderPrompt', () => {
    const result = renderPrompt({
      sections: [
        { name: 'empty', text: '' },
        { name: 'real', text: 'content' },
      ],
      contexts: [],
      tools: [],
      variables: {},
    })
    expect(result).toBe('content')
  })

  it('filters empty context, interpolates variables, and returns empty without active context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.context({ name: 'empty', order: 0, text: '' })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).toBe('')
    ctx.systemPrompt.variable('mode', () => 'read-only')
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'Mode: {{mode}}.' })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble()))
      .toBe('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nMode: read-only.')
  })

  it('attributes context interpolation failures to the contributing context', () => {
    expect(() => renderContextSnapshot({
      sections: [],
      contexts: [{ name: 'policy', text: 'Mode: {{missing}}.' }],
      tools: [],
      variables: {},
    })).toThrow('unknown prompt variable "{{missing}}" in context "policy"; registered variables: (none)')
  })

  it('emits system-prompt/change when a tool provider is registered and disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let changeCount = 0
    ctx.on('system-prompt/change', () => void changeCount++)

    const dispose = ctx.systemPrompt.tools(() => ({ schemas: [] }))
    // registration emits change
    expect(changeCount).toBe(1)

    dispose()
    // disposal emits change again
    expect(changeCount).toBe(2)
  })

  it('emits system-prompt/change when a context is registered and disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let changeCount = 0
    ctx.on('system-prompt/change', () => void changeCount++)
    const dispose = ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'current' })
    expect(changeCount).toBe(1)
    dispose()
    expect(changeCount).toBe(2)
  })

  it('cleans up tool providers on fiber dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.tools(() => ({ schemas: [{ name: 'fiber-tool', description: '', parameters: {} }] }))
    }, { inject: ['systemPrompt'] }))

    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(1)
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0)
  })

  it('removes section when returned disposer is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const dispose = ctx.systemPrompt.section({ name: 'direct', order: 0, text: 'direct section' })
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(1)

    dispose()
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(0)
  })

  it('removes tool provider when returned disposer is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const dispose = ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'direct-tool', description: '', parameters: {} }] }))
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(1)

    dispose()
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0)
  })

  describe('prompt variables', () => {
    it('resolves each variable against the assemble context and emits change on register/unregister', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      let changeCount = 0
      ctx.on('system-prompt/change', () => void changeCount++)

      const dispose = ctx.systemPrompt.variable('who', context => (context as { who?: string }).who)
      expect(changeCount).toBe(1)

      const withWho = await ctx.systemPrompt.assemble({ who: 'alice' } as AssembleContext)
      expect(withWho.variables).toEqual({ who: 'alice', current_date: withWho.variables.current_date })
      // A provider returning undefined records "registered but no value here".
      const withUndef = await ctx.systemPrompt.assemble()
      expect(withUndef.variables).toEqual({ who: undefined, current_date: withUndef.variables.current_date })

      dispose()
      expect(changeCount).toBe(2)
      const disposed = await ctx.systemPrompt.assemble()
      expectCurrentDateVariable(disposed.variables.current_date)
      expect(Object.keys(disposed.variables)).toEqual(['current_date'])
    })

    it('live-iterates variables registered by an earlier provider', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      let added = false
      ctx.systemPrompt.variable('first', () => {
        if (!added) {
          added = true
          ctx.systemPrompt.variable('late', () => 'second value')
        }
        return 'first value'
      })

      const live = await ctx.systemPrompt.assemble()
      expect(live.variables).toEqual({
        first: 'first value',
        late: 'second value',
        current_date: live.variables.current_date,
      })
    })

    it('rejects a duplicate variable name and an unreferenceable name', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.variable('model', () => 'm1')
      expect(() => ctx.systemPrompt.variable('model', () => 'm2'))
        .toThrow('prompt variable "model" is already registered')
      expect(() => ctx.systemPrompt.variable('Not Valid', () => 'x'))
        .toThrow('invalid prompt variable name "Not Valid"')
      // Neither failed registration leaked.
      const leaked = await ctx.systemPrompt.assemble()
      expect(leaked.variables).toEqual({ model: 'm1', current_date: leaked.variables.current_date })
    })

    it('interpolates {{name}} references in section text at render — the persona included', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { persona: 'You run on {{model}} in {{cwd}}.' })
      ctx.systemPrompt.variable('model', () => 'deepseek-v4')
      ctx.systemPrompt.variable('cwd', () => '/work')

      const interpolated = await ctx.systemPrompt.assemble()
      expect(renderPrompt(interpolated)).toBe(`${IDENTITY}\n\n${clockText(interpolated)}\n\nYou run on deepseek-v4 in /work.`)
    })

    it('lets a waterfall listener add or override variables before render', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 's', order: 0, text: '{{extra}}' })
      ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, _context, next) => {
        assembly.variables['extra'] = 'from-waterfall'
        return next()
      })
      const waterfall = await ctx.systemPrompt.assemble()
      expect(renderPrompt(waterfall)).toBe(`${IDENTITY}\n\n${clockText(waterfall)}\n\nfrom-waterfall`)
    })

    it('throws on a reference to an unregistered variable, listing what exists', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 'persona', order: 0, text: 'on {{modle}}' })
      ctx.systemPrompt.variable('model', () => 'm')
      await expect(async () => renderPrompt(await ctx.systemPrompt.assemble()))
        .rejects.toThrow('unknown prompt variable "{{modle}}" in section "persona"; registered variables: current_date, model')
    })

    it('names "(none)" when no variables are registered at all', () => {
      expect(() => renderPrompt({ sections: [{ name: 's', text: '{{x}}' }], contexts: [], tools: [], variables: {} }))
        .toThrow('unknown prompt variable "{{x}}" in section "s"; registered variables: (none)')
    })

    it('throws when a referenced variable has no value for this assembly', () => {
      expect(() => renderPrompt({
        sections: [{ name: 'persona', text: 'in {{cwd}}' }],
        contexts: [],
        tools: [],
        variables: { cwd: undefined },
      })).toThrow('prompt variable "{{cwd}}" has no value for this assembly (section "persona")')
    })

    it('throws on a malformed complete reference, e.g. inner spaces', () => {
      expect(() => renderPrompt({
        sections: [{ name: 's', text: 'on {{ model }}' }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('malformed prompt variable reference "{{ model }}" in section "s"')
    })

    it('leaves a lone {{ verbatim only when NO }} follows anywhere after it', () => {
      const text = renderPrompt({
        sections: [{ name: 's', text: 'shell ${X:-{{fallback} stays' }],
        contexts: [],
        tools: [],
        variables: {},
      })
      expect(text).toBe('shell ${X:-{{fallback} stays')
    })

    it.each([
      { text: '{{{model}}}', label: 'extra outer braces' },
      { text: 'x {{a{b}} y {{model}}', label: 'nested brace inside a would-be group' },
    ])('throws on a mangled reference with a }} still following ($label)', ({ text }) => {
      expect(() => renderPrompt({
        sections: [{ name: 's', text }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('malformed prompt variable reference at')
    })

    it('rejects {{constructor}} as UNKNOWN — prototype properties are not variables', () => {
      // `in` would find Object.prototype.constructor and splice function
      // source into the prompt; Object.hasOwn must reject it instead.
      expect(() => renderPrompt({
        sections: [{ name: 's', text: 'on {{constructor}}' }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('unknown prompt variable "{{constructor}}"')
    })

    it('a variable NAMED like a prototype property works once actually registered', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 's', order: 0, text: '{{constructor}}' })
      ctx.systemPrompt.variable('constructor', () => 'own-value')
      const protoNamed = await ctx.systemPrompt.assemble()
      expect(renderPrompt(protoNamed)).toBe(`${IDENTITY}\n\n${clockText(protoNamed)}\n\nown-value`)
    })

    it('never re-scans substituted values (a value containing {{sneaky}} stays literal)', () => {
      const text = renderPrompt({
        sections: [{ name: 's', text: 'v = {{model}}!' }],
        contexts: [],
        tools: [],
        variables: { model: 'literal {{sneaky}} inside' },
      })
      expect(text).toBe('v = literal {{sneaky}} inside!')
    })
  })
})
