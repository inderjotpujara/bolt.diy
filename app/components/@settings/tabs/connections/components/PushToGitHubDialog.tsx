import * as Dialog from '@radix-ui/react-dialog';
import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import { motion } from 'framer-motion';
import { Octokit } from '@octokit/rest';

// Internal imports
import { getLocalStorage } from '~/lib/persistence';
import { classNames } from '~/utils/classNames';
import type { GitHubUserResponse } from '~/types/GitHub';
import { logStore } from '~/lib/stores/logs';

// UI Components
import { Badge, ConfirmationDialog } from '~/components/ui';

interface PushToGitHubDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onPush: (
    repoName: string,
    username?: string,
    token?: string,
    isPrivate?: boolean,
    branchName?: string,
    commitMessage?: string,
  ) => Promise<string>;
}

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string;
  stargazers_count: number;
  forks_count: number;
  default_branch: string;
  updated_at: string;
  language: string;
  private: boolean;
}

export function PushToGitHubDialog({ isOpen, onClose, onPush }: PushToGitHubDialogProps) {
  const [repoName, setRepoName] = useState('');
  const [branchName, setBranchName] = useState('main');
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useState<GitHubUserResponse | null>(null);
  const [recentRepos, setRecentRepos] = useState<GitHubRepo[]>([]);
  const [filteredRepos, setFilteredRepos] = useState<GitHubRepo[]>([]);
  const [repoSearchQuery, setRepoSearchQuery] = useState('');
  const [isRepoDropdownOpen, setIsRepoDropdownOpen] = useState(false);
  const [focusedRepoIndex, setFocusedRepoIndex] = useState(-1);
  const repoOptionsRef = useRef<(HTMLDivElement | null)[]>([]);

  const [branchSearchQuery, setBranchSearchQuery] = useState('');
  const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false);
  const [focusedBranchIndex, setFocusedBranchIndex] = useState(-1);
  const branchOptionsRef = useRef<(HTMLDivElement | null)[]>([]);

  const [showSuccessDialog, setShowSuccessDialog] = useState(false);
  const [createdRepoUrl, setCreatedRepoUrl] = useState('');
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [commitMessage, setCommitMessage] = useState('Initial commit');
  const [confirmDialogMessage, setConfirmDialogMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Load GitHub connection on mount
  useEffect(() => {
    if (isOpen) {
      const connection = getLocalStorage('github_connection');

      if (connection?.user && connection?.token) {
        setUser(connection.user);

        // Only fetch if we have both user and token
        if (connection.token.trim()) {
          fetchRecentRepos(connection.token);
        }
      }
    }
  }, [isOpen]);

  // Fetch branches when repoName changes and is non-empty
  useEffect(() => {
    async function fetchBranches() {
      if (!repoName.trim()) {
        setBranchOptions([]);
        return;
      }

      const connection = getLocalStorage('github_connection');

      if (!connection?.token || !connection?.user) {
        return;
      }

      try {
        const response = await fetch(`https://api.github.com/repos/${connection.user.login}/${repoName}/branches`, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${connection.token}`,
          },
        });

        if (!response.ok) {
          setBranchOptions([]);
          return;
        }

        const data = await response.json();

        if (Array.isArray(data)) {
          setBranchOptions(data.map((b) => b.name));
        } else {
          setBranchOptions([]);
        }
      } catch {
        setBranchOptions([]);
      }
    }

    fetchBranches();
  }, [repoName]);

  /*
   * Filter repositories based on search query
   * const debouncedSetRepoSearchQuery = useDebouncedCallback((value: string) => setRepoSearchQuery(value), 300);
   */

  useEffect(() => {
    if (recentRepos.length === 0) {
      setFilteredRepos([]);
      return;
    }

    if (!repoSearchQuery.trim()) {
      setFilteredRepos(recentRepos);
      return;
    }

    const query = repoSearchQuery.toLowerCase().trim();
    const filtered = recentRepos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(query) ||
        (repo.description && repo.description.toLowerCase().includes(query)) ||
        (repo.language && repo.language.toLowerCase().includes(query)),
    );

    setFilteredRepos(filtered);
  }, [recentRepos, repoSearchQuery]);

  const fetchRecentRepos = useCallback(async (token: string) => {
    if (!token) {
      logStore.logError('No GitHub token available');
      toast.error('GitHub authentication required');

      return;
    }

    try {
      console.log('Fetching GitHub repositories with token:', token.substring(0, 5) + '...');

      // Fetch ALL repos by paginating through all pages
      let allRepos: GitHubRepo[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const requestUrl = `https://api.github.com/user/repos?sort=updated&per_page=100&page=${page}&affiliation=owner,organization_member`;
        const response = await fetch(requestUrl, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token.trim()}`,
          },
        });

        if (!response.ok) {
          let errorData: { message?: string } = {};

          try {
            errorData = await response.json();
            console.error('Error response data:', errorData);
          } catch (e) {
            errorData = { message: 'Could not parse error response' };
            console.error('Could not parse error response:', e);
          }

          if (response.status === 401) {
            toast.error('GitHub token expired. Please reconnect your account.');

            // Clear invalid token
            const connection = getLocalStorage('github_connection');

            if (connection) {
              localStorage.removeItem('github_connection');
              setUser(null);
            }
          } else if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
            // Rate limit exceeded
            const resetTime = response.headers.get('x-ratelimit-reset');
            const resetDate = resetTime ? new Date(parseInt(resetTime) * 1000).toLocaleTimeString() : 'soon';
            toast.error(`GitHub API rate limit exceeded. Limit resets at ${resetDate}`);
          } else {
            logStore.logError('Failed to fetch GitHub repositories', {
              status: response.status,
              statusText: response.statusText,
              error: errorData,
            });
            toast.error(`Failed to fetch repositories: ${errorData.message || response.statusText}`);
          }

          return;
        }

        try {
          const repos = (await response.json()) as GitHubRepo[];
          allRepos = allRepos.concat(repos);

          if (repos.length < 100) {
            hasMore = false;
          } else {
            page += 1;
          }
        } catch (parseError) {
          console.error('Error parsing JSON response:', parseError);
          logStore.logError('Failed to parse GitHub repositories response', { parseError });
          toast.error('Failed to parse repository data');
          setRecentRepos([]);

          return;
        }
      }
      setRecentRepos(allRepos);
    } catch (error) {
      console.error('Exception while fetching GitHub repositories:', error);
      logStore.logError('Failed to fetch GitHub repositories', { error });
      toast.error('Failed to fetch recent repositories');
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage('');

    const connection = getLocalStorage('github_connection');

    if (!connection?.token || !connection?.user) {
      setErrorMessage('Please connect your GitHub account in Settings > Connections first');
      return;
    }

    if (!repoName.trim()) {
      setErrorMessage('Repository name is required');
      return;
    }

    if (!branchName.trim() || !/^([a-zA-Z0-9._\-/]+)$/.test(branchName)) {
      setErrorMessage('Please enter a valid branch name.');
      return;
    }

    setIsLoading(true);

    try {
      // Check if repository exists first
      const octokit = new Octokit({ auth: connection.token });
      let repoExists = false;
      let branchExists = false;
      let repoData = null;

      try {
        const { data: repo } = await octokit.repos.get({
          owner: connection.user.login,
          repo: repoName,
        });
        repoExists = true;
        repoData = repo;

        // Check if branch exists

        try {
          await octokit.git.getRef({
            owner: connection.user.login,
            repo: repoName,
            ref: `heads/${branchName.trim()}`,
          });
          branchExists = true;
        } catch (err: any) {
          if (err.status !== 404) {
            throw err;
          }
        }
      } catch (error: any) {
        if (error.status !== 404) {
          throw error;
        }
      }

      // Only show confirm dialog if repo exists and (branch exists or visibility changes)
      if (repoExists && (branchExists || (repoData && repoData.private !== isPrivate))) {
        let msg = `You are pushing to branch "${branchName.trim()}" in repo "${repoName}".`;

        if (branchExists) {
          msg += ' Existing files with the same name will be updated. No files will be deleted.';
        } else {
          msg += ' A new branch will be created.';
        }

        if (repoData && repoData.private !== isPrivate) {
          msg += isPrivate
            ? ' This will also change the repository from public to private.'
            : ' This will also change the repository from private to public.';
        }

        setConfirmDialogMessage(msg);
        setShowConfirmDialog(true);
        setIsLoading(false);

        return;
      }

      // Otherwise, go straight to commit message dialog
      setShowCommitDialog(true);
      setIsLoading(false);
    } catch (error: any) {
      setIsLoading(false);
      setErrorMessage(error.message || 'Failed to check repository.');
    }
  }

  // Called after confirmation dialog
  const handleConfirmProceed = () => {
    setShowConfirmDialog(false);
    setShowCommitDialog(true);
  };

  // Called after commit message dialog
  const handleCommitProceed = async () => {
    setShowCommitDialog(false);
    setIsLoading(true);
    setErrorMessage('');

    try {
      const connection = getLocalStorage('github_connection');
      const repoUrl = await onPush(
        repoName,
        connection.user.login,
        connection.token,
        isPrivate,
        branchName,
        commitMessage,
      );
      setCreatedRepoUrl(repoUrl);
      setShowSuccessDialog(true);
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to push to GitHub.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setRepoName('');
    setIsPrivate(false);
    setShowSuccessDialog(false);
    setCreatedRepoUrl('');
    onClose();
  };

  // Filtered repo list for dropdown
  const filteredReposList =
    repoSearchQuery.trim() === ''
      ? recentRepos
      : recentRepos.filter((repo) => repo.name.toLowerCase().includes(repoSearchQuery.toLowerCase()));

  const showCreateNewRepo =
    repoSearchQuery.trim() &&
    !recentRepos.some((repo) => repo.name.toLowerCase() === repoSearchQuery.trim().toLowerCase());

  // Keyboard navigation for repo combobox (ModelSelector pattern)
  const handleRepoKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isRepoDropdownOpen) {
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setIsRepoDropdownOpen(false);

      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedRepoIndex((prev) => {
        const max = showCreateNewRepo ? filteredReposList.length : filteredReposList.length - 1;
        return prev + 1 > max ? 0 : prev + 1;
      });

      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedRepoIndex((prev) => {
        const max = showCreateNewRepo ? filteredReposList.length : filteredReposList.length - 1;
        return prev - 1 < 0 ? max : prev - 1;
      });

      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();

      if (focusedRepoIndex >= 0 && focusedRepoIndex < filteredReposList.length) {
        setRepoName(filteredReposList[focusedRepoIndex].name);
        setIsRepoDropdownOpen(false);
        setRepoSearchQuery('');
      } else if (showCreateNewRepo && focusedRepoIndex === filteredReposList.length) {
        setRepoName(repoSearchQuery.trim());
        setIsRepoDropdownOpen(false);
        setRepoSearchQuery('');
      } else if (showCreateNewRepo && filteredReposList.length === 0) {
        setRepoName(repoSearchQuery.trim());
        setIsRepoDropdownOpen(false);
        setRepoSearchQuery('');
      }

      return;
    }
  };

  // Reset focus index when dropdown/query changes
  useEffect(() => {
    setFocusedRepoIndex(-1);
  }, [repoSearchQuery, isRepoDropdownOpen]);

  // Outside click and blur for repo dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(event.target as Node)) {
        setIsRepoDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);

    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Blur handler for input
  const handleRepoInputBlur = () => {
    // If focus is moving to a dropdown item, don't close
    setTimeout(() => {
      if (
        document.activeElement &&
        repoDropdownRef.current &&
        repoDropdownRef.current.contains(document.activeElement)
      ) {
        return;
      }

      setIsRepoDropdownOpen(false);
    }, 0);
  };

  // Filtered branch list for dropdown
  const filteredBranchesList =
    branchSearchQuery.trim() === ''
      ? branchOptions
      : branchOptions.filter((b) => b.toLowerCase().includes(branchSearchQuery.toLowerCase()));

  const showCreateNewBranch =
    branchSearchQuery.trim() && !branchOptions.some((b) => b.toLowerCase() === branchSearchQuery.trim().toLowerCase());

  // Keyboard navigation for branch combobox (ModelSelector pattern)
  const handleBranchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isBranchDropdownOpen) {
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setIsBranchDropdownOpen(false);

      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedBranchIndex((prev) => {
        const max = showCreateNewBranch ? filteredBranchesList.length : filteredBranchesList.length - 1;
        return prev + 1 > max ? 0 : prev + 1;
      });

      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedBranchIndex((prev) => {
        const max = showCreateNewBranch ? filteredBranchesList.length : filteredBranchesList.length - 1;
        return prev - 1 < 0 ? max : prev - 1;
      });

      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();

      if (focusedBranchIndex >= 0 && focusedBranchIndex < filteredBranchesList.length) {
        setBranchName(filteredBranchesList[focusedBranchIndex]);
        setBranchSearchQuery(filteredBranchesList[focusedBranchIndex]);
        setIsBranchDropdownOpen(false);
      } else if (showCreateNewBranch && focusedBranchIndex === filteredBranchesList.length) {
        setBranchName(branchSearchQuery.trim());
        setBranchSearchQuery(branchSearchQuery.trim());
        setIsBranchDropdownOpen(false);
      } else if (showCreateNewBranch && filteredBranchesList.length === 0) {
        setBranchName(branchSearchQuery.trim());
        setBranchSearchQuery(branchSearchQuery.trim());
        setIsBranchDropdownOpen(false);
      }

      return;
    }
  };

  // Reset focus index when dropdown/query changes
  useEffect(() => {
    setFocusedBranchIndex(-1);
  }, [branchSearchQuery, isBranchDropdownOpen]);

  // Outside click and blur for branch dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(event.target as Node)) {
        setIsBranchDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);

    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleBranchInputBlur = () => {
    setTimeout(() => {
      if (
        document.activeElement &&
        branchDropdownRef.current &&
        branchDropdownRef.current.contains(document.activeElement)
      ) {
        return;
      }

      setIsBranchDropdownOpen(false);
    }, 0);
  };

  const handleBranchKeyDownCapture = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    handleBranchKeyDown(e);
  };

  // Reset all state on dialog close or open
  useEffect(() => {
    if (!isOpen) {
      setRepoName('');
      setRepoSearchQuery('');
      setBranchName('main');
      setBranchSearchQuery('');
      setIsRepoDropdownOpen(false);
      setIsBranchDropdownOpen(false);
      setFocusedRepoIndex(-1);
      setFocusedBranchIndex(-1);
      setErrorMessage('');
      setShowSuccessDialog(false);
      setCreatedRepoUrl('');
      setShowConfirmDialog(false);
      setShowCommitDialog(false);
      setCommitMessage('Initial commit');
      setConfirmDialogMessage('');
    }
  }, [isOpen]);

  // Success Dialog
  if (showSuccessDialog) {
    return (
      <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999]" />
          <div className="fixed inset-0 flex items-center justify-center z-[9999]">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="w-[90vw] md:w-[600px] max-h-[85vh] overflow-y-auto"
            >
              <Dialog.Content
                className="bg-white dark:bg-bolt-elements-background-depth-1 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark shadow-xl"
                aria-describedby="success-dialog-description"
              >
                <div className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center text-green-500">
                        <div className="i-ph:check-circle w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="text-lg font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark">
                          Successfully pushed to GitHub
                        </h3>
                        <p
                          id="success-dialog-description"
                          className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark"
                        >
                          Your code is now available on GitHub
                        </p>
                      </div>
                    </div>
                    <Dialog.Close asChild>
                      <button
                        onClick={handleClose}
                        className="p-2 rounded-lg transition-all duration-200 ease-in-out bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary dark:text-bolt-elements-textTertiary-dark dark:hover:text-bolt-elements-textPrimary-dark hover:bg-bolt-elements-background-depth-2 dark:hover:bg-bolt-elements-background-depth-3 focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColor dark:focus:ring-bolt-elements-borderColor-dark"
                      >
                        <span className="i-ph:x block w-5 h-5" aria-hidden="true" />
                        <span className="sr-only">Close dialog</span>
                      </button>
                    </Dialog.Close>
                  </div>

                  <div className="bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 rounded-lg p-4 text-left border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark">
                    <p className="text-sm font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark mb-2 flex items-center gap-2">
                      <span className="i-ph:github-logo w-4 h-4 text-purple-500" />
                      Repository URL
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-sm bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-4 px-3 py-2 rounded border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark font-mono">
                        {createdRepoUrl}
                      </code>
                      <motion.button
                        onClick={() => {
                          navigator.clipboard.writeText(createdRepoUrl);
                          toast.success('URL copied to clipboard');
                        }}
                        className="p-2 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary dark:text-bolt-elements-textSecondary-dark dark:hover:text-bolt-elements-textPrimary-dark bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-4 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                      >
                        <div className="i-ph:copy w-4 h-4" />
                      </motion.button>
                    </div>
                  </div>

                  <div className="bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 rounded-lg p-4 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark">
                    <p className="text-sm font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark mb-2 flex items-center gap-2">
                      <span className="i-ph:files w-4 h-4 text-purple-500" />
                      Pushed Files ({filteredRepos.length})
                    </p>
                    <div className="max-h-[200px] overflow-y-auto custom-scrollbar pr-2">
                      {filteredRepos.map((repo) => (
                        <div
                          key={repo.full_name}
                          className="flex items-center justify-between py-1.5 text-sm text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark border-b border-bolt-elements-borderColor/30 dark:border-bolt-elements-borderColor-dark/30 last:border-0"
                        >
                          <span className="font-mono truncate flex-1 text-xs">{repo.name}</span>
                          {repo.private && (
                            <Badge variant="primary" size="sm" icon="i-ph:lock w-3 h-3">
                              Private
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <motion.a
                      href={createdRepoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 rounded-lg bg-purple-500 text-white hover:bg-purple-600 text-sm inline-flex items-center gap-2"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="i-ph:github-logo w-4 h-4" />
                      View Repository
                    </motion.a>
                    <motion.button
                      onClick={() => {
                        navigator.clipboard.writeText(createdRepoUrl);
                        toast.success('URL copied to clipboard');
                      }}
                      className="px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 text-sm inline-flex items-center gap-2 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="i-ph:copy w-4 h-4" />
                      Copy URL
                    </motion.button>
                    <motion.button
                      onClick={handleClose}
                      className="px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 text-sm border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      Close
                    </motion.button>
                  </div>
                </div>
              </Dialog.Content>
            </motion.div>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  if (!user) {
    return (
      <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999]" />
          <div className="fixed inset-0 flex items-center justify-center z-[9999]">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="w-[90vw] md:w-[500px]"
            >
              <Dialog.Content
                className="bg-white dark:bg-bolt-elements-background-depth-1 rounded-lg p-6 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark shadow-xl"
                aria-describedby="connection-required-description"
              >
                <div className="relative text-center space-y-4">
                  <Dialog.Close asChild>
                    <button
                      onClick={handleClose}
                      className="absolute right-0 top-0 p-2 rounded-lg transition-all duration-200 ease-in-out bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary dark:text-bolt-elements-textTertiary-dark dark:hover:text-bolt-elements-textPrimary-dark hover:bg-bolt-elements-background-depth-2 dark:hover:bg-bolt-elements-background-depth-3 focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColor dark:focus:ring-bolt-elements-borderColor-dark"
                    >
                      <span className="i-ph:x block w-5 h-5" aria-hidden="true" />
                      <span className="sr-only">Close dialog</span>
                    </button>
                  </Dialog.Close>
                  <motion.div
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.1 }}
                    className="mx-auto w-16 h-16 rounded-xl bg-bolt-elements-background-depth-3 flex items-center justify-center text-purple-500"
                  >
                    <div className="i-ph:github-logo w-8 h-8" />
                  </motion.div>
                  <h3 className="text-lg font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark">
                    GitHub Connection Required
                  </h3>
                  <p
                    id="connection-required-description"
                    className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark max-w-md mx-auto"
                  >
                    To push your code to GitHub, you need to connect your GitHub account in Settings {'>'} Connections
                    first.
                  </p>
                  <div className="pt-2 flex justify-center gap-3">
                    <motion.button
                      className="px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark text-sm hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={handleClose}
                    >
                      Close
                    </motion.button>
                    <motion.a
                      href="/settings/connections"
                      className="px-4 py-2 rounded-lg bg-purple-500 text-white text-sm hover:bg-purple-600 inline-flex items-center gap-2"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="i-ph:gear" />
                      Go to Settings
                    </motion.a>
                  </div>
                </div>
              </Dialog.Content>
            </motion.div>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999]" />
        <div className="fixed inset-0 flex items-center justify-center z-[9999]">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="w-[90vw] md:w-[500px]"
          >
            <Dialog.Content
              className="bg-white dark:bg-bolt-elements-background-depth-1 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark shadow-xl"
              aria-describedby="push-dialog-description"
            >
              <div className="p-6">
                <div className="flex items-center gap-4 mb-6">
                  <motion.div
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.1 }}
                    className="w-10 h-10 rounded-xl bg-bolt-elements-background-depth-3 flex items-center justify-center text-purple-500"
                  >
                    <div className="i-ph:github-logo w-5 h-5" />
                  </motion.div>
                  <div>
                    <Dialog.Title className="text-lg font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark">
                      Push to GitHub
                    </Dialog.Title>
                    <p
                      id="push-dialog-description"
                      className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark"
                    >
                      Push your code to a new or existing GitHub repository
                    </p>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      onClick={handleClose}
                      className="ml-auto p-2 rounded-lg transition-all duration-200 ease-in-out bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary dark:text-bolt-elements-textTertiary-dark dark:hover:text-bolt-elements-textPrimary-dark hover:bg-bolt-elements-background-depth-2 dark:hover:bg-bolt-elements-background-depth-3 focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColor dark:focus:ring-bolt-elements-borderColor-dark"
                    >
                      <span className="i-ph:x block w-5 h-5" aria-hidden="true" />
                      <span className="sr-only">Close dialog</span>
                    </button>
                  </Dialog.Close>
                </div>

                <div className="flex items-center gap-3 mb-6 p-4 bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark">
                  <div className="relative">
                    <img src={user.avatar_url} alt={user.login} className="w-10 h-10 rounded-full" />
                    <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center text-white">
                      <div className="i-ph:github-logo w-3 h-3" />
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark">
                      {user.name || user.login}
                    </p>
                    <p className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark">
                      @{user.login}
                    </p>
                  </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* Repo Combobox - ModelSelector pattern */}
                  <div className="space-y-2" ref={repoDropdownRef}>
                    <label
                      htmlFor="repoName"
                      className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark"
                    >
                      Repository Name
                    </label>
                    <div className="relative">
                      <input
                        id="repoName"
                        type="text"
                        value={repoSearchQuery}
                        onChange={(e) => {
                          setRepoSearchQuery(e.target.value);
                          setIsRepoDropdownOpen(true);

                          if (e.target.value === '') {
                            setRepoName('');
                          }
                        }}
                        onFocus={() => setIsRepoDropdownOpen(true)}
                        onBlur={handleRepoInputBlur}
                        onKeyDownCapture={handleRepoKeyDown}
                        placeholder="Select or search repository"
                        className="w-full pl-10 px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark placeholder-bolt-elements-textTertiary dark:placeholder-bolt-elements-textTertiary-dark focus:outline-none focus:ring-2 focus:ring-purple-500"
                        required
                        autoComplete="off"
                        readOnly={false}
                      />
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary dark:text-bolt-elements-textTertiary-dark">
                        <span className="i-ph:git-branch w-4 h-4" />
                      </div>
                      {isRepoDropdownOpen && (
                        <div className="absolute z-20 w-full mt-1 py-1 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg max-h-60 overflow-y-auto">
                          {filteredReposList.length === 0 && !showCreateNewRepo ? (
                            <div className="px-3 py-2 text-sm text-bolt-elements-textTertiary">
                              No repositories found.
                            </div>
                          ) : (
                            <>
                              {filteredReposList.map((repo, idx) => (
                                <div
                                  ref={(el) => (repoOptionsRef.current[idx] = el)}
                                  key={repo.full_name}
                                  className={classNames(
                                    'px-3 py-2 text-sm cursor-pointer',
                                    'hover:bg-bolt-elements-background-depth-3',
                                    'text-bolt-elements-textPrimary',
                                    'outline-none',
                                    repoName === repo.name || focusedRepoIndex === idx
                                      ? 'bg-bolt-elements-background-depth-2'
                                      : undefined,
                                    focusedRepoIndex === idx ? 'ring-1 ring-inset ring-bolt-elements-focus' : undefined,
                                  )}
                                  onClick={() => {
                                    setRepoName(repo.name);
                                    setRepoSearchQuery(repo.name);
                                    setIsRepoDropdownOpen(false);
                                  }}
                                  tabIndex={focusedRepoIndex === idx ? 0 : -1}
                                >
                                  {repo.name}
                                </div>
                              ))}
                              {showCreateNewRepo && (
                                <div
                                  className={classNames(
                                    'px-3 py-2 text-sm text-blue-600 cursor-pointer',
                                    focusedRepoIndex === filteredReposList.length
                                      ? 'bg-bolt-elements-background-depth-2 ring-1 ring-inset ring-bolt-elements-focus'
                                      : undefined,
                                  )}
                                  onClick={() => {
                                    setRepoName(repoSearchQuery.trim());
                                    setRepoSearchQuery(repoSearchQuery.trim());
                                    setIsRepoDropdownOpen(false);
                                  }}
                                  tabIndex={focusedRepoIndex === filteredReposList.length ? 0 : -1}
                                >
                                  Create new repository: <b>{repoSearchQuery.trim()}</b>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Branch Combobox */}
                  <div className="space-y-2" ref={branchDropdownRef}>
                    <label
                      htmlFor="branchName"
                      className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark"
                    >
                      Branch Name
                    </label>
                    <div className="relative">
                      <input
                        id="branchName"
                        type="text"
                        value={branchSearchQuery}
                        onChange={(e) => {
                          setBranchSearchQuery(e.target.value);
                          setIsBranchDropdownOpen(true);

                          if (e.target.value === '') {
                            setBranchName('');
                          }
                        }}
                        onFocus={() => setIsBranchDropdownOpen(true)}
                        onBlur={handleBranchInputBlur}
                        onKeyDownCapture={handleBranchKeyDownCapture}
                        placeholder={repoName ? 'Select or create branch' : 'Select a repository first'}
                        className="w-full pl-10 px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark placeholder-bolt-elements-textTertiary dark:placeholder-bolt-elements-textTertiary-dark focus:outline-none focus:ring-2 focus:ring-purple-500"
                        required
                        autoComplete="off"
                        readOnly={!repoName}
                        disabled={!repoName}
                      />
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary dark:text-bolt-elements-textTertiary-dark">
                        <span className="i-ph:git-branch w-4 h-4" />
                      </div>
                      {isBranchDropdownOpen && repoName && (
                        <div className="absolute z-20 w-full mt-1 py-1 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg max-h-60 overflow-y-auto">
                          {filteredBranchesList.length === 0 && !showCreateNewBranch ? (
                            <div className="px-3 py-2 text-sm text-bolt-elements-textTertiary">No branches found.</div>
                          ) : (
                            <>
                              {filteredBranchesList.map((branch, idx) => (
                                <div
                                  ref={(el) => (branchOptionsRef.current[idx] = el)}
                                  key={branch}
                                  className={classNames(
                                    'px-3 py-2 text-sm cursor-pointer',
                                    'hover:bg-bolt-elements-background-depth-3',
                                    'text-bolt-elements-textPrimary',
                                    'outline-none',
                                    branchName === branch || focusedBranchIndex === idx
                                      ? 'bg-bolt-elements-background-depth-2'
                                      : undefined,
                                    focusedBranchIndex === idx
                                      ? 'ring-1 ring-inset ring-bolt-elements-focus'
                                      : undefined,
                                  )}
                                  onClick={() => {
                                    setBranchName(branch);
                                    setBranchSearchQuery(branch);
                                    setIsBranchDropdownOpen(false);
                                  }}
                                  tabIndex={focusedBranchIndex === idx ? 0 : -1}
                                >
                                  {branch}
                                </div>
                              ))}
                              {showCreateNewBranch && (
                                <div
                                  className={classNames(
                                    'px-3 py-2 text-sm text-blue-600 cursor-pointer',
                                    focusedBranchIndex === filteredBranchesList.length
                                      ? 'bg-bolt-elements-background-depth-2 ring-1 ring-inset ring-bolt-elements-focus'
                                      : undefined,
                                  )}
                                  onClick={() => {
                                    setBranchName(branchSearchQuery.trim());
                                    setBranchSearchQuery(branchSearchQuery.trim());
                                    setIsBranchDropdownOpen(false);
                                  }}
                                  tabIndex={focusedBranchIndex === filteredBranchesList.length ? 0 : -1}
                                >
                                  Create new branch: <b>{branchSearchQuery.trim()}</b>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="p-3 bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="private"
                        checked={isPrivate}
                        onChange={(e) => setIsPrivate(e.target.checked)}
                        className="rounded border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark text-purple-500 focus:ring-purple-500 dark:bg-bolt-elements-background-depth-3"
                      />
                      <label
                        htmlFor="private"
                        className="text-sm text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark"
                      >
                        Make repository private
                      </label>
                    </div>
                    <p className="text-xs text-bolt-elements-textTertiary dark:text-bolt-elements-textTertiary-dark mt-2 ml-6">
                      Private repositories are only visible to you and people you share them with
                    </p>
                  </div>

                  {errorMessage && <div className="text-red-600 text-sm mb-2">{errorMessage}</div>}

                  <div className="pt-4 flex gap-2">
                    <motion.button
                      type="button"
                      onClick={handleClose}
                      className="px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 text-sm border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      Cancel
                    </motion.button>
                    <motion.button
                      type="submit"
                      disabled={isLoading}
                      className={classNames(
                        'flex-1 px-4 py-2 bg-purple-500 text-white rounded-lg hover:bg-purple-600 text-sm inline-flex items-center justify-center gap-2',
                        isLoading ? 'opacity-50 cursor-not-allowed' : '',
                      )}
                      whileHover={!isLoading ? { scale: 1.02 } : {}}
                      whileTap={!isLoading ? { scale: 0.98 } : {}}
                    >
                      {isLoading ? (
                        <>
                          <div className="i-ph:spinner-gap animate-spin w-4 h-4" />
                          Pushing...
                        </>
                      ) : (
                        <>
                          <div className="i-ph:github-logo w-4 h-4" />
                          Push to GitHub
                        </>
                      )}
                    </motion.button>
                  </div>
                </form>
              </div>
            </Dialog.Content>
          </motion.div>
        </div>
      </Dialog.Portal>
      {/* Confirmation Dialog */}
      <ConfirmationDialog
        isOpen={showConfirmDialog}
        onClose={() => setShowConfirmDialog(false)}
        onConfirm={handleConfirmProceed}
        title="Confirm Push"
        description={confirmDialogMessage}
        confirmLabel="Proceed"
        cancelLabel="Cancel"
        isLoading={isLoading}
      />
      {/* Commit Message Dialog */}
      <Dialog.Root open={showCommitDialog} onOpenChange={setShowCommitDialog}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999]" />
          <div className="fixed inset-0 flex items-center justify-center z-[9999]">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="w-[90vw] md:w-[400px]"
            >
              <Dialog.Content className="bg-white dark:bg-bolt-elements-background-depth-1 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark shadow-xl p-6">
                <h3 className="text-lg font-medium mb-2">Commit Message</h3>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleCommitProceed();
                  }}
                >
                  <input
                    type="text"
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    className="w-full px-3 py-2 rounded border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark mb-4"
                    placeholder="Initial commit"
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="px-4 py-2 rounded bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary border border-bolt-elements-borderColor"
                      onClick={() => setShowCommitDialog(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-2 rounded bg-purple-500 text-white hover:bg-purple-600"
                      disabled={isLoading || !commitMessage.trim()}
                    >
                      {isLoading ? 'Pushing...' : 'Push'}
                    </button>
                  </div>
                </form>
              </Dialog.Content>
            </motion.div>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    </Dialog.Root>
  );
}
