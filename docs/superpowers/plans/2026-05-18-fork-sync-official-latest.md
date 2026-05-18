# Fork Sync Official Latest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the current official-latest feature state to `KuangKeZero/AIClient2API` without losing the preserved local functionality.

**Architecture:** Treat `justlovemaki/AIClient2API` as read-only `upstream` and `KuangKeZero/AIClient2API` as writable `origin`. Keep the planning-only local docs commits off the delivery path by preserving the current planning `HEAD` on a local branch, then create a clean delivery branch from `85a7778` and push that branch to the fork's `main`.

**Tech Stack:** Git, SSH to GitHub, existing Node/Jest test suite for final verification.

---

### Task 1: Rewire remotes for upstream/fork workflow

**Files:**
- Modify: `.git/config`

- [ ] **Step 1: Rename the current official remote and add the fork remote**

```bash
git remote rename origin upstream
git remote add origin git@github.com:KuangKeZero/AIClient2API.git
git remote -v
```

Expected: `upstream` points to `https://github.com/justlovemaki/AIClient2API.git`; `origin` points to `git@github.com:KuangKeZero/AIClient2API.git`.

- [ ] **Step 2: Fetch both remotes and tags**

```bash
git fetch upstream --tags
git fetch origin --tags
```

Expected: both remotes resolve cleanly and `upstream/main` still lands on `f3b36fc`.

### Task 2: Prepare a clean delivery branch from the functional commit

**Files:**
- Create: `.git/refs/heads/local/spec-docs`
- Create: `.git/refs/heads/deliver/fork-sync-official-latest`

- [ ] **Step 1: Preserve the planning-only docs commits locally**

```bash
git branch local/spec-docs HEAD
```

Expected: local-only branch `local/spec-docs` preserves the spec and plan docs commits and is not part of the delivery path.

- [ ] **Step 2: Create and switch to the delivery branch at the functional commit**

```bash
git switch -c deliver/fork-sync-official-latest 85a7778
git status --short --branch
```

Expected: the active branch is `deliver/fork-sync-official-latest` and the worktree is clean.

- [ ] **Step 3: Confirm the delivery branch contains only the feature commit on top of upstream**

```bash
git log --oneline upstream/main..deliver/fork-sync-official-latest
```

Expected: a single commit, `85a7778 feat: add account quota ledger and usage sync`.

- [ ] **Step 4: Re-run the focused regression tests before delivery**

```bash
npm test -- --runInBand tests/account-quota-ledger.test.js tests/openai-responses-stream-tools.test.js tests/provider-routing.test.js
```

Expected: all three suites pass.

### Task 3: Push the delivery branch to the fork and verify

**Files:**
- Modify: `.git/refs/remotes/origin/main`
- Modify: `.git/refs/heads/deliver/fork-sync-official-latest`

- [ ] **Step 1: Push the delivery branch to the fork main**

```bash
git push origin deliver/fork-sync-official-latest:main
```

Expected: remote `origin/main` updates to `85a7778`.

- [ ] **Step 2: Set the delivery branch to track the fork main**

```bash
git branch --set-upstream-to=origin/main deliver/fork-sync-official-latest
git status --short --branch
```

Expected: the active branch still shows a clean worktree and tracks `origin/main`.

- [ ] **Step 3: Verify the fork actually points at the delivered commit**

```bash
git ls-remote origin refs/heads/main
```

Expected: the hash matches `85a7778`.
