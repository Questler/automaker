/**
 * Filter "All Worktrees" View by Active Branches - E2E Test
 *
 * Verifies that the "All Worktrees" board view only shows features
 * belonging to active branches (branches with a worktree or explicitly tracked).
 * Features on stale/inactive branches should be hidden in this view.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  createTempDirPath,
  cleanupTempDir,
  createTestGitRepo,
  createWorktreeDirectly,
  createTestFeature,
  authenticateForTests,
  handleLoginScreenIfPresent,
  waitForNetworkIdle,
  apiListWorktrees,
  TIMEOUTS,
} from '../utils';
import type { TestRepo } from '../utils';
import { Page } from '@playwright/test';

const TEST_TEMP_DIR = createTempDirPath('filter-all-by-active-branches');

/**
 * Set up localStorage with a project that has worktrees enabled and
 * starts in the "All Worktrees" view (__all_worktrees__ branch).
 */
async function setupProjectForAllWorktreesView(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript((pathArg: string) => {
    const mockProject = {
      id: 'test-project-filter-all',
      name: 'Filter All Worktrees Test',
      path: pathArg,
      lastOpened: new Date().toISOString(),
    };

    const mockState = {
      state: {
        projects: [mockProject],
        currentProject: mockProject,
        currentView: 'board',
        theme: 'dark',
        sidebarOpen: true,
        skipSandboxWarning: true,
        apiKeys: { anthropic: '', google: '' },
        chatSessions: [],
        chatHistoryOpen: false,
        maxConcurrency: 3,
        useWorktrees: true,
        currentWorktreeByProject: {
          // Start in "All Worktrees" view
          [pathArg]: { path: null, branch: '__all_worktrees__' },
        },
        worktreesByProject: {},
        trackedBranchesByProject: {},
      },
      version: 2,
    };

    localStorage.setItem('automaker-storage', JSON.stringify(mockState));

    const setupState = {
      state: {
        isFirstRun: false,
        setupComplete: true,
        currentStep: 'complete',
        skipClaudeSetup: false,
      },
      version: 0,
    };
    localStorage.setItem('automaker-setup', JSON.stringify(setupState));

    sessionStorage.setItem('automaker-splash-shown', 'true');
  }, projectPath);
}

/**
 * Write an `active-branches.json` file to simulate tracked branches
 */
function writeTrackedBranches(
  projectPath: string,
  branches: Array<{ name: string; createdAt?: string; lastActivatedAt?: string }>
): void {
  const automakerDir = path.join(projectPath, '.automaker');
  if (!fs.existsSync(automakerDir)) {
    fs.mkdirSync(automakerDir, { recursive: true });
  }
  const data = {
    branches: branches.map((b) => ({
      name: b.name,
      createdAt: b.createdAt ?? new Date().toISOString(),
      lastActivatedAt: b.lastActivatedAt,
    })),
  };
  fs.writeFileSync(path.join(automakerDir, 'active-branches.json'), JSON.stringify(data, null, 2));
}

test.describe('Filter All Worktrees view by active branches', () => {
  let repo: TestRepo;
  let projectPath: string;

  test.beforeAll(async () => {
    // Create a test git repository
    repo = await createTestGitRepo(TEST_TEMP_DIR);
    projectPath = repo.path;
  });

  test.afterAll(async () => {
    await repo.cleanup().catch(() => {});
    cleanupTempDir(TEST_TEMP_DIR);
  });

  test('worktree list API should include trackedBranches in response', async ({ page }) => {
    // Write tracked branches file
    writeTrackedBranches(projectPath, [
      { name: 'feature/active-tracked' },
      { name: 'feature/also-tracked' },
    ]);

    // Set up project and authenticate
    await setupProjectForAllWorktreesView(page, projectPath);
    await authenticateForTests(page);

    // Use the API to list worktrees and verify trackedBranches are returned
    const { data } = await apiListWorktrees(page, projectPath);

    expect(data.success).toBe(true);
    expect(data).toHaveProperty('worktrees');

    // The API should include trackedBranches
    // (even if the type doesn't explicitly declare it, the server now returns it)
    const responseData = data as Record<string, unknown>;
    expect(responseData).toHaveProperty('trackedBranches');

    const trackedBranches = responseData.trackedBranches as Array<{
      name: string;
      createdAt: string;
    }>;
    expect(trackedBranches).toBeInstanceOf(Array);
    expect(trackedBranches.length).toBe(2);

    const trackedNames = trackedBranches.map((b) => b.name);
    expect(trackedNames).toContain('feature/active-tracked');
    expect(trackedNames).toContain('feature/also-tracked');
  });

  test('worktree list API should return empty trackedBranches when no file exists', async ({
    page,
  }) => {
    // Remove tracked branches file if it exists
    const trackingFile = path.join(projectPath, '.automaker', 'active-branches.json');
    if (fs.existsSync(trackingFile)) {
      fs.unlinkSync(trackingFile);
    }

    await setupProjectForAllWorktreesView(page, projectPath);
    await authenticateForTests(page);

    const { data } = await apiListWorktrees(page, projectPath);

    expect(data.success).toBe(true);

    const responseData = data as Record<string, unknown>;
    const trackedBranches = (responseData.trackedBranches as Array<unknown>) ?? [];
    expect(trackedBranches).toBeInstanceOf(Array);
    expect(trackedBranches.length).toBe(0);
  });

  test('board view should display features on active branches in All Worktrees view', async ({
    page,
  }) => {
    // Create features on different branches:
    // - feature/active-branch: has a worktree → ACTIVE
    // - feature/tracked-branch: tracked via active-branches.json → ACTIVE
    // - feature/stale-branch: no worktree, not tracked → INACTIVE (should be hidden)

    // Create a worktree for "feature/active-branch"
    await createWorktreeDirectly(projectPath, 'feature/active-branch');

    // Write tracked branches (feature/tracked-branch is tracked, feature/stale-branch is not)
    writeTrackedBranches(projectPath, [{ name: 'feature/tracked-branch' }]);

    // Create features assigned to each branch
    createTestFeature(projectPath, 'feat-active-worktree', {
      id: 'feat-active-worktree',
      category: 'UI',
      description: 'Feature on active worktree branch',
      status: 'backlog',
      branchName: 'feature/active-branch',
    });

    createTestFeature(projectPath, 'feat-tracked-branch', {
      id: 'feat-tracked-branch',
      category: 'Backend',
      description: 'Feature on tracked branch',
      status: 'backlog',
      branchName: 'feature/tracked-branch',
    });

    createTestFeature(projectPath, 'feat-stale-branch', {
      id: 'feat-stale-branch',
      category: 'Testing',
      description: 'Feature on stale inactive branch',
      status: 'backlog',
      branchName: 'feature/stale-branch',
    });

    createTestFeature(projectPath, 'feat-unassigned', {
      id: 'feat-unassigned',
      category: 'General',
      description: 'Unassigned feature without branch',
      status: 'backlog',
    });

    // Set up the project to start in "All Worktrees" view
    await setupProjectForAllWorktreesView(page, projectPath);
    await authenticateForTests(page);

    // Navigate to board
    await page.goto('/board');
    await page.waitForLoadState('load');
    await handleLoginScreenIfPresent(page);

    // Wait for the board view to load
    await expect(page.locator('[data-testid="board-view"]')).toBeVisible({
      timeout: TIMEOUTS.long,
    });

    // Wait for kanban board to be populated
    await expect(page.locator('[data-testid="kanban-column-backlog"]')).toBeVisible({
      timeout: TIMEOUTS.medium,
    });

    // Wait for features to load from the server
    await waitForNetworkIdle(page);

    // Give the board time to re-render with filtered features
    await page.waitForTimeout(2000);

    // Features on active branches (worktree + tracked) and unassigned features should be visible
    await expect(async () => {
      const backlogColumn = page.locator('[data-testid="kanban-column-backlog"]');
      const allCards = backlogColumn.locator('[data-testid^="kanban-card-"]');

      // Check that the feature on the active worktree branch is visible
      const activeWorktreeCard = backlogColumn.locator(
        '[data-testid="kanban-card-feat-active-worktree"]'
      );
      const activeWorktreeCount = await activeWorktreeCard.count();

      // Check that the feature on the tracked branch is visible
      const trackedBranchCard = backlogColumn.locator(
        '[data-testid="kanban-card-feat-tracked-branch"]'
      );
      const trackedBranchCount = await trackedBranchCard.count();

      // Check that the unassigned feature is visible (always shown)
      const unassignedCard = backlogColumn.locator('[data-testid="kanban-card-feat-unassigned"]');
      const unassignedCount = await unassignedCard.count();

      // The feature on the stale branch should NOT be visible
      const staleCard = backlogColumn.locator('[data-testid="kanban-card-feat-stale-branch"]');
      const staleCount = await staleCard.count();

      // Active features should be shown
      expect(activeWorktreeCount).toBeGreaterThan(0);
      expect(trackedBranchCount).toBeGreaterThan(0);
      expect(unassignedCount).toBeGreaterThan(0);

      // Stale branch feature should be hidden
      expect(staleCount).toBe(0);
    }).toPass({ timeout: TIMEOUTS.long });
  });

  test('features on main branch should always be visible in All Worktrees view', async ({
    page,
  }) => {
    // Create a feature assigned to main branch (always active)
    createTestFeature(projectPath, 'feat-main-branch', {
      id: 'feat-main-branch',
      category: 'Core',
      description: 'Feature on main branch',
      status: 'backlog',
      branchName: 'main',
    });

    await setupProjectForAllWorktreesView(page, projectPath);
    await authenticateForTests(page);

    await page.goto('/board');
    await page.waitForLoadState('load');
    await handleLoginScreenIfPresent(page);

    await expect(page.locator('[data-testid="board-view"]')).toBeVisible({
      timeout: TIMEOUTS.long,
    });

    await waitForNetworkIdle(page);
    await page.waitForTimeout(2000);

    // Feature on main branch should always be visible since main always has a worktree
    await expect(async () => {
      const backlogColumn = page.locator('[data-testid="kanban-column-backlog"]');
      const mainCard = backlogColumn.locator('[data-testid="kanban-card-feat-main-branch"]');
      expect(await mainCard.count()).toBeGreaterThan(0);
    }).toPass({ timeout: TIMEOUTS.long });
  });
});
