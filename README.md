# group-changes

A Claude Code mod that groups a branch's or a pull request's changes into logical review groups, like GitHub Copilot's "group changes" for PRs.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install group-changes --marketplace brenoferreira/pr-group-changes
```

From a shell:

```
claude plugin install group-changes --marketplace brenoferreira/pr-group-changes
```

Answer `y` to add the marketplace, then pick a scope. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `brenoferreira/pr-group-changes`, then Add plugin.

For the sidebar pane and clickable buttons, use fullscreen rendering (`/tui fullscreen`) in a terminal at least 110 columns wide. Otherwise the pane sits above the prompt; press `ctrl+x` then `Tab` to focus it, and `r` / `c` to refresh or close.

## Use

- On a feature branch with changes, a dim `⊞ change groups` button appears above the prompt. Press it to open or close the **Change groups** pane. The first open groups the branch's changes against the main branch.
- `/group-changes`: group the current branch against its base (`origin/HEAD`, else `main`, else `master`). The diff runs from the merge-base and includes uncommitted tracked changes; untracked files are left out.
- `/group-changes 123` or `/group-changes https://github.com/owner/repo/pull/123`: group another PR's changes (needs `gh`, signed in).
- `/group-changes hide`: close the pane.

In the pane, press a group to expand or collapse it, and a file to show its diff. **Refresh** re-runs the grouping.

Grouping uses one `sonnet` completion over the file list and truncated patches. If the model does not answer with valid JSON, files are grouped by top-level folder and the pane says so.
