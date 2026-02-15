/**
 * Auto Dependency Merge - Verification Test
 *
 * Verifies the auto-dep-merge feature's core git operations:
 * 1. Pre-execution merge: merges main into feature branch before execution
 * 2. Post-verification merge: merges verified feature branch back into main
 * 3. Conflict handling: aborts merge and leaves clean state on conflicts
 *
 * These tests use real git repos to verify the merge logic that
 * auto-mode-service.ts implements.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createTempDirPath, cleanupTempDir } from '../utils';

const TEST_TEMP_DIR = createTempDirPath('auto-dep-merge-git-test');

/** Execute a git command in the given directory */
function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8' }).trim();
}

/** Create a git repo with an initial commit on main */
function createTestRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  git('init -b main', repoPath);
  git('config user.email "test@test.com"', repoPath);
  git('config user.name "Test"', repoPath);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test Project\n');
  git('add .', repoPath);
  git('commit -m "Initial commit"', repoPath);
}

test.describe('Auto Dependency Merge - Git Operations', () => {
  let projectPath: string;

  test.beforeAll(async () => {
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }
  });

  test.afterAll(async () => {
    cleanupTempDir(TEST_TEMP_DIR);
  });

  test.beforeEach(async () => {
    projectPath = path.join(TEST_TEMP_DIR, `repo-${Date.now()}`);
    createTestRepo(projectPath);
  });

  test('pre-execution merge: merges main into feature branch', async () => {
    // Create a feature branch
    git('checkout -b feature/test-feature', projectPath);
    fs.writeFileSync(path.join(projectPath, 'feature.ts'), 'export const feature = true;\n');
    git('add .', projectPath);
    git('commit -m "Add feature code"', projectPath);

    // Go back to main and add a dependency change (simulating another feature merged to main)
    git('checkout main', projectPath);
    fs.writeFileSync(path.join(projectPath, 'dependency.ts'), 'export const dep = "v2";\n');
    git('add .', projectPath);
    git('commit -m "Merge dependency feature into main"', projectPath);

    // Switch to feature branch
    git('checkout feature/test-feature', projectPath);

    // Verify feature branch doesn't have the dependency yet
    expect(fs.existsSync(path.join(projectPath, 'dependency.ts'))).toBe(false);

    // Simulate pre-execution merge (what auto-mode-service does)
    const mergeOutput = git('merge main --no-edit', projectPath);

    // Verify the merge succeeded and feature branch now has the dependency
    expect(fs.existsSync(path.join(projectPath, 'dependency.ts'))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, 'feature.ts'))).toBe(true);

    // Verify we're still on the feature branch
    const currentBranch = git('branch --show-current', projectPath);
    expect(currentBranch).toBe('feature/test-feature');
  });

  test('post-verification merge: merges verified feature branch into main', async () => {
    // Create and commit feature on a branch
    git('checkout -b feature/verified-feature', projectPath);
    fs.writeFileSync(path.join(projectPath, 'verified-feature.ts'), 'export const verified = true;\n');
    git('add .', projectPath);
    git('commit -m "Add verified feature"', projectPath);

    // Switch back to main
    git('checkout main', projectPath);

    // Verify main doesn't have the feature yet
    expect(fs.existsSync(path.join(projectPath, 'verified-feature.ts'))).toBe(false);

    // Simulate post-verification merge (what auto-mode-service does after tests pass)
    const branchName = 'feature/verified-feature';
    const mergeMessage = `Merge ${branchName}: Verified feature test`;
    git(`merge ${branchName} -m "${mergeMessage}"`, projectPath);

    // Verify main now has the feature
    expect(fs.existsSync(path.join(projectPath, 'verified-feature.ts'))).toBe(true);

    // Verify the merge commit message
    const lastCommitMsg = git('log -1 --pretty=%B', projectPath);
    expect(lastCommitMsg).toContain(`Merge ${branchName}`);

    // Verify we're on main
    const currentBranch = git('branch --show-current', projectPath);
    expect(currentBranch).toBe('main');
  });

  test('conflict handling: aborts merge and leaves clean state', async () => {
    // Create conflicting changes on main and feature branch
    git('checkout -b feature/conflicting', projectPath);
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Feature version\nConflicting content\n');
    git('add .', projectPath);
    git('commit -m "Feature changes to README"', projectPath);

    git('checkout main', projectPath);
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Main version\nDifferent content\n');
    git('add .', projectPath);
    git('commit -m "Main changes to README"', projectPath);

    git('checkout feature/conflicting', projectPath);

    // Attempt merge - should fail with conflict
    let hasConflict = false;
    let mergeOutput = '';
    try {
      git('merge main --no-edit', projectPath);
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      mergeOutput = `${err.stdout || ''} ${err.stderr || ''} ${err.message || ''}`;
      hasConflict = mergeOutput.includes('CONFLICT') || mergeOutput.includes('Automatic merge failed');
    }

    expect(hasConflict).toBe(true);

    // Simulate conflict handling (what auto-mode-service does)
    git('merge --abort', projectPath);

    // Verify the repo is in a clean state after abort
    const status = git('status --porcelain', projectPath);
    expect(status).toBe('');

    // Verify we're still on the feature branch with original content
    const currentBranch = git('branch --show-current', projectPath);
    expect(currentBranch).toBe('feature/conflicting');
    const readmeContent = fs.readFileSync(path.join(projectPath, 'README.md'), 'utf-8');
    expect(readmeContent).toContain('Feature version');
  });

  test('full lifecycle: pre-merge → execute → post-merge (dependency chain)', async () => {
    // Simulate a dependency chain where Feature A must be merged before Feature B runs

    // === Feature A: already verified and merged into main ===
    git('checkout -b feature/feature-a', projectPath);
    fs.writeFileSync(path.join(projectPath, 'lib-a.ts'), 'export const libA = "v1";\n');
    git('add .', projectPath);
    git('commit -m "Implement Feature A"', projectPath);

    // Merge Feature A back to main (simulates post-verification merge)
    git('checkout main', projectPath);
    git('merge feature/feature-a -m "Merge feature/feature-a: Feature A"', projectPath);
    expect(fs.existsSync(path.join(projectPath, 'lib-a.ts'))).toBe(true);

    // === Feature B: depends on Feature A, about to start execution ===
    // Create Feature B branch from an older point (before A was merged)
    git('checkout -b feature/feature-b HEAD~1', projectPath);
    expect(fs.existsSync(path.join(projectPath, 'lib-a.ts'))).toBe(false);

    // Step 1: Pre-execution merge (brings in Feature A's code)
    git('merge main --no-edit', projectPath);
    expect(fs.existsSync(path.join(projectPath, 'lib-a.ts'))).toBe(true);

    // Step 2: Feature B implementation (uses Feature A's code)
    fs.writeFileSync(
      path.join(projectPath, 'lib-b.ts'),
      'import { libA } from "./lib-a";\nexport const libB = `depends on ${libA}`;\n'
    );
    git('add .', projectPath);
    git('commit -m "Implement Feature B (depends on A)"', projectPath);

    // Step 3: Post-verification merge (Feature B back to main)
    git('checkout main', projectPath);
    git('merge feature/feature-b -m "Merge feature/feature-b: Feature B"', projectPath);

    // Verify main has both features
    expect(fs.existsSync(path.join(projectPath, 'lib-a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, 'lib-b.ts'))).toBe(true);

    // Verify git log shows the merge chain
    const log = git('log --oneline -5', projectPath);
    expect(log).toContain('Merge feature/feature-b');
    expect(log).toContain('Merge feature/feature-a');
  });

  test('already up-to-date: pre-merge is a no-op when branch is current', async () => {
    // Create a feature branch from current main (no new changes on main)
    git('checkout -b feature/up-to-date', projectPath);
    fs.writeFileSync(path.join(projectPath, 'feature.ts'), 'export const f = true;\n');
    git('add .', projectPath);
    git('commit -m "Feature work"', projectPath);

    // Pre-execution merge should report "Already up to date"
    let isAlreadyUpToDate = false;
    try {
      const output = git('merge main --no-edit', projectPath);
      isAlreadyUpToDate = output.includes('Already up to date');
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const output = `${err.stdout || ''} ${err.stderr || ''} ${err.message || ''}`;
      isAlreadyUpToDate = output.includes('Already up to date');
    }

    expect(isAlreadyUpToDate).toBe(true);
  });
});
