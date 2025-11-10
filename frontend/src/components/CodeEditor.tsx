import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import {
  File,
  Folder,
  FolderOpen,
  Save,
  RefreshCw,
  Terminal as TerminalIcon,
  ChevronRight,
  ChevronDown,
  FileCode,
  FilePlus,
  FolderPlus,
  Trash2,
  X,
  Sparkles,
} from 'lucide-react';
import { filesApi, type FileTreeNode } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';
import { Terminal } from './Terminal';

interface CodeEditorProps {
  projectId: string;
  fileToOpen?: string | null;
  onFileOpened?: () => void;
}

interface OpenFile {
  path: string;
  content: string;
  isDirty: boolean;
}

export function CodeEditor({ projectId, fileToOpen, onFileOpened }: CodeEditorProps) {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['/']));
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [showNewFileModal, setShowNewFileModal] = useState(false);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [hasSelection, setHasSelection] = useState(false);
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  const queryClient = useQueryClient();

  // Customize the ScoutOS widget: hide expand button and inject close button
  useEffect(() => {
    if (!aiPanelOpen) return;

    const customizeWidget = () => {
      const copilot = document.querySelector('#dagster-ai-panel scout-copilot');
      if (!copilot?.shadowRoot) {
        // Shadow root not ready, try again
        setTimeout(customizeWidget, 100);
        return;
      }

      // Find and hide the expand/fullscreen button
      const expandButton = copilot.shadowRoot.querySelector('[title*="xpand"]') ||
                          copilot.shadowRoot.querySelector('[aria-label*="xpand"]') ||
                          copilot.shadowRoot.querySelector('button[class*="expand"]') ||
                          copilot.shadowRoot.querySelector('button[class*="fullscreen"]') ||
                          copilot.shadowRoot.querySelector('button[class*="Expand"]') ||
                          copilot.shadowRoot.querySelector('button[class*="Fullscreen"]');

      if (expandButton && expandButton instanceof HTMLElement) {
        expandButton.style.display = 'none';
        console.log('✅ Hidden expand button');
      }

      // Try to inject our close button into the widget's header
      const header = copilot.shadowRoot.querySelector('header') ||
                    copilot.shadowRoot.querySelector('[class*="header"]') ||
                    copilot.shadowRoot.querySelector('[class*="Header"]');

      if (header && !header.querySelector('#custom-close-btn')) {
        const closeBtn = document.createElement('button');
        closeBtn.id = 'custom-close-btn';
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = `
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          background: none;
          border: none;
          font-size: 24px;
          color: #9ca3af;
          cursor: pointer;
          padding: 4px 8px;
          line-height: 1;
        `;
        closeBtn.onmouseover = () => { closeBtn.style.color = '#4b5563'; };
        closeBtn.onmouseout = () => { closeBtn.style.color = '#9ca3af'; };
        closeBtn.onclick = () => setAiPanelOpen(false);

        header.style.position = 'relative';
        header.appendChild(closeBtn);
        console.log('✅ Injected close button into widget header');
      }
    };

    // Initial customization
    setTimeout(customizeWidget, 500);

    // Keep trying to hide expand button if it appears
    const interval = setInterval(() => {
      const copilot = document.querySelector('#dagster-ai-panel scout-copilot');
      if (copilot?.shadowRoot) {
        const expandButton = copilot.shadowRoot.querySelector('[title*="xpand"]') ||
                            copilot.shadowRoot.querySelector('[aria-label*="xpand"]') ||
                            copilot.shadowRoot.querySelector('button[class*="expand"]') ||
                            copilot.shadowRoot.querySelector('button[class*="fullscreen"]') ||
                            copilot.shadowRoot.querySelector('button[class*="Expand"]') ||
                            copilot.shadowRoot.querySelector('button[class*="Fullscreen"]');
        if (expandButton && expandButton instanceof HTMLElement && expandButton.style.display !== 'none') {
          expandButton.style.display = 'none';
        }
      }
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [aiPanelOpen]);

  // Fetch file tree
  const { data: fileTree, refetch: refetchFileTree } = useQuery({
    queryKey: ['files', projectId],
    queryFn: () => filesApi.list(projectId),
  });

  // Read file mutation
  const readFileMutation = useMutation({
    mutationFn: ({ projectId, filePath }: { projectId: string; filePath: string }) =>
      filesApi.read(projectId, filePath),
    onSuccess: (data, variables) => {
      if (data.is_binary) {
        alert('Cannot open binary file');
        return;
      }

      // Check if file is already open
      const existingFile = openFiles.find((f) => f.path === variables.filePath);
      if (existingFile) {
        setActiveFilePath(variables.filePath);
        return;
      }

      // Add to open files
      setOpenFiles((prev) => [
        ...prev,
        {
          path: variables.filePath,
          content: data.content || '',
          isDirty: false,
        },
      ]);
      setActiveFilePath(variables.filePath);
    },
  });

  // Write file mutation
  const writeFileMutation = useMutation({
    mutationFn: ({
      projectId,
      filePath,
      content,
    }: {
      projectId: string;
      filePath: string;
      content: string;
    }) => filesApi.write(projectId, filePath, content),
    onSuccess: (_, variables) => {
      // Mark file as clean
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === variables.filePath ? { ...f, isDirty: false } : f))
      );
      refetchFileTree();
    },
  });

  // Handle external file open requests
  useEffect(() => {
    if (fileToOpen && projectId) {
      // Parse file path and line number if present (e.g., "path/file.yml:4")
      const [filePath, lineNumberStr] = fileToOpen.split(':');
      const lineNumber = lineNumberStr ? parseInt(lineNumberStr, 10) : undefined;

      readFileMutation.mutate(
        { projectId, filePath },
        {
          onSuccess: () => {
            // After file is loaded, scroll to line number if specified
            if (lineNumber && editorInstance) {
              setTimeout(() => {
                editorInstance.revealLineInCenter(lineNumber);
                editorInstance.setPosition({ lineNumber, column: 1 });
              }, 100);
            }
          }
        }
      );
      onFileOpened?.();
    }
  }, [fileToOpen, projectId, editorInstance]);


  // Create file mutation
  const createFileMutation = useMutation({
    mutationFn: ({ projectId, filePath, content }: { projectId: string; filePath: string; content: string }) =>
      filesApi.write(projectId, filePath, content),
    onSuccess: () => {
      refetchFileTree();
      setShowNewFileModal(false);
      setNewFileName('');
    },
  });

  // Create folder mutation
  const createFolderMutation = useMutation({
    mutationFn: ({ projectId, dirPath }: { projectId: string; dirPath: string }) =>
      filesApi.createDirectory(projectId, dirPath),
    onSuccess: () => {
      refetchFileTree();
      setShowNewFolderModal(false);
      setNewFolderName('');
    },
  });

  // Delete file mutation
  const deleteFileMutation = useMutation({
    mutationFn: ({ projectId, filePath }: { projectId: string; filePath: string }) =>
      filesApi.delete(projectId, filePath),
    onSuccess: (_, variables) => {
      // Close the file if it's open
      handleCloseFile(variables.filePath);
      refetchFileTree();
    },
  });

  // Delete directory mutation
  const deleteDirectoryMutation = useMutation({
    mutationFn: ({ projectId, dirPath }: { projectId: string; dirPath: string }) =>
      filesApi.deleteDirectory(projectId, dirPath),
    onSuccess: (_, variables) => {
      // Close any files in that directory
      const dirPrefix = variables.dirPath + '/';
      openFiles.forEach(file => {
        if (file.path.startsWith(dirPrefix) || file.path === variables.dirPath) {
          handleCloseFile(file.path);
        }
      });
      refetchFileTree();
    },
  });

  const activeFile = openFiles.find((f) => f.path === activeFilePath);

  const handleFileClick = (filePath: string) => {
    readFileMutation.mutate({ projectId, filePath });
  };

  const handleDirToggle = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    if (!activeFilePath || value === undefined) return;

    setOpenFiles((prev) =>
      prev.map((f) => (f.path === activeFilePath ? { ...f, content: value, isDirty: true } : f))
    );
  };

  const handleSaveFile = () => {
    if (!activeFile) return;

    writeFileMutation.mutate({
      projectId,
      filePath: activeFile.path,
      content: activeFile.content,
    });
  };

  const handleCloseFile = (filePath: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.path !== filePath));
    if (activeFilePath === filePath) {
      const remainingFiles = openFiles.filter((f) => f.path !== filePath);
      setActiveFilePath(remainingFiles.length > 0 ? remainingFiles[0].path : null);
    }
  };

  const handleCreateFile = () => {
    if (!newFileName.trim()) return;

    createFileMutation.mutate({
      projectId,
      filePath: newFileName,
      content: '',
    });
  };

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;

    createFolderMutation.mutate({
      projectId,
      dirPath: newFolderName,
    });
  };

  const handleDeleteFile = (filePath: string) => {
    const fileName = filePath.split('/').pop();
    if (!window.confirm(`Are you sure you want to delete "${fileName}"?`)) {
      return;
    }

    deleteFileMutation.mutate({
      projectId,
      filePath,
    });
  };

  const handleDeleteDirectory = (dirPath: string) => {
    const dirName = dirPath.split('/').pop();
    if (!window.confirm(`Are you sure you want to delete the folder "${dirName}" and ALL its contents? This cannot be undone.`)) {
      return;
    }

    deleteDirectoryMutation.mutate({
      projectId,
      dirPath,
    });
  };

  const handleAskDagsterAI = () => {
    if (!editorInstance || !activeFile) return;

    const selection = editorInstance.getSelection();
    if (!selection) return;

    const selectedText = editorInstance.getModel()?.getValueInRange(selection);
    if (!selectedText || selectedText.trim() === '') {
      alert('Please select some code first');
      return;
    }

    // Get file extension for context
    const fileExt = activeFile.path.split('.').pop() || 'code';

    // Format a concise prompt - just send the code with minimal context
    const prompt = `Explain this code:\n\`\`\`${fileExt}\n${selectedText}\n\`\`\``;

    // Open the AI panel
    setAiPanelOpen(true);

    // Wait for React to render the panel, then find and submit to copilot
    const findAndSubmit = (attempt = 0) => {
      const copilotElement = document.querySelector('#dagster-ai-panel scout-copilot') as any;

      if (!copilotElement) {
        if (attempt < 20) {
          // Panel not rendered yet, retry after 100ms (up to 2 seconds total)
          setTimeout(() => findAndSubmit(attempt + 1), 100);
        } else {
          console.error('Dagster AI panel not found');
          navigator.clipboard.writeText(prompt);
          alert('✨ Code copied to clipboard! Paste it into the Dagster AI chat.');
        }
        return;
      }

      // Function to submit the prompt using the official API
      const submitPrompt = (submitAttempt = 0) => {
        if (typeof copilotElement.handleSubmit === 'function') {
          try {
            copilotElement.handleSubmit({
              detail: { user_input_value: prompt }
            });
          } catch (err) {
            console.error('Failed to submit prompt:', err);
            navigator.clipboard.writeText(prompt);
            alert('✨ Code copied to clipboard! Paste it into the Dagster AI chat.');
          }
        } else if (submitAttempt < 10) {
          // handleSubmit not available yet, retry after 200ms
          setTimeout(() => submitPrompt(submitAttempt + 1), 200);
        } else {
          // Fallback to clipboard after 2 seconds
          navigator.clipboard.writeText(prompt);
          alert('✨ Code copied to clipboard! Paste it into the Dagster AI chat.');
        }
      };

      submitPrompt();
    };

    // Wait 300ms for React to render, then try to find and submit
    setTimeout(() => findAndSubmit(), 300);
  };

  const renderFileTree = (nodes: FileTreeNode[], parentPath: string = '') => {
    return nodes.map((node) => {
      const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
      const isExpanded = expandedDirs.has(fullPath);

      if (node.type === 'directory') {
        return (
          <div key={fullPath} className="select-none">
            <div
              className="flex items-center justify-between group px-2 py-1 hover:bg-gray-100"
            >
              <div
                className="flex items-center space-x-1 flex-1 cursor-pointer"
                onClick={() => handleDirToggle(fullPath)}
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3 text-gray-500" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-gray-500" />
                )}
                {isExpanded ? (
                  <FolderOpen className="w-4 h-4 text-blue-500" />
                ) : (
                  <Folder className="w-4 h-4 text-blue-500" />
                )}
                <span className="text-sm text-gray-700">{node.name}</span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteDirectory(fullPath);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 rounded transition-opacity"
                title="Delete folder and all contents"
              >
                <Trash2 className="w-3 h-3 text-red-600" />
              </button>
            </div>
            {isExpanded && node.children && (
              <div className="ml-4">{renderFileTree(node.children, fullPath)}</div>
            )}
          </div>
        );
      }

      return (
        <div
          key={fullPath}
          className={`flex items-center justify-between group px-2 py-1 ml-4 hover:bg-gray-100 ${
            activeFilePath === node.path ? 'bg-blue-50' : ''
          }`}
        >
          <div className="flex items-center space-x-1 flex-1 cursor-pointer" onClick={() => handleFileClick(node.path)}>
            <FileCode className="w-4 h-4 text-gray-400" />
            <span className="text-sm text-gray-700">{node.name}</span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteFile(node.path);
            }}
            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 rounded transition-opacity"
            title="Delete file"
          >
            <Trash2 className="w-3 h-3 text-red-600" />
          </button>
        </div>
      );
    });
  };

  const getLanguageFromPath = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      py: 'python',
      js: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      jsx: 'javascript',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
      sql: 'sql',
      sh: 'shell',
      bash: 'shell',
      html: 'html',
      css: 'css',
      txt: 'plaintext',
    };
    return languageMap[ext || ''] || 'plaintext';
  };

  return (
    <div className="flex h-full bg-white relative">
      {/* File Browser - Left Sidebar */}
      <div className="w-64 border-r border-gray-200 flex flex-col shrink-0" style={{ minWidth: '256px' }}>
        <div className="p-2 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">Files</span>
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setShowNewFileModal(true)}
              className="p-1 hover:bg-gray-100 rounded"
              title="New File"
            >
              <FilePlus className="w-4 h-4 text-gray-600" />
            </button>
            <button
              onClick={() => setShowNewFolderModal(true)}
              className="p-1 hover:bg-gray-100 rounded"
              title="New Folder"
            >
              <FolderPlus className="w-4 h-4 text-gray-600" />
            </button>
            <button
              onClick={() => refetchFileTree()}
              className="p-1 hover:bg-gray-100 rounded"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4 text-gray-600" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {fileTree && renderFileTree(fileTree.tree.children)}
        </div>
      </div>

      {/* Editor Area - Center */}
      <div className={`flex flex-col ${aiPanelOpen ? 'flex-1 min-w-0' : 'flex-1'}`}>
        {/* Open Files Tabs */}
        {openFiles.length > 0 && (
          <div className="flex items-center space-x-1 px-2 py-1 border-b border-gray-200 bg-gray-50 overflow-x-auto">
            {openFiles.map((file) => (
              <div
                key={file.path}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-t cursor-pointer ${
                  activeFilePath === file.path
                    ? 'bg-white border-t border-x border-gray-200'
                    : 'bg-gray-100 hover:bg-gray-200'
                }`}
                onClick={() => setActiveFilePath(file.path)}
              >
                <span className="text-xs text-gray-700">
                  {file.path.split('/').pop()}
                  {file.isDirty && '*'}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseFile(file.path);
                  }}
                  className="hover:text-gray-900"
                >
                  <span className="text-xs">×</span>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Editor Controls */}
        {activeFile && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
            <div className="flex items-center space-x-2">
              <FileCode className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-700">{activeFile.path}</span>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handleSaveFile}
                disabled={!activeFile.isDirty || writeFileMutation.isPending}
                className="flex items-center space-x-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700"
              >
                <Save className="w-4 h-4" />
                <span>Save</span>
              </button>
              <button
                onClick={() => {
                  if (hasSelection) {
                    handleAskDagsterAI();
                  } else {
                    setAiPanelOpen(!aiPanelOpen);
                  }
                }}
                className={`flex items-center space-x-2 px-4 py-2 text-sm border rounded-md ${
                  aiPanelOpen
                    ? 'border-purple-500 bg-purple-100 text-purple-700'
                    : 'border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100'
                }`}
                title={
                  hasSelection
                    ? "Ask Dagster AI about selected code"
                    : aiPanelOpen
                    ? "Close AI panel"
                    : "Open AI panel"
                }
              >
                <Sparkles className="w-4 h-4" />
                <span>{aiPanelOpen ? 'Dagster AI' : 'Ask Dagster AI'}</span>
              </button>
              <button
                onClick={() => setTerminalOpen(!terminalOpen)}
                className="flex items-center space-x-2 px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-100"
              >
                <TerminalIcon className="w-4 h-4" />
                <span>Terminal</span>
              </button>
            </div>
          </div>
        )}

        {/* Monaco Editor */}
        <div className={terminalOpen ? 'flex-1 min-h-0' : 'flex-1'}>
          {activeFile ? (
            <Editor
              height="100%"
              language={getLanguageFromPath(activeFile.path)}
              value={activeFile.content}
              onChange={handleEditorChange}
              onMount={(editor, _monaco) => {
                // Store editor instance
                setEditorInstance(editor);

                // Track selection changes to enable/disable the AI button
                editor.onDidChangeCursorSelection(() => {
                  const selection = editor.getSelection();
                  if (selection) {
                    const selectedText = editor.getModel()?.getValueInRange(selection);
                    setHasSelection(!!selectedText && selectedText.trim() !== '');
                  } else {
                    setHasSelection(false);
                  }
                });
              }}
              theme="vs-light"
              options={{
                minimap: { enabled: true },
                fontSize: 14,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                insertSpaces: true,
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <FileCode className="w-12 h-12 mx-auto mb-2 text-gray-400" />
                <p className="text-sm">Select a file to edit</p>
              </div>
            </div>
          )}
        </div>

        {/* Terminal */}
        {terminalOpen && (
          <div className="border-t border-border flex flex-col flex-shrink-0" style={{ height: '40vh', minHeight: '300px', maxHeight: '50vh' }}>
            <div className="flex items-center space-x-2 px-4 py-2 bg-[#121926] border-b border-[#4B5565]">
              <TerminalIcon className="w-4 h-4 text-[#4F43DD]" />
              <span className="text-xs font-semibold text-[#F7F7FF]">Terminal</span>
            </div>
            <div className="flex-1 min-h-0">
              <Terminal projectId={projectId} />
            </div>
          </div>
        )}
      </div>

      {/* New File Modal */}
      {showNewFileModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Create New File</h3>
              <button
                onClick={() => {
                  setShowNewFileModal(false);
                  setNewFileName('');
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                File Path
              </label>
              <input
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateFile();
                  }
                }}
                placeholder="e.g., assets/my_asset.py or utils/helper.py"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <p className="mt-1 text-xs text-gray-500">
                Include the full path relative to project root
              </p>
            </div>
            <div className="flex justify-end space-x-2">
              <button
                onClick={() => {
                  setShowNewFileModal(false);
                  setNewFileName('');
                }}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateFile}
                disabled={!newFileName.trim() || createFileMutation.isPending}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createFileMutation.isPending ? 'Creating...' : 'Create File'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Folder Modal */}
      {showNewFolderModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Create New Folder</h3>
              <button
                onClick={() => {
                  setShowNewFolderModal(false);
                  setNewFolderName('');
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Folder Path
              </label>
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateFolder();
                  }
                }}
                placeholder="e.g., utils or data/raw"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <p className="mt-1 text-xs text-gray-500">
                Include the full path relative to project root
              </p>
            </div>
            <div className="flex justify-end space-x-2">
              <button
                onClick={() => {
                  setShowNewFolderModal(false);
                  setNewFolderName('');
                }}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || createFolderMutation.isPending}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createFolderMutation.isPending ? 'Creating...' : 'Create Folder'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dagster AI Panel - Right Sidebar */}
      {aiPanelOpen && (
        <div
          id="dagster-ai-panel"
          className="border-l border-gray-200 flex flex-col bg-white shrink-0"
          style={{
            width: '400px',
            minWidth: '400px',
            maxWidth: '400px',
            height: '100%',
            flexShrink: 0,
            flexGrow: 0,
            flexBasis: '400px'
          }}
        >
          <scout-copilot
            copilot_id="copilot_cm69wb08t000j0ds6rxdnung4"
            embedded="true"
            width="100%"
            height="100%"
          ></scout-copilot>
        </div>
      )}
    </div>
  );
}
