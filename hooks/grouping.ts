import type { AnalysisTarget, ChangeGroup, FileChange } from '../types'

export type CommandTarget = AnalysisTarget | { kind: 'hide' }

export class GroupingReplyError extends Error {}

const MAX_STORED_HUNK_LINES = 300
const MAX_PROMPT_PATCH_CHARS = 1500
const MAX_PROMPT_CHARS = 60000
const OTHER_GROUP_TITLE = 'Other changes'

export function parseCommandTarget(args: string): CommandTarget {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'branch' }
  if (/^(hide|close)$/i.test(trimmed)) return { kind: 'hide' }
  const prUrl = trimmed.match(/\/pull\/(\d+)/)
  if (prUrl?.[1]) return { kind: 'pr', selector: prUrl[1] }
  const prNumber = trimmed.match(/^#?(\d+)$/)
  return { kind: 'pr', selector: prNumber?.[1] ?? trimmed }
}

function pathFromHeader(header: string): string {
  const match = header.match(/^diff --git a\/(.+) b\/(.+)$/)
  return match?.[2] ?? header.slice('diff --git '.length)
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n')
}

type FileDraft = { path: string; additions: number; deletions: number; hunkLines: string[]; isInHunk: boolean }

function readDiffLine(draft: FileDraft, line: string): void {
  if (line.startsWith('+++ b/') && !draft.isInHunk) draft.path = line.slice(6)
  if (line.startsWith('@@')) draft.isInHunk = true
  if (!draft.isInHunk) return
  draft.hunkLines.push(line)
  if (line.startsWith('+')) draft.additions += 1
  if (line.startsWith('-')) draft.deletions += 1
}

function finishDraft(draft: FileDraft): FileChange {
  const hunks = draft.hunkLines.join('\n').replace(/\n+$/, '')
  return {
    path: draft.path,
    additions: draft.additions,
    deletions: draft.deletions,
    hunks: truncateLines(hunks, MAX_STORED_HUNK_LINES),
  }
}

export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = []
  let draft: FileDraft | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (draft) files.push(finishDraft(draft))
      draft = { path: pathFromHeader(line), additions: 0, deletions: 0, hunkLines: [], isInHunk: false }
      continue
    }
    if (draft) readDiffLine(draft, line)
  }
  if (draft) files.push(finishDraft(draft))
  return files
}

export const GROUPING_SYSTEM_PROMPT = [
  'You organize the changes of a pull request into logical groups to help a reviewer, the way GitHub Copilot groups PR changes.',
  'Group files by the purpose they serve together (a feature, a refactor, tests, configuration, docs), not merely by folder.',
  'Prefer 2 to 7 groups. Order groups so a reviewer reads the core change first and supporting changes after.',
  'Every file path must appear in exactly one group, spelled exactly as given.',
  'Answer with JSON only, no prose and no code fence, shaped:',
  '{"groups":[{"title":"short title","summary":"one or two sentences on what changed and why it matters","files":["path"]}]}',
].join('\n')

export function buildGroupingPrompt(label: string, files: readonly FileChange[]): string {
  const listing = files.map(file => `- ${file.path} (+${file.additions} -${file.deletions})`).join('\n')
  let prompt = `Changes: ${label}\n\nFiles:\n${listing}\n\nPatches (truncated):\n`
  for (const file of files) {
    const excerpt = `\n### ${file.path}\n${file.hunks.slice(0, MAX_PROMPT_PATCH_CHARS)}\n`
    if (prompt.length + excerpt.length > MAX_PROMPT_CHARS) break
    prompt += excerpt
  }
  return prompt
}

function stripCodeFence(reply: string): string {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
  return (fenced?.[1] ?? reply).trim()
}

function readRawGroups(reply: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(stripCodeFence(reply))
    const groups = (parsed as { groups?: unknown }).groups
    if (Array.isArray(groups)) return groups
  } catch {
    throw new GroupingReplyError('the model reply was not valid JSON')
  }
  throw new GroupingReplyError('the model reply had no "groups" list')
}

export function normalizeGroups(rawGroups: readonly unknown[], files: readonly FileChange[]): ChangeGroup[] {
  const unassigned = new Set(files.map(file => file.path))
  const groups: ChangeGroup[] = []
  for (const raw of rawGroups) {
    const candidate = raw as { title?: unknown; summary?: unknown; files?: unknown }
    const paths = Array.isArray(candidate.files) ? candidate.files : []
    const owned = paths.filter((path): path is string => typeof path === 'string' && unassigned.delete(path))
    if (owned.length === 0) continue
    const title = typeof candidate.title === 'string' && candidate.title ? candidate.title : 'Untitled group'
    const summary = typeof candidate.summary === 'string' ? candidate.summary : ''
    groups.push({ title, summary, files: owned })
  }
  if (unassigned.size > 0) groups.push({ title: OTHER_GROUP_TITLE, summary: 'Files the grouping did not place.', files: [...unassigned] })
  return groups
}

export function parseGroupingReply(reply: string, files: readonly FileChange[]): ChangeGroup[] {
  return normalizeGroups(readRawGroups(reply), files)
}

export function groupByDirectory(files: readonly FileChange[]): ChangeGroup[] {
  const byDirectory = new Map<string, string[]>()
  for (const file of files) {
    const directory = file.path.includes('/') ? file.path.split('/')[0] ?? '(root)' : '(root)'
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file.path])
  }
  return [...byDirectory].map(([directory, paths]) => ({ title: directory, summary: `Changes under ${directory}.`, files: paths }))
}

export function sumStats(files: readonly FileChange[]): { additions: number; deletions: number } {
  return files.reduce(
    (total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  )
}
