/**
 * Unit tests for Delta Engine
 */

import { DeltaEngine, FileState, FileMetadata } from '../src/delta';

// Mock Obsidian's Vault API
const mockVault: any = {
	files: new Map<string, { content: string; stats: { mtime: number; size: number } }>(),
	
	getFiles: jest.fn(() => {
		return Array.from(mockVault.files.keys()).map((path: string) => ({
			path,
			stat: mockVault.files.get(path)?.stats || { mtime: 0, size: 0 },
			extension: (path as string).split('.').pop() || '',
		}));
	}),
	
	read: jest.fn((file: { path: string }) => {
		return Promise.resolve(mockVault.files.get(file.path)?.content || '');
	}),
	
	getAbstractFileByPath: jest.fn((path: string) => ({
		path,
		stat: mockVault.files.get(path)?.stats || { mtime: 0, size: 0 },
		extension: (path as string).split('.').pop() || '',
	})),
};

// Helper to add files to mock vault
function addMockFile(path: string, content: string, mtime: number = Date.now()) {
	mockVault.files.set(path, {
		content,
		stats: { mtime, size: content.length }
	});
}

// Helper to remove files from mock vault
function removeMockFile(path: string) {
	mockVault.files.delete(path);
}

// Helper to clear mock vault
function clearMockVault() {
	mockVault.files.clear();
}

describe('DeltaEngine', () => {
	let deltaEngine: DeltaEngine;

	beforeEach(() => {
		clearMockVault();
		deltaEngine = new DeltaEngine(mockVault as any, ['**/*.md'], ['**/.obsidian/**']);
		jest.clearAllMocks();
	});

	describe('scanVault', () => {
		it('should include files matching include patterns', async () => {
			addMockFile('note1.md', '# Note 1', 1000);
			addMockFile('note2.md', '# Note 2', 2000);
			addMockFile('readme.txt', 'Not included', 3000);

			const state = await deltaEngine.scanVault();

			expect(Object.keys(state)).toEqual(['note1.md', 'note2.md']);
			expect(state['note1.md'].path).toBe('note1.md');
			expect(state['note1.md'].mtime).toBe(1000);
		});

		it('should exclude files matching exclude patterns', async () => {
			addMockFile('note.md', '# Note', 1000);
			addMockFile('.obsidian/workspace.json', '{}', 2000);
			addMockFile('.obsidian/plugins/plugin.js', 'code', 3000);

			const state = await deltaEngine.scanVault();

			expect(Object.keys(state)).toEqual(['note.md']);
		});

		it('should generate correct file hashes', async () => {
			addMockFile('note.md', '# Test Content', 1000);

			const state = await deltaEngine.scanVault();

			// Verify that hash is a 64-character hex string (SHA-256)
			expect(state['note.md'].hash).toMatch(/^[a-f0-9]{64}$/);
			expect(state['note.md'].hash).toBe('eb3ea244fc201b681f033362a20efb9f55ff3127f96e6f6c508d59553b8ce2cd');
		});
	});

	describe('generateDeltaPlan', () => {
		it('should detect new files (first run)', async () => {
			addMockFile('note1.md', '# Note 1', 1000);
			addMockFile('note2.md', '# Note 2', 2000);

			const plan = await deltaEngine.generateDeltaPlan(null);

			expect(plan.stats.added).toBe(2);
			expect(plan.stats.updated).toBe(0);
			expect(plan.stats.deleted).toBe(0);
			expect(plan.stats.unchanged).toBe(0);

			expect(plan.actions).toHaveLength(2);
			expect(plan.actions[0].action).toBe('upsert');
			expect(plan.actions[0].path).toBe('note1.md');
			expect(plan.actions[0].text).toBe('# Note 1');
		});

		it('should detect updated files', async () => {
			// Setup initial state
			addMockFile('note.md', '# Original Content', 1000);
			const originalState = await deltaEngine.createCurrentState();

			// Modify the file
			addMockFile('note.md', '# Updated Content', 2000);

			const plan = await deltaEngine.generateDeltaPlan(originalState);

			expect(plan.stats.added).toBe(0);
			expect(plan.stats.updated).toBe(1);
			expect(plan.stats.deleted).toBe(0);
			expect(plan.stats.unchanged).toBe(0);

			expect(plan.actions).toHaveLength(1);
			expect(plan.actions[0].action).toBe('upsert');
			expect(plan.actions[0].text).toBe('# Updated Content');
		});

		it('should detect deleted files', async () => {
			// Setup initial state
			addMockFile('note1.md', '# Note 1', 1000);
			addMockFile('note2.md', '# Note 2', 2000);
			const originalState = await deltaEngine.createCurrentState();

			// Remove one file
			removeMockFile('note2.md');

			const plan = await deltaEngine.generateDeltaPlan(originalState);

			expect(plan.stats.added).toBe(0);
			expect(plan.stats.updated).toBe(0);
			expect(plan.stats.deleted).toBe(1);
			expect(plan.stats.unchanged).toBe(1);

			const deleteAction = plan.actions.find(a => a.action === 'delete');
			expect(deleteAction).toBeDefined();
			expect(deleteAction?.id).toBe('note2.md');
		});

		it('should detect unchanged files', async () => {
			// Setup initial state
			addMockFile('note.md', '# Content', 1000);
			const originalState = await deltaEngine.createCurrentState();

			// No changes
			const plan = await deltaEngine.generateDeltaPlan(originalState);

			expect(plan.stats.added).toBe(0);
			expect(plan.stats.updated).toBe(0);
			expect(plan.stats.deleted).toBe(0);
			expect(plan.stats.unchanged).toBe(1);

			expect(plan.actions).toHaveLength(0);
		});

		it('should handle mixed changes', async () => {
			// Setup initial state
			addMockFile('unchanged.md', '# Unchanged', 1000);
			addMockFile('updated.md', '# Original', 2000);
			addMockFile('deleted.md', '# To Delete', 3000);
			const originalState = await deltaEngine.createCurrentState();

			// Make changes
			addMockFile('updated.md', '# Modified', 2500);
			removeMockFile('deleted.md');
			addMockFile('new.md', '# New File', 4000);

			const plan = await deltaEngine.generateDeltaPlan(originalState);

			expect(plan.stats.added).toBe(1);
			expect(plan.stats.updated).toBe(1);
			expect(plan.stats.deleted).toBe(1);
			expect(plan.stats.unchanged).toBe(1);

			expect(plan.actions).toHaveLength(3);

			const actions = plan.actions.reduce((acc, action) => {
				acc[action.action] = acc[action.action] || [];
				acc[action.action].push(action);
				return acc;
			}, {} as Record<string, any[]>);

			expect(actions.upsert).toHaveLength(2); // new + updated
			expect(actions.delete).toHaveLength(1);
		});
	});

	describe('updateGlobs', () => {
		it('should update include/exclude patterns', async () => {
			addMockFile('note.md', '# Note', 1000);
			addMockFile('document.txt', 'Text file', 2000);

			// Initially only includes .md files
			let state = await deltaEngine.scanVault();
			expect(Object.keys(state)).toEqual(['note.md']);

			// Update to include .txt files
			deltaEngine.updateGlobs(['**/*.md', '**/*.txt'], ['**/.obsidian/**']);
			state = await deltaEngine.scanVault();
			expect(Object.keys(state).sort()).toEqual(['document.txt', 'note.md']);
		});
	});

	describe('createCurrentState', () => {
		it('should create a valid file state', async () => {
			addMockFile('note.md', '# Test', 1000);
			
			const state = await deltaEngine.createCurrentState();

			expect(state.version).toBe(1);
			expect(state.lastSync).toBeGreaterThan(0);
			expect(state.files['note.md']).toBeDefined();
			expect(state.files['note.md'].path).toBe('note.md');
			expect(state.files['note.md'].mtime).toBe(1000);
		});
	});

	describe('areStatesEqual', () => {
		it('should return true for identical states', () => {
			const state1: FileState = {
				version: 1,
				lastSync: 1000,
				files: {
					'note.md': { path: 'note.md', hash: 'hash1', mtime: 1000, size: 100 }
				}
			};

			const state2: FileState = {
				version: 1,
				lastSync: 2000, // lastSync doesn't affect equality
				files: {
					'note.md': { path: 'note.md', hash: 'hash1', mtime: 1000, size: 100 }
				}
			};

			expect(DeltaEngine.areStatesEqual(state1, state2)).toBe(true);
		});

		it('should return false for different file counts', () => {
			const state1: FileState = {
				version: 1,
				lastSync: 1000,
				files: {
					'note1.md': { path: 'note1.md', hash: 'hash1', mtime: 1000, size: 100 }
				}
			};

			const state2: FileState = {
				version: 1,
				lastSync: 1000,
				files: {
					'note1.md': { path: 'note1.md', hash: 'hash1', mtime: 1000, size: 100 },
					'note2.md': { path: 'note2.md', hash: 'hash2', mtime: 2000, size: 200 }
				}
			};

			expect(DeltaEngine.areStatesEqual(state1, state2)).toBe(false);
		});

		it('should return false for different file hashes', () => {
			const state1: FileState = {
				version: 1,
				lastSync: 1000,
				files: {
					'note.md': { path: 'note.md', hash: 'hash1', mtime: 1000, size: 100 }
				}
			};

			const state2: FileState = {
				version: 1,
				lastSync: 1000,
				files: {
					'note.md': { path: 'note.md', hash: 'hash2', mtime: 1000, size: 100 }
				}
			};

			expect(DeltaEngine.areStatesEqual(state1, state2)).toBe(false);
		});
	});
});
