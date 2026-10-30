import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Analysis, BranchInfo } from '../types'
import {
  groupByDirectory,
  normalizeGroups,
  parseCommandTarget,
  parseGroupingReply,
  parseUnifiedDiff,
} from '../hooks/grouping'

const SAMPLE_DIFF = [
  'diff --git a/src/api/users.ts b/src/api/users.ts',
  'index 111..222 100644',
  '--- a/src/api/users.ts',
  '+++ b/src/api/users.ts',
  '@@ -1,2 +1,3 @@',
  ' export const users = []',
  '-export const old = 1',
  '+export const fresh = 2',
  '+export const extra = 3',
  'diff --git a/tests/users.test.ts b/tests/users.test.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/tests/users.test.ts',
  '@@ -0,0 +1 @@',
  '+test("users", () => {})',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
].join('\n')

const ANALYSIS: Analysis = {
  runId: 'run-1',
  target: { kind: 'branch' },
  status: 'ready',
  label: 'feature-x → main',
  detail: 'commits since the fork point plus uncommitted tracked changes',
  note: null,
  error: null,
  files: parseUnifiedDiff(SAMPLE_DIFF),
  groups: [
    { title: 'Users API', summary: 'Adds fresh exports.', files: ['src/api/users.ts', 'tests/users.test.ts'] },
    { title: 'Assets', summary: 'Updates the logo.', files: ['logo.png'] },
  ],
}

const PANE = {
  plugin: 'group-changes',
  component: 'Pane',
  requestId: 'group-changes',
  props: {
    title: 'Change groups',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'group-changes',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('parses a unified diff into files with stats and hunks', async () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF)
  expect(files.map(file => file.path)).toEqual(['src/api/users.ts', 'tests/users.test.ts', 'logo.png'])
  expect(files[0]?.additions).toBe(2)
  expect(files[0]?.deletions).toBe(1)
  expect(files[0]?.hunks.startsWith('@@ -1,2 +1,3 @@')).toBe(true)
  expect(files[2]?.hunks).toBe('')
})

test('places every file exactly once and drops unknown paths', async () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF)
  const reply = '```json\n{"groups":[{"title":"API","summary":"s","files":["src/api/users.ts","nope.ts","src/api/users.ts"]}]}\n```'
  const groups = parseGroupingReply(reply, files)
  expect(groups).toEqual([
    { title: 'API', summary: 's', files: ['src/api/users.ts'] },
    { title: 'Other changes', summary: 'Files the grouping did not place.', files: ['tests/users.test.ts', 'logo.png'] },
  ])
  expect(normalizeGroups([{ title: 'Empty', files: [] }], [])).toEqual([])
})

test('rejects a reply that is not JSON, and falls back to folders', async () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF)
  expect(() => parseGroupingReply('Here are the groups!', files)).toThrow()
  expect(groupByDirectory(files).map(group => group.title)).toEqual(['src', 'tests', '(root)'])
})

test('reads the command target from its arguments', async () => {
  expect(parseCommandTarget('')).toEqual({ kind: 'branch' })
  expect(parseCommandTarget(' hide ')).toEqual({ kind: 'hide' })
  expect(parseCommandTarget('#42')).toEqual({ kind: 'pr', selector: '42' })
  expect(parseCommandTarget('https://github.com/o/r/pull/77/files')).toEqual({ kind: 'pr', selector: '77' })
  expect(parseCommandTarget('some-branch')).toEqual({ kind: 'pr', selector: 'some-branch' })
})

function seedState(on: On, analysis: Analysis | null, branchInfo: BranchInfo | null) {
  const seeded: Record<string, unknown> = { analysis, branchInfo }
  on('state.get', ($, e, next) => {
    if (e.plugin !== 'group-changes' || !(e.key in seeded)) return next(e)
    return { value: { value: { shape: 'v1', value: seeded[e.key] }, version: 1 } }
  })
  on('state.set', ($, e, next) => {
    if (e.plugin === 'group-changes') delete seeded[e.key]
    return next(e)
  })
}

test('the pane draws the groups, first one expanded, on terminal and desktop', async ($, on) => {
  seedState(on, ANALYSIS, null)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'group-0' }))?.text).toContain('Users API')
    expect((await ui.find({ key: 'group-1' }))?.text).toContain('Assets')
    expect((await ui.find({ key: 'file-0-0' }))?.text).toContain('src/api/users.ts')
    expect(await ui.find({ key: 'file-1-0' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the band stays out of the way without a feature branch or analysis', async ($, on) => {
  seedState(on, null, { branch: 'main', base: 'main', isFeatureBranch: false, hasChanges: false })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  await ui.unmount()
})

test('the band shows the toggle on a feature branch with changes', async ($, on) => {
  seedState(on, null, { branch: 'feature-x', base: 'main', isFeatureBranch: true, hasChanges: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'toggle' }))?.text).toContain('change groups')
  await ui.unmount()
})

const GIT_ANSWERS: Record<string, string> = {
  'git rev-parse --abbrev-ref HEAD': 'feature-x',
  'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
  'git rev-parse --verify --quiet origin/main^{commit}': 'abc',
  'git merge-base HEAD origin/main': 'abc',
  'git diff --no-color --no-ext-diff abc': SAMPLE_DIFF,
}

test('/group-changes groups the current branch with the model', async ($, on) => {
  on('command.register', () => ({ value: { command: 'group-changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on)
  on('process.run', (_, e) => {
    const stdout = GIT_ANSWERS[e.argv.join(' ')]
    return { value: { exitCode: stdout === undefined ? 1 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '{"groups":[{"title":"Users API","summary":"s","files":["src/api/users.ts","tests/users.test.ts"]}]}',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await $.command.run({
    command: 'group-changes',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(result.text).toContain('current branch')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const group = await ui.find({ key: 'group-1' })
    await ui.unmount()
    if (group) {
      expect(group.text).toContain('Other changes')
      return
    }
  }
  throw new Error('the analysis never became ready')
})

test('Close and Refresh in the pane reach the engine', async ($, on) => {
  seedState(on, ANALYSIS, null)
  const closed: string[] = []
  const commands: string[] = []
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    commands.push(e.argv.join(' '))
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  mock.clock(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'close' })
  expect(closed).toEqual(['group-changes'])
  await ui.press({ key: 'refresh' })
  expect(commands).toContain('git rev-parse --abbrev-ref HEAD')
  await ui.unmount()
})
