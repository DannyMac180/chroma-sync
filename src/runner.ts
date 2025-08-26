import { spawn, ChildProcess } from 'child_process';
import { Platform } from 'obsidian';
import { Notice } from 'obsidian';
import { join } from 'path';
import { ChromaSyncSettings } from './settings';
import { DeltaAction, FileState } from './delta';
import { SyncStateManager } from './sync-state';

class AbortError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AbortError';
	}
}

export interface ChromaConfig {
	host: string;
	port: number;
	ssl: boolean;
	token_header: string;
	token: string;
	tenant: string;
	database: string;
	collection: string;
}

export interface ProgressUpdate {
	type: 'progress' | 'complete' | 'error';
	message: string;
	processed?: number;
	total?: number;
	error?: string;
}

export interface SyncResult {
	success: boolean;
	processed: number;
	errors: string[];
	duration: number;
}

export interface VerificationResult {
	verified: boolean;
	missing_in_chroma: string[];
	extra_in_chroma: string[];
	hash_mismatches: Array<{path: string; local_hash: string; chroma_hash: string}>;
	stats: {
		total_local_files: number;
		total_chroma_documents: number;
		collection_count: number;
		missing_count: number;
		extra_count: number;
		mismatch_count: number;
	};
}

export class ChromaRunner {
	private settings: ChromaSyncSettings;
	private pluginDataPath: string;
	private onProgress: (update: ProgressUpdate) => void;
	private stateManager: SyncStateManager;
	private currentProcess: ChildProcess | null = null;

	constructor(
		settings: ChromaSyncSettings,
		pluginDataPath: string,
		onProgress: (update: ProgressUpdate) => void = () => {}
	) {
		this.settings = settings;
		this.pluginDataPath = pluginDataPath;
		this.onProgress = onProgress;
		this.stateManager = new SyncStateManager(pluginDataPath);
	}

	/**
	 * Check if Python is available and create virtual environment if needed
	 */
	public async ensurePythonEnvironment(): Promise<boolean> {
		try {
			const pythonPath = this.settings.pythonPath;
			const venvPath = join(this.pluginDataPath, 'python', '.venv');
			
			// Check if venv exists
			const venvExists = await this.checkVenvExists(venvPath);
			
			if (!venvExists) {
				this.onProgress({ type: 'progress', message: 'Creating Python virtual environment...' });
				await this.createVenv(pythonPath, venvPath);
			}

			// Check if dependencies are installed
			const depsInstalled = await this.checkDependencies(venvPath);
			
			if (!depsInstalled) {
				this.onProgress({ type: 'progress', message: 'Installing Python dependencies...' });
				await this.installDependencies(venvPath);
			}

			return true;
		} catch (error) {
			this.onProgress({ 
				type: 'error', 
				message: `Python environment setup failed: ${error.message}`,
				error: error.message
			});
			return false;
		}
	}

	/**
	 * Test connection to Chroma Cloud
	 */
	public async testConnection(): Promise<boolean> {
		const config = this.buildChromaConfig();
		const testScript = join(this.pluginDataPath, 'python', 'test_connection.py');
		
		try {
			await this.ensurePythonEnvironment();
			
			const result = await this.runPythonScript(testScript, JSON.stringify(config));
			return result.success;
		} catch (error) {
			console.error('Connection test failed:', error);
			return false;
		}
	}

	/**
	 * Execute sync job with the provided delta actions
	 */
	public async executeSync(actions: DeltaAction[]): Promise<SyncResult> {
		const startTime = Date.now();
		
		try {
			await this.ensurePythonEnvironment();
			
			// Initialize session
			const session = this.stateManager.initializeSession(actions, this.settings.batchSize);
			
			this.onProgress({ 
				type: 'progress', 
				message: `Starting sync with ${actions.length} actions...`,
				processed: 0,
				total: actions.length
			});

			const result = await this.executeSyncBatches();
			
			if (result.success) {
				this.stateManager.completeSession();
				this.onProgress({ 
					type: 'complete', 
					message: `Sync completed: ${result.processed} documents processed`,
					processed: result.processed,
					total: actions.length
				});
			}

			return {
				...result,
				duration: Date.now() - startTime,
			};

		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMsg = `Sync failed: ${error.message}`;
			
			this.stateManager.addError(error.message);
			this.onProgress({ 
				type: 'error', 
				message: errorMsg,
				error: error.message
			});

			return {
				success: false,
				processed: this.stateManager.getCurrentSession()?.processedActions || 0,
				errors: [error.message],
				duration,
			};
		}
	}

	/**
	 * Execute sync batches with pause/resume support
	 */
	private async executeSyncBatches(): Promise<SyncResult> {
		const config = this.buildChromaConfig();
		const indexScript = join(this.pluginDataPath, 'python', 'index_vault.py');
		
		let totalProcessed = 0;
		const allErrors: string[] = [];
		
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const { actions, hasMore } = this.stateManager.getNextBatch();
			
			if (actions.length === 0) {
				break;
			}

			// Check for abort signal
			const abortSignal = this.stateManager.getAbortSignal();
			if (abortSignal?.aborted) {
				break;
			}

			try {
				// Prepare JSONL input for this batch
				const jsonlInput = [
					JSON.stringify({ config }),
					...actions.map(action => JSON.stringify(action))
				].join('\n');

				const batchResult = await this.runPythonScriptWithAbort(indexScript, jsonlInput, abortSignal);
				
				if (batchResult.success) {
					totalProcessed += batchResult.processed;
					this.stateManager.completeBatch(actions.slice(0, batchResult.processed));
					
					// Update progress
					const progress = this.stateManager.getProgress();
					if (progress) {
						this.onProgress({
							type: 'progress',
							message: `Processed ${progress.processed}/${progress.total} documents (${progress.percentage}%)`,
							processed: progress.processed,
							total: progress.total
						});
					}
				} else {
					allErrors.push(...batchResult.errors);
					this.stateManager.addError(batchResult.errors.join(', '));
					
					// Continue with remaining batches even if one fails
					this.stateManager.completeBatch(actions.slice(0, batchResult.processed));
					totalProcessed += batchResult.processed;
				}

				// Small delay between batches to allow UI updates
				await new Promise(resolve => setTimeout(resolve, 100));
				
			} catch (error) {
				if (error.name === 'AbortError' || abortSignal?.aborted) {
					// Sync was paused or stopped
					break;
				}
				
				allErrors.push(error.message);
				this.stateManager.addError(error.message);
				break;
			}
		}

		// Consider sync successful if we processed most documents
		// Only mark as failed if we had critical errors or processed very few documents
		const session = this.stateManager.getCurrentSession();
		const totalActions = session?.totalActions || 1;
		const successRate = totalProcessed / totalActions;
		
		// Success if we processed at least 80% of documents, or if only quota errors occurred
		const hasOnlyQuotaErrors = allErrors.every(error => 
			error.includes('Quota exceeded') || error.includes('quota limit')
		);
		
		const success = successRate >= 0.8 || (hasOnlyQuotaErrors && successRate > 0);
		
		return {
			success,
			processed: totalProcessed,
			errors: allErrors,
			duration: 0, // Will be set by caller
		};
	}

	/**
	 * Pause the current sync
	 */
	public pauseSync(): boolean {
		return this.stateManager.pauseSession();
	}

	/**
	 * Resume a paused sync
	 */
	public async resumeSync(): Promise<SyncResult> {
		if (!this.stateManager.resumeSession()) {
			return {
				success: false,
				processed: 0,
				errors: ['No paused session to resume'],
				duration: 0
			};
		}

		const startTime = Date.now();
		
		try {
			const result = await this.executeSyncBatches();
			
			if (result.success) {
				this.stateManager.completeSession();
				this.onProgress({ 
					type: 'complete', 
					message: `Sync resumed and completed: ${result.processed} documents processed`
				});
			}

			return {
				...result,
				duration: Date.now() - startTime,
			};
		} catch (error) {
			const duration = Date.now() - startTime;
			this.stateManager.addError(error.message);
			
			return {
				success: false,
				processed: this.stateManager.getCurrentSession()?.processedActions || 0,
				errors: [error.message],
				duration,
			};
		}
	}

	/**
	 * Stop the current sync
	 */
	public stopSync(): boolean {
		return this.stateManager.stopSession();
	}

	/**
	 * Get current sync state
	 */
	public getSyncProgress() {
		return this.stateManager.getProgress();
	}

	/**
	 * Get state manager for direct access
	 */
	public getStateManager(): SyncStateManager {
		return this.stateManager;
	}

	/**
	 * Verify sync consistency between local state and Chroma collection
	 */
	public async verifySync(fileState: FileState): Promise<VerificationResult> {
		const startTime = Date.now();
		
		try {
			await this.ensurePythonEnvironment();
			
			const config = this.buildChromaConfig();
			const verifyScript = join(this.pluginDataPath, 'python', 'verify_sync.py');
			
			this.onProgress({ 
				type: 'progress', 
				message: 'Starting sync verification...'
			});

			// Prepare JSONL input: config + file state
			const jsonlInput = [
				JSON.stringify({ config }),
				JSON.stringify({ files: fileState.files })
			].join('\n');

			const result = await this.runPythonScript(verifyScript, jsonlInput);
			
			if (result.success) {
				// The Python script outputs the verification result as JSON
				// Parse the last line as the result
				const outputLines = result.processed.toString().split('\n').filter(line => line.trim());
				let verificationResult: VerificationResult | null = null;

				// Look for the complete result in the output
				for (const line of outputLines.reverse()) {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === 'complete' && parsed.verified !== undefined) {
							verificationResult = {
								verified: parsed.verified,
								missing_in_chroma: parsed.missing_in_chroma || [],
								extra_in_chroma: parsed.extra_in_chroma || [],
								hash_mismatches: parsed.hash_mismatches || [],
								stats: parsed.stats || {
									total_local_files: 0,
									total_chroma_documents: 0,
									collection_count: 0,
									missing_count: 0,
									extra_count: 0,
									mismatch_count: 0
								}
							};
							break;
						}
					} catch (e) {
						// Not JSON, skip
						continue;
					}
				}

				if (verificationResult) {
					const duration = Date.now() - startTime;
					const status = verificationResult.verified ? 'verified' : 'inconsistent';
					
					this.onProgress({ 
						type: 'complete', 
						message: `Verification ${status}: ${verificationResult.stats.missing_count} missing, ${verificationResult.stats.extra_count} extra documents`
					});

					return verificationResult;
				} else {
					throw new Error('Failed to parse verification result');
				}
			} else {
				throw new Error(`Verification failed: ${result.errors.join(', ')}`);
			}

		} catch (error) {
			const errorMsg = `Verification failed: ${error.message}`;
			this.onProgress({ 
				type: 'error', 
				message: errorMsg,
				error: error.message
			});

			return {
				verified: false,
				missing_in_chroma: [],
				extra_in_chroma: [],
				hash_mismatches: [],
				stats: {
					total_local_files: Object.keys(fileState.files).length,
					total_chroma_documents: 0,
					collection_count: 0,
					missing_count: 0,
					extra_count: 0,
					mismatch_count: 0
				}
			};
		}
	}

	/**
	 * Cleanup any running processes
	 */
	public cleanup(): void {
		if (this.currentProcess) {
			this.killProcess(this.currentProcess);
		}
	}

	private buildChromaConfig(): ChromaConfig {
		return {
			host: 'api.trychroma.com',
			port: 443,
			ssl: true,
			token_header: this.settings.tokenHeader === 'Authorization' ? 'Authorization' : 'X-Chroma-Token',
			token: this.settings.token,
			tenant: this.settings.tenant,
			database: this.settings.database,
			collection: this.settings.collection,
		};
	}

	private async checkVenvExists(venvPath: string): Promise<boolean> {
		return new Promise((resolve) => {
			const process = spawn('ls', [venvPath], { stdio: 'pipe' });
			process.on('close', (code) => {
				resolve(code === 0);
			});
			process.on('error', () => {
				resolve(false);
			});
		});
	}

	private async createVenv(pythonPath: string, venvPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const process = spawn(pythonPath, ['-m', 'venv', venvPath], {
				stdio: 'pipe'
			});

			let stderr = '';
			process.stderr?.on('data', (data) => {
				stderr += data.toString();
			});

			process.on('close', (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Failed to create venv: ${stderr}`));
				}
			});

			process.on('error', reject);
		});
	}

	private async checkDependencies(venvPath: string): Promise<boolean> {
		const pythonPath = this.getVenvPython(venvPath);
		
		return new Promise((resolve) => {
			const process = spawn(pythonPath, ['-c', 'import chromadb'], { stdio: 'pipe' });
			process.on('close', (code) => {
				resolve(code === 0);
			});
			process.on('error', () => {
				resolve(false);
			});
		});
	}

	private async installDependencies(venvPath: string): Promise<void> {
		const pipPath = this.getVenvPip(venvPath);
		const requirementsPath = join(this.pluginDataPath, 'python', 'requirements.txt');
		
		return new Promise((resolve, reject) => {
			const process = spawn(pipPath, ['install', '-r', requirementsPath], {
				stdio: 'pipe'
			});

			let stderr = '';
			process.stderr?.on('data', (data) => {
				stderr += data.toString();
			});

			process.on('close', (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`Failed to install dependencies: ${stderr}`));
				}
			});

			process.on('error', reject);
		});
	}

	private async runPythonScript(scriptPath: string, input: string): Promise<SyncResult> {
		return this.runPythonScriptWithAbort(scriptPath, input, null);
	}

	private async runPythonScriptWithAbort(scriptPath: string, input: string, abortSignal: AbortSignal | null): Promise<SyncResult> {
		const venvPath = join(this.pluginDataPath, 'python', '.venv');
		const pythonPath = this.getVenvPython(venvPath);

		return new Promise((resolve, reject) => {
			const process = spawn(pythonPath, [scriptPath], {
				stdio: 'pipe'
			});

			this.currentProcess = process;

			let stdout = '';
			let stderr = '';
			let processed = 0;
			const errors: string[] = [];
			let aborted = false;

			// Handle abort signal
			const onAbort = () => {
				if (!aborted) {
					aborted = true;
					this.killProcess(process);
					reject(new AbortError('Process aborted'));
				}
			};

			if (abortSignal) {
				abortSignal.addEventListener('abort', onAbort);
			}

			process.stdout?.on('data', (data) => {
				const chunk = data.toString();
				stdout += chunk;

				// Process progress updates line by line
				const lines = chunk.split('\n');
				for (const line of lines) {
					if (line.trim()) {
						try {
							const update = JSON.parse(line);
							if (update.type === 'progress') {
								processed = update.processed || processed;
								// Don't call onProgress here for batch processing
								// Let the batch handler manage progress updates
							}
						} catch {
							// Line is not JSON, ignore
						}
					}
				}
			});

			process.stderr?.on('data', (data) => {
				stderr += data.toString();
			});

			// Send input to Python script
			if (input) {
				process.stdin?.write(input);
				process.stdin?.end();
			}

			process.on('close', (code) => {
				this.currentProcess = null;
				
				if (abortSignal) {
					abortSignal.removeEventListener('abort', onAbort);
				}

				if (aborted) {
					return; // Already handled by abort
				}

				if (code === 0) {
					resolve({
						success: true,
						processed,
						errors: [],
						duration: 0, // Will be set by caller
					});
				} else {
					errors.push(stderr);
					resolve({
						success: false,
						processed,
						errors,
						duration: 0,
					});
				}
			});

			process.on('error', (error) => {
				this.currentProcess = null;
				
				if (abortSignal) {
					abortSignal.removeEventListener('abort', onAbort);
				}

				if (aborted) {
					return; // Already handled by abort
				}

				reject(error);
			});
		});
	}

	/**
	 * Kill a child process gracefully
	 */
	private killProcess(process: ChildProcess): void {
		if (process && !process.killed) {
			// Try SIGTERM first
			process.kill('SIGTERM');
			
			// Force kill after 5 seconds if still running
			setTimeout(() => {
				if (!process.killed) {
					process.kill('SIGKILL');
				}
			}, 5000);
		}
	}

	private getVenvPython(venvPath: string): string {
		if ((Platform as any).isWin || (Platform as any).isWindows) {
			return join(venvPath, 'Scripts', 'python.exe');
		} else {
			return join(venvPath, 'bin', 'python');
		}
	}

	private getVenvPip(venvPath: string): string {
		if ((Platform as any).isWin || (Platform as any).isWindows) {
			return join(venvPath, 'Scripts', 'pip.exe');
		} else {
			return join(venvPath, 'bin', 'pip');
		}
	}
}
