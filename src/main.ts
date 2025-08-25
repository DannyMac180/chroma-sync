import { 
	Plugin, 
	Notice,
	addIcon,
	setIcon,
	TFile
} from 'obsidian';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';

import { ChromaSyncSettings, DEFAULT_SETTINGS, ChromaSyncSettingsTab } from './settings';
import { DeltaEngine, FileState } from './delta';
import { ChromaRunner, ProgressUpdate, VerificationResult } from './runner';
import { SyncState, SyncProgress } from './sync-state';
import { ContentProcessorFactory } from './content-processor';
import { DocumentChunker } from './document-chunker';

export default class ChromaSyncPlugin extends Plugin {
	settings: ChromaSyncSettings;
	deltaEngine: DeltaEngine;
	runner: ChromaRunner;
	statusBarItem: HTMLElement;
	ribbonIconEl: HTMLElement;
	isRunning: boolean = false;
	currentSyncState: SyncState = 'idle';
	progressUpdateInterval: number | null = null;
	
	private logEntries: string[] = [];
	private maxLogEntries = 1000;
	private contentProcessor: ContentProcessorFactory;
	private documentChunker: DocumentChunker;
	private verificationInterval: number | null = null;

	async onload() {
		await this.loadSettings();
		
		// Initialize components
		this.deltaEngine = new DeltaEngine(
			this.app.vault,
			this.settings.includeGlobs,
			this.settings.excludeGlobs
		);
		
		this.runner = new ChromaRunner(
			this.settings,
			this.getPluginDataPath(),
			this.onProgressUpdate.bind(this)
		);

		this.contentProcessor = new ContentProcessorFactory();
		this.documentChunker = new DocumentChunker();

		// Add ribbon icons
		addIcon('sync', `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>`);
		addIcon('pause', `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`);
		addIcon('play', `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5,3 19,12 5,21"/></svg>`);
		addIcon('stop', `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>`);
		
		this.ribbonIconEl = this.addRibbonIcon('refresh-ccw', 'Sync to Chroma', async () => {
			await this.handleRibbonClick();
		});
		this.ribbonIconEl.addClass('chroma-sync-ribbon-button');

		// Add commands
		this.addCommand({
			id: 'sync-to-chroma',
			name: 'Sync vault to Chroma Cloud',
			callback: async () => {
				await this.manualSync();
			}
		});

		this.addCommand({
			id: 'test-chroma-connection',
			name: 'Test Chroma Cloud connection',
			callback: async () => {
				await this.testConnection();
			}
		});

		this.addCommand({
			id: 'pause-sync',
			name: 'Pause sync',
			callback: () => {
				this.pauseSync();
			}
		});

		this.addCommand({
			id: 'resume-sync',
			name: 'Resume sync',
			callback: async () => {
				await this.resumeSync();
			}
		});

		this.addCommand({
			id: 'stop-sync',
			name: 'Stop sync',
			callback: () => {
				this.stopSync();
			}
		});

		this.addCommand({
			id: 'verify-sync',
			name: 'Verify sync consistency',
			callback: async () => {
				await this.verifySync();
			}
		});

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('chroma-sync-status-bar');
		this.updateStatusBar('Ready');

		// Add settings tab
		this.addSettingTab(new ChromaSyncSettingsTab(this.app, this));

		// Ensure plugin data directory exists
		this.ensureDataDirectory();

		// Check for existing session on startup
		this.checkExistingSession();

		// Schedule initial sync after layout is ready
		if (this.settings.runOnOpen) {
			this.app.workspace.onLayoutReady(() => {
				this.log('info', 'Workspace ready, scheduling initial sync...');
				// Delay initial sync to avoid blocking startup
				setTimeout(() => {
					this.autoSync();
				}, 2000);
			});
		}

		// Schedule periodic verification (daily)
		this.scheduleVerification();

		this.log('info', 'Chroma Sync plugin loaded');
	}

	async onunload() {
		// Cleanup running processes
		if (this.runner) {
			this.runner.cleanup();
		}

		// Clear progress update interval
		if (this.progressUpdateInterval) {
			clearInterval(this.progressUpdateInterval);
		}

		// Clear verification interval
		if (this.verificationInterval) {
			clearInterval(this.verificationInterval);
		}

		this.log('info', 'Chroma Sync plugin unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		
		// Update delta engine with new globs
		if (this.deltaEngine) {
			this.deltaEngine.updateGlobs(this.settings.includeGlobs, this.settings.excludeGlobs);
		}
		
		// Update runner with new settings
		if (this.runner) {
			this.runner = new ChromaRunner(
				this.settings,
				this.getPluginDataPath(),
				this.onProgressUpdate.bind(this)
			);
		}
	}

	async testConnection(): Promise<boolean> {
		this.log('info', 'Testing Chroma Cloud connection...');
		
		try {
			const success = await this.runner.testConnection();
			if (success) {
				this.log('info', 'Connection test successful');
				new Notice('✓ Chroma Cloud connection successful!');
				return true;
			} else {
				this.log('error', 'Connection test failed');
				new Notice('✗ Chroma Cloud connection failed. Check settings and logs.');
				return false;
			}
		} catch (error) {
			this.log('error', `Connection test error: ${error.message}`);
			new Notice(`Connection error: ${error.message}`);
			return false;
		}
	}

	async manualSync(): Promise<void> {
		if (this.isRunning) {
			new Notice('Sync already in progress');
			return;
		}

		this.log('info', 'Manual sync initiated');
		await this.performSync();
	}

	private async autoSync(): Promise<void> {
		if (this.isRunning) {
			return;
		}

		this.log('info', 'Auto sync initiated');
		await this.performSync();
	}

	private async performSync(): Promise<void> {
		this.isRunning = true;
		this.currentSyncState = 'running';
		this.updateRibbonIcon();
		this.updateStatusBar('Syncing...', 'syncing');
		this.startProgressUpdateInterval();

		try {
			// Load previous state
			const previousState = this.loadFileState();
			
			// Generate delta plan
			this.log('info', 'Generating delta plan...');
			const deltaPlan = await this.deltaEngine.generateDeltaPlan(previousState);
			
			this.log('info', `Delta plan: ${deltaPlan.stats.added} added, ${deltaPlan.stats.updated} updated, ${deltaPlan.stats.deleted} deleted, ${deltaPlan.stats.unchanged} unchanged`);

			if (deltaPlan.actions.length === 0) {
				this.log('info', 'No changes to sync');
				new Notice('Vault is up to date');
				this.updateStatusBar('Up to date');
				return;
			}

			// Execute sync
			const result = await this.runner.executeSync(deltaPlan.actions);
			
			if (result.success) {
				// Save current state
				const currentState = await this.deltaEngine.createCurrentState();
				this.saveFileState(currentState);
				
				this.log('info', `Sync completed: ${result.processed} documents processed in ${result.duration}ms`);
				new Notice(`✓ Sync completed: ${result.processed} documents processed`);
				this.updateStatusBar('Synced');
			} else {
				this.log('error', `Sync failed: ${result.errors.join(', ')}`);
				new Notice(`✗ Sync failed: ${result.errors[0] || 'Unknown error'}`);
				this.updateStatusBar('Error', 'error');
			}

		} catch (error) {
			this.log('error', `Sync error: ${error.message}`);
			new Notice(`Sync error: ${error.message}`);
			this.updateStatusBar('Error', 'error');
		} finally {
			this.isRunning = false;
			this.currentSyncState = 'idle';
			this.updateRibbonIcon();
			this.stopProgressUpdateInterval();
		}
	}

	private onProgressUpdate(update: ProgressUpdate): void {
		this.log('info', update.message);
		
		if (update.type === 'progress' && update.processed !== undefined && update.total !== undefined) {
			const percentage = Math.round((update.processed / update.total) * 100);
			this.updateStatusBar(`Syncing ${percentage}%`, 'syncing');
		} else if (update.type === 'complete') {
			this.updateStatusBar('Synced');
		} else if (update.type === 'error') {
			this.updateStatusBar('Error', 'error');
		}
	}

	private updateStatusBar(text: string, status?: 'syncing' | 'error' | 'paused' | 'stopping'): void {
		this.statusBarItem.setText(`Chroma: ${text}`);
		this.statusBarItem.removeClass('syncing', 'error', 'paused', 'stopping');
		if (status) {
			this.statusBarItem.addClass(status);
		}
	}

	private getPluginDataPath(): string {
		// Use the plugin's current directory as the data folder
		const adapter = this.app.vault.adapter as any;
		const basePath = adapter.basePath || adapter.getBasePath?.() || '.';
		const pluginDir = join(basePath, '.obsidian', 'plugins', 'chroma-sync');
		
		// For development/installed plugins, use the plugin directory itself
		// Check if we're already in the plugin directory
		const currentDir = process.cwd();
		if (currentDir.includes('obsidian-chroma-sync') || currentDir.includes('chroma-sync')) {
			return currentDir;
		}
		
		return pluginDir;
	}

	private ensureDataDirectory(): void {
		const dataPath = this.getPluginDataPath();
		const pythonPath = join(dataPath, 'python');
		
		if (!existsSync(dataPath)) {
			mkdirSync(dataPath, { recursive: true });
		}
		if (!existsSync(pythonPath)) {
			mkdirSync(pythonPath, { recursive: true });
		}

		// Copy Python scripts to data directory if they don't exist
		this.copyPythonScripts(pythonPath);
	}

	private copyPythonScripts(pythonPath: string): void {
		const scripts = [
			{ name: 'index_vault.py', content: this.getIndexVaultScript() },
			{ name: 'test_connection.py', content: this.getTestConnectionScript() },
			{ name: 'requirements.txt', content: 'chromadb>=1.0.0\nrequests>=2.31.0\n' }
		];

		for (const script of scripts) {
			const scriptPath = join(pythonPath, script.name);
			if (!existsSync(scriptPath)) {
				writeFileSync(scriptPath, script.content);
			}
		}
	}

	private getIndexVaultScript(): string {
		// In a real implementation, this would be bundled with the plugin
		// For now, we'll return the script content directly
		return `#!/usr/bin/env python3
"""Placeholder - In production, this would be the actual script content"""
import sys
print('{"type": "error", "message": "Python scripts not properly installed"}')
sys.exit(1)
`;
	}

	private getTestConnectionScript(): string {
		return `#!/usr/bin/env python3
"""Placeholder - In production, this would be the actual script content"""
import sys
print('{"success": false, "error": "Python scripts not properly installed"}')
sys.exit(1)
`;
	}

	private getFileStatePath(): string {
		return join(this.getPluginDataPath(), 'file_state.json');
	}

	private loadFileState(): FileState | null {
		try {
			const statePath = this.getFileStatePath();
			this.log('info', `Loading file state from: ${statePath}`);
			if (existsSync(statePath)) {
				const content = readFileSync(statePath, 'utf8');
				const state = JSON.parse(content);
				this.log('info', `Loaded file state with ${Object.keys(state.files).length} files`);
				return state;
			} else {
				this.log('info', 'No existing file state found - first sync');
			}
		} catch (error) {
			this.log('warn', `Failed to load file state from ${this.getFileStatePath()}: ${error.message}`);
		}
		return null;
	}

	private saveFileState(state: FileState): void {
		try {
			const statePath = this.getFileStatePath();
			this.log('info', `Saving file state to: ${statePath}`);
			this.log('info', `File state contains ${Object.keys(state.files).length} files`);
			writeFileSync(statePath, JSON.stringify(state, null, 2));
			this.log('info', 'File state saved successfully');
		} catch (error) {
			this.log('error', `Failed to save file state to ${this.getFileStatePath()}: ${error.message}`);
		}
	}

	private log(level: string, message: string): void {
		const timestamp = new Date().toISOString();
		const logEntry = `${timestamp} [${level.toUpperCase()}] ${message}`;
		
		// Add to in-memory log
		this.logEntries.push(logEntry);
		if (this.logEntries.length > this.maxLogEntries) {
			this.logEntries.shift();
		}

		// Log to console based on level
		if (level === 'error') {
			console.error(`[Chroma Sync] ${message}`);
		} else if (level === 'warn') {
			console.warn(`[Chroma Sync] ${message}`);
		} else if (this.settings.logLevel === 'debug' || level !== 'debug') {
			console.info(`[Chroma Sync] ${message}`);
		}
	}

	async openLogs(): Promise<void> {
		const logs = this.logEntries.join('\n');
		
		// Create a temporary file with logs
		const logsFile = await this.app.vault.create('Chroma Sync Logs.md', `# Chroma Sync Logs

\`\`\`
${logs}
\`\`\`

*This file shows recent plugin activity. You can delete it when no longer needed.*
`);

		// Open the logs file
		const leaf = this.app.workspace.getUnpinnedLeaf();
		await leaf.openFile(logsFile);
	}

	/**
	 * Handle ribbon icon clicks based on current state
	 */
	private async handleRibbonClick(): Promise<void> {
		const stateManager = this.runner.getStateManager();
		
		if (stateManager.canResume()) {
			await this.resumeSync();
		} else if (stateManager.canPause()) {
			this.pauseSync();
		} else {
			await this.manualSync();
		}
	}

	/**
	 * Pause the current sync
	 */
	private pauseSync(): void {
		if (this.runner.pauseSync()) {
			this.currentSyncState = 'paused';
			this.updateRibbonIcon();
			this.updateStatusBar('Paused', 'paused');
			new Notice('Sync paused');
			this.log('info', 'Sync paused by user');
		} else {
			new Notice('No active sync to pause');
		}
	}

	/**
	 * Resume a paused sync
	 */
	private async resumeSync(): Promise<void> {
		this.currentSyncState = 'running';
		this.updateRibbonIcon();
		this.updateStatusBar('Resuming...', 'syncing');
		this.startProgressUpdateInterval();
		
		new Notice('Resuming sync...');
		this.log('info', 'Sync resumed by user');

		try {
			const result = await this.runner.resumeSync();
			
			if (result.success) {
				this.log('info', `Sync resumed and completed: ${result.processed} documents processed in ${result.duration}ms`);
				new Notice(`✓ Sync completed: ${result.processed} documents processed`);
				this.updateStatusBar('Synced');
			} else {
				this.log('error', `Sync resume failed: ${result.errors.join(', ')}`);
				new Notice(`✗ Sync failed: ${result.errors[0] || 'Unknown error'}`);
				this.updateStatusBar('Error', 'error');
			}
		} catch (error) {
			this.log('error', `Sync resume error: ${error.message}`);
			new Notice(`Sync error: ${error.message}`);
			this.updateStatusBar('Error', 'error');
		} finally {
			this.currentSyncState = 'idle';
			this.isRunning = false;
			this.updateRibbonIcon();
			this.stopProgressUpdateInterval();
		}
	}

	/**
	 * Stop the current sync
	 */
	private stopSync(): void {
		if (this.runner.stopSync()) {
			this.currentSyncState = 'stopping';
			this.updateRibbonIcon();
			this.updateStatusBar('Stopping...', 'stopping');
			new Notice('Sync stopped');
			this.log('info', 'Sync stopped by user');
			
			// Reset state after short delay
			setTimeout(() => {
				this.currentSyncState = 'idle';
				this.isRunning = false;
				this.updateRibbonIcon();
				this.updateStatusBar('Ready');
				this.stopProgressUpdateInterval();
			}, 1000);
		} else {
			new Notice('No active sync to stop');
		}
	}

	/**
	 * Check for existing session on startup
	 */
	private checkExistingSession(): void {
		const stateManager = this.runner.getStateManager();
		const session = stateManager.getCurrentSession();
		
		if (session && session.state === 'paused') {
			this.currentSyncState = 'paused';
			this.updateRibbonIcon();
			
			const progress = stateManager.getProgress();
			if (progress) {
				this.updateStatusBar(`Paused ${progress.percentage}%`, 'paused');
				new Notice(`Found paused sync: ${progress.processed}/${progress.total} documents processed`);
				this.log('info', `Resumed plugin with paused sync session: ${progress.processed}/${progress.total} documents`);
			}
		}
	}

	/**
	 * Update ribbon icon based on current state
	 */
	private updateRibbonIcon(): void {
		if (!this.ribbonIconEl) return;

		const stateManager = this.runner.getStateManager();
		
		if (stateManager.canResume()) {
			this.ribbonIconEl.innerHTML = '';
			setIcon(this.ribbonIconEl, 'play');
			this.ribbonIconEl.setAttribute('aria-label', 'Resume sync');
		} else if (stateManager.canPause()) {
			this.ribbonIconEl.innerHTML = '';
			setIcon(this.ribbonIconEl, 'pause');
			this.ribbonIconEl.setAttribute('aria-label', 'Pause sync');
		} else {
			this.ribbonIconEl.innerHTML = '';
			setIcon(this.ribbonIconEl, 'refresh-ccw');
			this.ribbonIconEl.setAttribute('aria-label', 'Sync to Chroma');
		}
	}

	/**
	 * Start interval to update progress display
	 */
	private startProgressUpdateInterval(): void {
		if (this.progressUpdateInterval) {
			clearInterval(this.progressUpdateInterval);
		}

		this.progressUpdateInterval = window.setInterval(() => {
			const progress = this.runner.getSyncProgress();
			if (progress) {
				this.updateStatusBarFromProgress(progress);
			}
		}, 1000);
	}

	/**
	 * Stop progress update interval
	 */
	private stopProgressUpdateInterval(): void {
		if (this.progressUpdateInterval) {
			clearInterval(this.progressUpdateInterval);
			this.progressUpdateInterval = null;
		}
	}

	/**
	 * Update status bar from progress data
	 */
	private updateStatusBarFromProgress(progress: SyncProgress): void {
		const { processed, total, percentage, state, estimatedTimeRemaining } = progress;
		
		let statusText = `Syncing ${percentage}% (${processed}/${total})`;
		
		if (estimatedTimeRemaining && estimatedTimeRemaining > 0) {
			const minutes = Math.ceil(estimatedTimeRemaining / 60000);
			statusText += ` ~${minutes}min`;
		}

		let statusClass: 'syncing' | 'paused' | 'stopping' | 'error' | undefined;
		
		if (state === 'running') {
			statusClass = 'syncing';
		} else if (state === 'paused') {
			statusText = `Paused ${percentage}% (${processed}/${total})`;
			statusClass = 'paused';
		} else if (state === 'stopping') {
			statusText = 'Stopping...';
			statusClass = 'stopping';
		}

		this.updateStatusBar(statusText, statusClass);
	}

	/**
	 * Verify sync consistency with Chroma
	 */
	private async verifySync(): Promise<void> {
		if (this.isRunning) {
			new Notice('Cannot verify while sync is running');
			return;
		}

		this.log('info', 'Manual verification initiated');
		
		try {
			const fileState = this.loadFileState();
			if (!fileState) {
				new Notice('No sync state found - perform initial sync first');
				return;
			}

			// Check if verification is needed
			if (!this.deltaEngine.needsVerification(fileState)) {
				new Notice('Verification not needed - recently verified');
				return;
			}

			this.updateStatusBar('Verifying...', 'syncing');
			const result = await this.runner.verifySync(fileState);

			if (result.verified) {
				// Update verification state
				const updatedState = this.deltaEngine.updateVerificationState(
					fileState,
					'verified'
				);
				this.saveFileState(updatedState);

				this.log('info', 'Verification completed successfully');
				new Notice(`✓ Sync verified: ${result.stats.total_local_files} files consistent`);
				this.updateStatusBar('Verified');
			} else {
				// Update verification state with inconsistencies
				const updatedState = this.deltaEngine.updateVerificationState(
					fileState,
					'inconsistent',
					{
						missingInChroma: result.missing_in_chroma,
						extraInChroma: result.extra_in_chroma
					}
				);
				this.saveFileState(updatedState);

				const issues = result.stats.missing_count + result.stats.extra_count;
				this.log('warn', `Verification found ${issues} inconsistencies`);
				new Notice(`⚠ Sync inconsistent: ${issues} issues found - check logs`);
				this.updateStatusBar('Inconsistent', 'error');

				// Log details
				if (result.missing_in_chroma.length > 0) {
					this.log('warn', `Missing in Chroma: ${result.missing_in_chroma.join(', ')}`);
				}
				if (result.extra_in_chroma.length > 0) {
					this.log('warn', `Extra in Chroma: ${result.extra_in_chroma.join(', ')}`);
				}
			}

		} catch (error) {
			this.log('error', `Verification error: ${error.message}`);
			new Notice(`Verification error: ${error.message}`);
			this.updateStatusBar('Error', 'error');
		}
	}

	/**
	 * Schedule periodic verification
	 */
	private scheduleVerification(): void {
		// Check every hour for verification needs
		this.verificationInterval = window.setInterval(async () => {
			const fileState = this.loadFileState();
			if (fileState && this.deltaEngine.needsVerification(fileState) && !this.isRunning) {
				this.log('info', 'Automatic verification triggered');
				await this.verifySync();
			}
		}, 60 * 60 * 1000); // Every hour
	}

	/**
	 * Enhanced sync with retry logic
	 */
	private async performSyncWithRetry(): Promise<void> {
		const previousState = this.loadFileState();
		
		// Include retry-able failed files in sync
		let retryFiles: string[] = [];
		if (previousState?.partialSync) {
			retryFiles = this.deltaEngine.getRetryableFiles(previousState);
			if (retryFiles.length > 0) {
				this.log('info', `Retrying ${retryFiles.length} previously failed files`);
			}
		}

		// Generate delta plan (includes retries)
		this.log('info', 'Generating delta plan...');
		const deltaPlan = await this.deltaEngine.generateDeltaPlan(previousState);
		
		if (deltaPlan.actions.length === 0 && retryFiles.length === 0) {
			this.log('info', 'No changes to sync');
			new Notice('Vault is up to date');
			this.updateStatusBar('Up to date');
			return;
		}

		// Execute sync
		const result = await this.runner.executeSync(deltaPlan.actions);
		
		if (result.success) {
			// All files succeeded - clear partial sync state
			let currentState = await this.deltaEngine.createCurrentState();
			if (previousState?.partialSync) {
				currentState = this.deltaEngine.markFilesSucceeded(
					currentState,
					retryFiles
				);
			}
			this.saveFileState(currentState);
			
			this.log('info', `Sync completed: ${result.processed} documents processed in ${result.duration}ms`);
			new Notice(`✓ Sync completed: ${result.processed} documents processed`);
			this.updateStatusBar('Synced');
		} else {
			// Some files failed - track for retry
			let currentState = await this.deltaEngine.createCurrentState();
			if (result.errors.length > 0) {
				// Extract failed file paths from errors (simplified)
				const failedFiles = deltaPlan.actions
					.slice(result.processed)
					.map(action => action.path!)
					.filter(path => path);
				
				currentState = this.deltaEngine.markFilesFailed(currentState, failedFiles);
			}
			this.saveFileState(currentState);
			
			this.log('error', `Sync partially failed: ${result.errors.join(', ')}`);
			new Notice(`⚠ Sync partially failed: ${result.processed}/${deltaPlan.actions.length} processed`);
			this.updateStatusBar('Partial', 'error');
		}
	}
}
