import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Analysis, AnalysisTarget, ChangeGroup, FileChange } from '../types'
import {
  GROUPING_SYSTEM_PROMPT,
  buildGroupingPrompt,
  groupByDirectory,
  parseCommandTarget,
  parseGroupingReply,
  parseUnifiedDiff,
  sumStats,
} from './grouping'
import { readBranchDiff, readBranchInfo, readPullRequestDiff } from './sources'
import type { DiffSource } from './sources'

const PANE_ID = 'group-changes'
const PANE_TITLE = 'Change groups'
const SIDEBAR_COLUMNS = 60
const GROUPING_MODEL = 'sonnet'

const analysisAtom = atom({ plugin: 'group-changes', key: 'analysis' } as const, null, { shape: 'v1' })
const branchInfoAtom = atom({ plugin: 'group-changes', key: 'branchInfo' } as const, null, { shape: 'v1' })
const viewAtom = atom({ plugin: 'group-changes', key: 'view' } as const, { expanded: [0], selectedPath: null }, { shape: 'v1' })

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatStats(files: readonly FileChange[]): string {
  const { additions, deletions } = sumStats(files)
  return `+${additions} −${deletions}`
}

async function groupFiles($: EngineInterface, label: string, files: readonly FileChange[]) {
  const reply = await $.model.complete({
    model: GROUPING_MODEL,
    system: GROUPING_SYSTEM_PROMPT,
    prompt: buildGroupingPrompt(label, files),
    maxTokens: 4000,
    timeoutMs: 120000,
  })
  if (!reply.isAnswered) {
    return { groups: groupByDirectory(files), note: `Grouped by folder: the model gave no answer (${reply.reason}).` }
  }
  try {
    return { groups: parseGroupingReply(reply.text, files), note: null }
  } catch (error) {
    return { groups: groupByDirectory(files), note: `Grouped by folder: ${describeError(error)}.` }
  }
}

async function settleRun($: EngineInterface, runId: string, patch: Partial<Analysis>) {
  await update($, analysisAtom, current => (current?.runId === runId ? { ...current, ...patch } : current))
}

function readSource($: EngineInterface, target: AnalysisTarget): Promise<DiffSource> {
  return target.kind === 'pr' ? readPullRequestDiff($, target.selector) : readBranchDiff($)
}

async function startRun($: EngineInterface, target: AnalysisTarget): Promise<string> {
  const runId = `${await $.clock.now()}-${Math.random()}`
  const empty = { status: 'loading', label: 'Reading changes…', detail: '', note: null, error: null, files: [], groups: [] } as const
  await update($, analysisAtom, () => ({ ...empty, runId, target, files: [], groups: [] }))
  await update($, viewAtom, () => ({ expanded: [0], selectedPath: null }))
  return runId
}

async function analyze($: EngineInterface, target: AnalysisTarget) {
  const runId = await startRun($, target)
  try {
    const source = await readSource($, target)
    const files = parseUnifiedDiff(source.diff)
    await settleRun($, runId, { label: source.label, detail: source.detail, files })
    if (files.length === 0) return settleRun($, runId, { status: 'ready', note: 'No changes to group.' })
    const { groups, note } = await groupFiles($, source.label, files)
    await settleRun($, runId, { status: 'ready', groups, note })
  } catch (error) {
    await settleRun($, runId, { status: 'error', error: describeError(error) })
  }
}

function logFailure($: EngineInterface, error: unknown) {
  $.ui.log(`group-changes: ${describeError(error)}`, { to: 'debug' })
}

function startAnalysis($: EngineInterface, target: AnalysisTarget) {
  void analyze($, target).catch(error => logFailure($, error))
}

function refreshBranchInfo($: EngineInterface) {
  const refresh = async () => {
    const info = await readBranchInfo($).catch(() => null)
    await update($, branchInfoAtom, () => info)
  }
  void refresh().catch(error => logFailure($, error))
}

async function togglePane($: EngineInterface) {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE_ID)
  if (isOpen) return $.ui.close({ id: PANE_ID })
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: SIDEBAR_COLUMNS })
  if ((await read($, analysisAtom)) === null) startAnalysis($, { kind: 'branch' })
}

async function rerun($: EngineInterface) {
  const analysis = await read($, analysisAtom)
  await analyze($, analysis?.target ?? { kind: 'branch' })
}

async function toggleGroup($: EngineInterface, groupIndex: number) {
  await update($, viewAtom, view => ({
    ...view,
    expanded: view.expanded.includes(groupIndex)
      ? view.expanded.filter(index => index !== groupIndex)
      : [...view.expanded, groupIndex],
  }))
}

async function toggleFile($: EngineInterface, path: string) {
  await update($, viewAtom, view => ({ ...view, selectedPath: view.selectedPath === path ? null : path }))
}

async function runCommand($: EngineInterface, args: string) {
  const target = parseCommandTarget(args)
  if (target.kind === 'hide') {
    await $.ui.close({ id: PANE_ID })
    return { text: 'Change groups pane closed.' }
  }
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: SIDEBAR_COLUMNS })
  startAnalysis($, target)
  const subject = target.kind === 'pr' ? `PR ${target.selector}` : 'the current branch'
  return { text: `Grouping the changes of ${subject} in the Change groups pane.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'group-changes',
      description: "Group this branch's (or a PR's) changes into logical review groups",
      argumentHint: '[pr-number | pr-url | hide]',
    })
    refreshBranchInfo($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    refreshBranchInfo($)
    return next(e)
  })

  on('command.run', { command: 'group-changes' }, ($, e) => runCommand($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const info = await read($, branchInfoAtom)
    const analysis = await read($, analysisAtom)
    const hasSubject = analysis !== null || (info?.isFeatureBranch === true && info.hasChanges)
    if (e.props.hasSurvey || !hasSubject) return next(e)
    const { Button } = $.ui.resolve(e)
    const count = analysis?.status === 'ready' ? ` (${analysis.groups.length})` : ''
    return <Button key="toggle" plain dimColor label={`⊞ change groups${count}`} onPress={() => togglePane($)} />
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const analysis = await read($, analysisAtom)
    const view = await read($, viewAtom)
    const width = Math.max(20, e.props.bodyColumns)

    if (analysis === null) {
      return <Text dimColor>No changes grouped yet. Run /group-changes.</Text>
    }

    const filesByPath = new Map(analysis.files.map(file => [file.path, file]))

    const renderFile = (path: string, groupIndex: number, fileIndex: number) => {
      const file = filesByPath.get(path)
      const isSelected = view.selectedPath === path
      return (
        <Box key={`file-box-${groupIndex}-${fileIndex}`} flexDirection="column">
          <Button key={`file-${groupIndex}-${fileIndex}`} plain dimColor={!isSelected} onPress={() => toggleFile($, path)}>
            {isSelected ? '▾ ' : '  '}
            {path} <Text dimColor>{file ? formatStats([file]) : ''}</Text>
          </Button>
          {isSelected && file && file.hunks !== '' && <Code source={file.hunks} format="diff" path={path} />}
          {isSelected && file && file.hunks === '' && <Text dimColor>  binary or mode-only change</Text>}
        </Box>
      )
    }

    const renderGroup = (group: ChangeGroup, groupIndex: number) => {
      const isExpanded = view.expanded.includes(groupIndex)
      const groupFiles = group.files.flatMap(path => filesByPath.get(path) ?? [])
      return (
        <Box key={`group-box-${groupIndex}`} flexDirection="column" marginTop={1}>
          <Button key={`group-${groupIndex}`} plain onPress={() => toggleGroup($, groupIndex)}>
            {isExpanded ? '▾ ' : '▸ '}
            <Text bold>{group.title}</Text>{' '}
            <Text dimColor>
              {group.files.length} files · {formatStats(groupFiles)}
            </Text>
          </Button>
          {isExpanded && (
            <Box flexDirection="column" paddingLeft={2}>
              {group.summary !== '' && <Text dimColor wrap="wrap">{group.summary}</Text>}
              {group.files.map((path, fileIndex) => renderFile(path, groupIndex, fileIndex))}
            </Box>
          )}
        </Box>
      )
    }

    const status =
      analysis.status === 'loading' ? (
        <Text dimColor>{analysis.files.length > 0 ? 'Grouping changes…' : 'Reading changes…'}</Text>
      ) : analysis.status === 'error' ? (
        <Text color="error" wrap="wrap">{analysis.error ?? 'Failed.'}</Text>
      ) : null

    return (
      <Box flexDirection="column" width={width}>
        <Text bold wrap="truncate-end">{analysis.label}</Text>
        {analysis.detail !== '' && <Text dimColor wrap="truncate-end">{analysis.detail}</Text>}
        {analysis.files.length > 0 && <Text dimColor>{analysis.files.length} files · {formatStats(analysis.files)}</Text>}
        {analysis.note !== null && <Text color="warning" wrap="wrap">{analysis.note}</Text>}
        <Box gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => rerun($)} />
          <Button key="close" label="Close" hotkey="c" onPress={() => $.ui.close({ id: PANE_ID })} />
        </Box>
        {status}
        {analysis.status === 'ready' && analysis.groups.map(renderGroup)}
      </Box>
    )
  })
}
