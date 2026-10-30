export type FileChange = {
  path: string
  additions: number
  deletions: number
  hunks: string
}

export type ChangeGroup = { title: string; summary: string; files: string[] }

export type AnalysisTarget = { kind: 'branch' } | { kind: 'pr'; selector: string }

export type Analysis = {
  runId: string
  target: AnalysisTarget
  status: 'loading' | 'ready' | 'error'
  label: string
  detail: string
  note: string | null
  error: string | null
  files: FileChange[]
  groups: ChangeGroup[]
}

export type BranchInfo = {
  branch: string
  base: string
  isFeatureBranch: boolean
  hasChanges: boolean
}

export type PaneView = { expanded: number[]; selectedPath: string | null }

declare module 'claude-code' {
  interface PluginState {
    'group-changes': {
      analysis: Shaped<Analysis | null>
      branchInfo: Shaped<BranchInfo | null>
      view: Shaped<PaneView>
    }
  }
}
