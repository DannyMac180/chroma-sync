import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { DeltaAction } from './delta';

export type SyncState = 'idle' | 'running' | 'paused' | 'stopping' | 'stopped';

export interface SyncSession {
	id: string;
	state: SyncState;
	startTime: number;
	pauseTime?: number;
	resumeTime?: number;
	totalActions: number;
	processedActions: number;
	remainingActions: DeltaAction[];
	processedIds: Set<string>;
	errors: string[];
	lastCheckpointTime: number;
	batchSize: number;
}

export interface SyncProgress {
	processed: number;
	total: number;
	percentage: number;
	remaining: number;
	currentBatch: number;
	totalBatches: number;
	state: SyncState;
	elapsedTime: number;
	estimatedTimeRemaining?: number;
}

export class SyncStateManager {
	private pluginDataPath: string;
	private currentSession: SyncSession | null = null;
	private sessionFilePath: string;
	private abortController: AbortController | null = null;
	
	constructor(pluginDataPath: string) {
		this.pluginDataPath = pluginDataPath;
		this.sessionFilePath = join(pluginDataPath, 'sync_session.json');
	}

	/**
	 * Initialize a new sync session or resume existing one
	 */
	public initializeSession(actions: DeltaAction[], batchSize: number = 100): SyncSession {
		// Check for existing session to resume
		const existingSession = this.loadSession();
		
		if (existingSession && existingSession.state === 'paused' && existingSession.remainingActions.length > 0) {
			// Resume existing session
			this.currentSession = {
				...existingSession,
				state: 'running',
				resumeTime: Date.now(),
				batchSize: batchSize // Update batch size if changed
			};
		} else {
			// Create new session
			this.currentSession = {
				id: this.generateSessionId(),
				state: 'running',
				startTime: Date.now(),
				totalActions: actions.length,
				processedActions: 0,
				remainingActions: [...actions],
				processedIds: new Set<string>(),
				errors: [],
				lastCheckpointTime: Date.now(),
				batchSize: batchSize
			};
		}
		
		this.abortController = new AbortController();
		this.saveSession();
		return this.currentSession;
	}

	/**
	 * Get the next batch of actions to process
	 */
	public getNextBatch(): { actions: DeltaAction[]; hasMore: boolean } {
		if (!this.currentSession || this.currentSession.state !== 'running') {
			return { actions: [], hasMore: false };
		}

		const { remainingActions, batchSize } = this.currentSession;
		const batch = remainingActions.slice(0, batchSize);
		const hasMore = remainingActions.length > batchSize;

		return { actions: batch, hasMore };
	}

	/**
	 * Mark a batch as completed
	 */
	public completeBatch(completedActions: DeltaAction[]): void {
		if (!this.currentSession) return;

		// Remove completed actions from remaining
		this.currentSession.remainingActions = this.currentSession.remainingActions.slice(completedActions.length);
		
		// Add to processed count and IDs
		this.currentSession.processedActions += completedActions.length;
		for (const action of completedActions) {
			this.currentSession.processedIds.add(action.id);
		}

		// Update checkpoint
		this.currentSession.lastCheckpointTime = Date.now();
		this.saveSession();
	}

	/**
	 * Add error to current session
	 */
	public addError(error: string): void {
		if (!this.currentSession) return;
		
		this.currentSession.errors.push(error);
		this.saveSession();
	}

	/**
	 * Pause the current sync session
	 */
	public pauseSession(): boolean {
		if (!this.currentSession || this.currentSession.state !== 'running') {
			return false;
		}

		this.currentSession.state = 'paused';
		this.currentSession.pauseTime = Date.now();
		this.saveSession();
		
		if (this.abortController) {
			this.abortController.abort('Sync paused by user');
		}
		
		return true;
	}

	/**
	 * Resume a paused sync session
	 */
	public resumeSession(): boolean {
		if (!this.currentSession || this.currentSession.state !== 'paused') {
			return false;
		}

		this.currentSession.state = 'running';
		this.currentSession.resumeTime = Date.now();
		this.abortController = new AbortController();
		this.saveSession();
		
		return true;
	}

	/**
	 * Stop the current sync session completely
	 */
	public stopSession(): boolean {
		if (!this.currentSession || this.currentSession.state === 'idle') {
			return false;
		}

		this.currentSession.state = 'stopping';
		this.saveSession();
		
		if (this.abortController) {
			this.abortController.abort('Sync stopped by user');
		}

		// Clear session after short delay to allow cleanup
		setTimeout(() => {
			this.clearSession();
		}, 500);
		
		return true;
	}

	/**
	 * Complete the current sync session
	 */
	public completeSession(): void {
		if (!this.currentSession) return;

		this.currentSession.state = 'idle';
		this.clearSession();
	}

	/**
	 * Get current sync progress
	 */
	public getProgress(): SyncProgress | null {
		if (!this.currentSession) return null;

		const { processedActions, totalActions, state, startTime, pauseTime } = this.currentSession;
		const processed = processedActions;
		const total = totalActions;
		const remaining = total - processed;
		const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
		
		// Calculate elapsed time (accounting for paused time)
		const now = Date.now();
		const currentTime = pauseTime || now;
		const elapsedTime = currentTime - startTime;

		// Estimate remaining time based on current progress rate
		let estimatedTimeRemaining: number | undefined;
		if (processed > 0 && state === 'running') {
			const timePerAction = elapsedTime / processed;
			estimatedTimeRemaining = Math.round(timePerAction * remaining);
		}

		const totalBatches = Math.ceil(total / this.currentSession.batchSize);
		const currentBatch = Math.ceil(processed / this.currentSession.batchSize);

		return {
			processed,
			total,
			percentage,
			remaining,
			currentBatch: Math.max(1, currentBatch),
			totalBatches: Math.max(1, totalBatches),
			state,
			elapsedTime,
			estimatedTimeRemaining
		};
	}

	/**
	 * Get current session
	 */
	public getCurrentSession(): SyncSession | null {
		return this.currentSession;
	}

	/**
	 * Get abort signal for current session
	 */
	public getAbortSignal(): AbortSignal | null {
		return this.abortController?.signal || null;
	}

	/**
	 * Check if sync is currently active
	 */
	public isActive(): boolean {
		return this.currentSession?.state === 'running' || this.currentSession?.state === 'paused';
	}

	/**
	 * Check if sync can be paused
	 */
	public canPause(): boolean {
		return this.currentSession?.state === 'running';
	}

	/**
	 * Check if sync can be resumed
	 */
	public canResume(): boolean {
		return this.currentSession?.state === 'paused';
	}

	/**
	 * Check if sync can be stopped
	 */
	public canStop(): boolean {
		return this.currentSession?.state === 'running' || this.currentSession?.state === 'paused';
	}

	/**
	 * Save current session to disk
	 */
	private saveSession(): void {
		if (!this.currentSession) return;

		try {
			const sessionData = {
				...this.currentSession,
				processedIds: Array.from(this.currentSession.processedIds)
			};
			
			writeFileSync(this.sessionFilePath, JSON.stringify(sessionData, null, 2));
		} catch (error) {
			console.error('Failed to save sync session:', error);
		}
	}

	/**
	 * Load session from disk
	 */
	private loadSession(): SyncSession | null {
		try {
			if (!existsSync(this.sessionFilePath)) {
				return null;
			}

			const data = readFileSync(this.sessionFilePath, 'utf8');
			const sessionData = JSON.parse(data);
			
			// Validate session data
			if (!this.isValidSession(sessionData)) {
				console.warn('Invalid session data found, clearing...');
				this.clearSessionFile();
				return null;
			}

			// Convert processedIds array back to Set
			sessionData.processedIds = new Set(sessionData.processedIds || []);
			
			return sessionData;
		} catch (error) {
			console.error('Failed to load sync session:', error);
			this.clearSessionFile();
			return null;
		}
	}

	/**
	 * Clear current session from memory and disk
	 */
	private clearSession(): void {
		this.currentSession = null;
		this.abortController = null;
		this.clearSessionFile();
	}

	/**
	 * Clear session file from disk
	 */
	private clearSessionFile(): void {
		try {
			if (existsSync(this.sessionFilePath)) {
				unlinkSync(this.sessionFilePath);
			}
		} catch (error) {
			console.error('Failed to clear session file:', error);
		}
	}

	/**
	 * Generate a unique session ID
	 */
	private generateSessionId(): string {
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2);
		return `sync_${timestamp}_${random}`;
	}

	/**
	 * Validate session data structure
	 */
	private isValidSession(data: any): boolean {
		return (
			data &&
			typeof data.id === 'string' &&
			typeof data.state === 'string' &&
			typeof data.startTime === 'number' &&
			typeof data.totalActions === 'number' &&
			typeof data.processedActions === 'number' &&
			Array.isArray(data.remainingActions) &&
			Array.isArray(data.errors) &&
			typeof data.lastCheckpointTime === 'number' &&
			typeof data.batchSize === 'number'
		);
	}
}
