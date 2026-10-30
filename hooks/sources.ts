import type { EngineInterface } from 'claude-code'

import type { BranchInfo } from '../types'

export class SourceError extends Error {}

export type DiffSource = { label: string; detail: string; diff: string }

type BranchRefs = { branch: string; base: string; baseRef: string }

const DIFF_TIMEOUT_MS = 60000

async function runText($: EngineInterface, argv: readonly string[]): Promise<string | null> {
  const result = await $.process.run(argv, { timeoutMs: DIFF_TIMEOUT_MS }).catch(() => null)
  return result && result.exitCode === 0 ? result.stdout.trim() : null
}

async function refExists($: EngineInterface, ref: string): Promise<boolean> {
  return (await runText($, ['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null
}

async function detectBase($: EngineInterface): Promise<string | null> {
  const originHead = await runText($, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead) return originHead.replace(/^origin\//, '')
  for (const candidate of ['main', 'master']) {
    if ((await refExists($, candidate)) || (await refExists($, `origin/${candidate}`))) return candidate
  }
  return null
}

async function readBranchRefs($: EngineInterface): Promise<BranchRefs | null> {
  const branch = await runText($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  const base = branch ? await detectBase($) : null
  if (!branch || !base) return null
  const baseRef = (await refExists($, `origin/${base}`)) ? `origin/${base}` : base
  return { branch, base, baseRef }
}

async function mergeBase($: EngineInterface, baseRef: string): Promise<string | null> {
  return runText($, ['git', 'merge-base', 'HEAD', baseRef])
}

export async function readBranchInfo($: EngineInterface): Promise<BranchInfo | null> {
  const refs = await readBranchRefs($)
  if (!refs) return null
  const isFeatureBranch = refs.branch !== refs.base && refs.branch !== 'HEAD'
  const forkPoint = isFeatureBranch ? await mergeBase($, refs.baseRef) : null
  const quiet = forkPoint ? await $.process.run(['git', 'diff', '--quiet', forkPoint]).catch(() => null) : null
  return { branch: refs.branch, base: refs.base, isFeatureBranch, hasChanges: quiet?.exitCode === 1 }
}

export async function readBranchDiff($: EngineInterface): Promise<DiffSource> {
  const refs = await readBranchRefs($)
  if (!refs) throw new SourceError('Not a git repository with a main or master branch to compare against.')
  if (refs.branch === refs.base) throw new SourceError(`You are on ${refs.base}. Check out a feature branch, or run /group-changes <pr-number>.`)
  if (refs.branch === 'HEAD') throw new SourceError('HEAD is detached. Check out a branch, or run /group-changes <pr-number>.')
  const forkPoint = await mergeBase($, refs.baseRef)
  if (!forkPoint) throw new SourceError(`${refs.branch} shares no history with ${refs.baseRef}.`)
  const diff = await runText($, ['git', 'diff', '--no-color', '--no-ext-diff', forkPoint])
  if (diff === null) throw new SourceError('git diff failed.')
  return { label: `${refs.branch} → ${refs.base}`, detail: 'commits since the fork point plus uncommitted tracked changes', diff }
}

type PullRequestView = { number: number; title: string; baseRefName: string; headRefName: string }

export async function readPullRequestDiff($: EngineInterface, selector: string): Promise<DiffSource> {
  const view = await runText($, ['gh', 'pr', 'view', selector, '--json', 'number,title,baseRefName,headRefName'])
  if (view === null) throw new SourceError(`Could not read PR "${selector}" with gh. Is gh installed and signed in?`)
  const pullRequest = JSON.parse(view) as PullRequestView
  const diff = await runText($, ['gh', 'pr', 'diff', selector, '--color', 'never'])
  if (diff === null) throw new SourceError(`Could not read the diff of PR #${pullRequest.number}.`)
  return {
    label: `PR #${pullRequest.number} ${pullRequest.title}`,
    detail: `${pullRequest.headRefName} → ${pullRequest.baseRefName}`,
    diff,
  }
}
