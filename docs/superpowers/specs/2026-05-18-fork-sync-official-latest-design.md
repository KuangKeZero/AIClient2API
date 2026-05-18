# Fork Sync Official Latest Design

## Goal

Push the current local feature state to `KuangKeZero/AIClient2API` while preserving the existing local functionality and staying based on the official upstream repository `justlovemaki/AIClient2API`.

## Current State

- Official upstream `justlovemaki/AIClient2API` `main` currently resolves to `f3b36fc`, tagged as `v3.1.2.2`.
- User fork `KuangKeZero/AIClient2API` `main` currently resolves to the same `f3b36fc`.
- Local `main` is one commit ahead at `85a7778`, which contains the preserved account quota ledger and usage sync work.
- A local backup branch, `backup/main-before-sanitize-push-20260518-143149`, preserves the earlier unsanitized local history.
- Sensitive runtime/config files are ignored locally and should not be pushed.

## Approach

Use the local `main` branch as the integration result because it is already built on top of the official latest visible upstream commit. Add or update a fork remote for `KuangKeZero/AIClient2API`, then push local `main` to the fork's `main` branch.

This avoids rebasing or cherry-picking across an identical base and keeps the fork history simple:

```text
f3b36fc official latest / fork current main
   |
85a7778 preserved local functionality
```

## Conflict Policy

No code merge conflict is expected because the official upstream and fork `main` are already at the same commit used as the local base. If a new upstream or fork commit appears before push, fetch again and stop to inspect the new diff before pushing.

If a conflict appears later, preserve these local features unless the user explicitly chooses otherwise:

- account quota ledger behavior
- usage provider pool sync behavior
- Codex Plus routing and restore rules
- sanitized ignore rules for local credentials/runtime files

## Verification

Before pushing:

- Confirm the worktree is clean except for intended spec/plan commits.
- Confirm `justlovemaki/AIClient2API` and `KuangKeZero/AIClient2API` fork base still point to the expected upstream commit or inspect any new commits.
- Confirm staged/pushed history does not include token/config backup files.
- Run the focused Jest tests already used for this feature set:
  `npm test -- --runInBand tests/account-quota-ledger.test.js tests/openai-responses-stream-tools.test.js tests/provider-routing.test.js`

After pushing:

- Confirm local `main` tracks or matches the fork destination commit.
- Confirm `git status --short --branch` is clean.
