/**
 * POST /commit endpoint - Commit changes in a worktree
 *
 * Note: Git repository validation (isGitRepo) is handled by
 * the requireGitRepoOnly middleware in index.ts
 */

import type { Request, Response } from 'express';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { getErrorMessage, logError } from '../common.js';

const execAsync = promisify(exec);

function sanitizeCommitMessage(message: string): string {
  let sanitized = message.trim();
  sanitized = sanitized.replace(/^`{1,3}([\s\S]*?)`{1,3}$/g, '$1').trim();
  sanitized = sanitized.replace(/^'{1,3}([\s\S]*?)'{1,3}$/g, '$1').trim();
  sanitized = sanitized.replace(/^\"{1,3}([\s\S]*?)\"{1,3}$/g, '$1').trim();
  return sanitized;
}

function commitWithMessage(worktreePath: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['commit', '-F', '-'], { cwd: worktreePath });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git commit failed with code ${code}`));
      }
    });

    child.stdin.write(message);
    child.stdin.end();
  });
}

export function createCommitHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath, message } = req.body as {
        worktreePath: string;
        message: string;
      };

      const sanitizedMessage = message ? sanitizeCommitMessage(message) : '';
      if (!worktreePath || !sanitizedMessage) {
        res.status(400).json({
          success: false,
          error: 'worktreePath and message required',
        });
        return;
      }

      // Check for uncommitted changes
      const { stdout: status } = await execAsync('git status --porcelain', {
        cwd: worktreePath,
      });

      if (!status.trim()) {
        res.json({
          success: true,
          result: {
            committed: false,
            message: 'No changes to commit',
          },
        });
        return;
      }

      // Stage all changes
      await execAsync('git add -A', { cwd: worktreePath });

      // Create commit
      await commitWithMessage(worktreePath, sanitizedMessage);

      // Get commit hash
      const { stdout: hashOutput } = await execAsync('git rev-parse HEAD', {
        cwd: worktreePath,
      });
      const commitHash = hashOutput.trim().substring(0, 8);

      // Get branch name
      const { stdout: branchOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath,
      });
      const branchName = branchOutput.trim();

      res.json({
        success: true,
        result: {
          committed: true,
          commitHash,
          branch: branchName,
          message: sanitizedMessage,
        },
      });
    } catch (error) {
      logError(error, 'Commit worktree failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
