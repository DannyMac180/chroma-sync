import { TFile, Vault, FileStats } from 'obsidian';
import { minimatch } from 'minimatch';

export interface FileMetadata {
	path: string;
	hash: string;
	mtime: number;
	size: number;
}

export interface FileState {
	files: Record<string, FileMetadata>;
	lastSync: number;
	version: number;
	partialSync?: {
		failedFiles: string[];
		retryCount: Record<string, number>;
		lastFailure: number;
	};
	chromaState?: {
		lastVerification: number;
		verificationStatus: 'pending' | 'verified' | 'inconsistent';
		inconsistencies?: {
			missingInChroma: string[];
			extraInChroma: string[];
			lastChecked: number;
		};
	};
}

export interface DeltaAction {
	action: 'upsert' | 'delete';
	id: string;
	path?: string;
	text?: string;
	metadata?: Record<string, any>;
}

export interface DeltaPlan {
	actions: DeltaAction[];
	stats: {
		added: number;
		updated: number;
		deleted: number;
		unchanged: number;
	};
}

export class DeltaEngine {
	private vault: Vault;
	private includeGlobs: string[];
	private excludeGlobs: string[];

	constructor(vault: Vault, includeGlobs: string[] = ['**/*.md'], excludeGlobs: string[] = ['**/.obsidian/**']) {
		this.vault = vault;
		this.includeGlobs = includeGlobs;
		this.excludeGlobs = excludeGlobs;
	}

	public updateGlobs(includeGlobs: string[], excludeGlobs: string[]): void {
		this.includeGlobs = includeGlobs;
		this.excludeGlobs = excludeGlobs;
	}

	/**
	 * Check if a file path should be included based on glob patterns
	 */
	private shouldIncludeFile(path: string): boolean {
		// Check exclude patterns first
		for (const exclude of this.excludeGlobs) {
			if (minimatch(path, exclude)) {
				return false;
			}
		}

		// Check include patterns
		for (const include of this.includeGlobs) {
			if (minimatch(path, include)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Generate a SHA-256 hash of file content using Web Crypto API
	 */
	private async getFileHash(file: TFile): Promise<string> {
		const content = await this.vault.read(file);
		const encoder = new TextEncoder();
		const data = encoder.encode(content);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Get current metadata for a file
	 */
	private async getFileMetadata(file: TFile): Promise<FileMetadata> {
		const hash = await this.getFileHash(file);
		const stats = file.stat;
		
		return {
			path: file.path,
			hash,
			mtime: stats.mtime,
			size: stats.size,
		};
	}

	/**
	 * Scan the vault and return current state of all included files
	 */
	public async scanVault(): Promise<Record<string, FileMetadata>> {
		const allFiles = this.vault.getFiles();
		const includedFiles = allFiles.filter(file => this.shouldIncludeFile(file.path));
		const fileState: Record<string, FileMetadata> = {};

		for (const file of includedFiles) {
			try {
				const metadata = await this.getFileMetadata(file);
				fileState[file.path] = metadata;
			} catch (error) {
				console.warn(`Failed to process file ${file.path}:`, error);
			}
		}

		return fileState;
	}

	/**
	 * Compare current vault state against previous state and generate delta plan
	 */
	public async generateDeltaPlan(previousState: FileState | null): Promise<DeltaPlan> {
		const currentFiles = await this.scanVault();
		const previousFiles = previousState?.files || {};
		
		const actions: DeltaAction[] = [];
		const stats = {
			added: 0,
			updated: 0,
			deleted: 0,
			unchanged: 0,
		};

		// Find additions and updates
		for (const [path, currentMeta] of Object.entries(currentFiles)) {
			const previousMeta = previousFiles[path];
			
			if (!previousMeta) {
				// New file
				const file = this.vault.getAbstractFileByPath(path) as TFile;
				const content = await this.vault.read(file);
				
				actions.push({
					action: 'upsert',
					id: this.getDocumentId(path),
					path,
					text: content,
					metadata: {
						path,
						mtime: currentMeta.mtime,
						size: currentMeta.size,
						type: 'file',
						extension: file.extension,
					},
				});
				stats.added++;
			} else if (currentMeta.hash !== previousMeta.hash) {
				// Updated file
				const file = this.vault.getAbstractFileByPath(path) as TFile;
				const content = await this.vault.read(file);
				
				actions.push({
					action: 'upsert',
					id: this.getDocumentId(path),
					path,
					text: content,
					metadata: {
						path,
						mtime: currentMeta.mtime,
						size: currentMeta.size,
						type: 'file',
						extension: file.extension,
					},
				});
				stats.updated++;
			} else {
				// Unchanged file
				stats.unchanged++;
			}
		}

		// Find deletions
		for (const [path] of Object.entries(previousFiles)) {
			if (!currentFiles[path]) {
				actions.push({
					action: 'delete',
					id: this.getDocumentId(path),
				});
				stats.deleted++;
			}
		}

		return {
			actions,
			stats,
		};
	}

	/**
	 * Generate a stable document ID from the file path
	 */
	private getDocumentId(path: string): string {
		// Use the vault-relative path as the stable ID
		// Replace path separators and special chars to ensure valid Chroma ID
		return path.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '_');
	}

	/**
	 * Create a new file state from current vault scan
	 */
	public async createCurrentState(): Promise<FileState> {
		const files = await this.scanVault();
		return {
			files,
			lastSync: Date.now(),
			version: 1,
		};
	}

	/**
	 * Mark files as failed in partial sync tracking
	 */
	public markFilesFailed(state: FileState, failedFiles: string[]): FileState {
		const now = Date.now();
		const currentPartialSync = state.partialSync || {
			failedFiles: [],
			retryCount: {},
			lastFailure: now
		};

		const updatedFailedFiles = [...new Set([...currentPartialSync.failedFiles, ...failedFiles])];
		const updatedRetryCount = { ...currentPartialSync.retryCount };

		// Increment retry count for each failed file
		for (const file of failedFiles) {
			updatedRetryCount[file] = (updatedRetryCount[file] || 0) + 1;
		}

		return {
			...state,
			partialSync: {
				failedFiles: updatedFailedFiles,
				retryCount: updatedRetryCount,
				lastFailure: now
			}
		};
	}

	/**
	 * Remove files from failed tracking after successful processing
	 */
	public markFilesSucceeded(state: FileState, succeededFiles: string[]): FileState {
		if (!state.partialSync) {
			return state;
		}

		const remainingFailedFiles = state.partialSync.failedFiles.filter(
			file => !succeededFiles.includes(file)
		);

		const updatedRetryCount = { ...state.partialSync.retryCount };
		for (const file of succeededFiles) {
			delete updatedRetryCount[file];
		}

		return {
			...state,
			partialSync: remainingFailedFiles.length > 0 ? {
				...state.partialSync,
				failedFiles: remainingFailedFiles,
				retryCount: updatedRetryCount
			} : undefined
		};
	}

	/**
	 * Get files that should be retried (failed files with retry count < MAX_RETRIES)
	 */
	public getRetryableFiles(state: FileState, maxRetries: number = 3): string[] {
		if (!state.partialSync) {
			return [];
		}

		return state.partialSync.failedFiles.filter(file => {
			const retryCount = state.partialSync!.retryCount[file] || 0;
			return retryCount < maxRetries;
		});
	}

	/**
	 * Update Chroma verification state
	 */
	public updateVerificationState(
		state: FileState,
		verificationStatus: 'pending' | 'verified' | 'inconsistent',
		inconsistencies?: { missingInChroma: string[]; extraInChroma: string[] }
	): FileState {
		const now = Date.now();
		
		return {
			...state,
			chromaState: {
				lastVerification: now,
				verificationStatus,
				inconsistencies: inconsistencies ? {
					...inconsistencies,
					lastChecked: now
				} : undefined
			}
		};
	}

	/**
	 * Check if verification is needed (daily or never verified)
	 */
	public needsVerification(state: FileState): boolean {
		if (!state.chromaState) {
			return true; // Never verified
		}

		const hoursSinceVerification = (Date.now() - state.chromaState.lastVerification) / (1000 * 60 * 60);
		return hoursSinceVerification >= 24; // Daily verification
	}

	/**
	 * Check if two file states are equivalent (for testing)
	 */
	public static areStatesEqual(state1: FileState, state2: FileState): boolean {
		const paths1 = Object.keys(state1.files).sort();
		const paths2 = Object.keys(state2.files).sort();

		if (paths1.length !== paths2.length) {
			return false;
		}

		for (let i = 0; i < paths1.length; i++) {
			if (paths1[i] !== paths2[i]) {
				return false;
			}

			const file1 = state1.files[paths1[i]];
			const file2 = state2.files[paths1[i]];

			if (file1.hash !== file2.hash || file1.mtime !== file2.mtime) {
				return false;
			}
		}

		return true;
	}
}
