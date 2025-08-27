import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import ChromaSyncPlugin from './main';

export interface ChromaSyncSettings {
	// Chroma Cloud connection
	token: string;
	tenant: string;
	database: string;
	collection: string;
	
	// Performance settings
	batchSize: number;
	
	// File filtering
	includeGlobs: string[];
	excludeGlobs: string[];
	
	// System settings
	pythonPath: string;
	runOnOpen: boolean;
	
	// Advanced
	tokenHeader: 'Authorization' | 'X-Chroma-Token';
	logLevel: 'debug' | 'info' | 'warn' | 'error';
	
	// Sync control
	allowResume: boolean;
	pauseOnError: boolean;
}

export const DEFAULT_SETTINGS: ChromaSyncSettings = {
	token: '',
	tenant: 'default_tenant',
	database: 'default_database',
	collection: 'obsidian_vault',
	batchSize: 100,
	includeGlobs: ['**/*.md'],
	excludeGlobs: [],
	pythonPath: 'python3',
	runOnOpen: true,
	tokenHeader: 'X-Chroma-Token',  // Use X-Chroma-Token by default as it works with ck- tokens
	logLevel: 'info',
	allowResume: true,
	pauseOnError: false,
};

export class ChromaSyncSettingsTab extends PluginSettingTab {
	plugin: ChromaSyncPlugin;
	private testConnectionStatus: HTMLElement;

	constructor(app: App, plugin: ChromaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Chroma Sync Settings' });

		// Chroma Cloud Connection Section
		containerEl.createEl('h3', { text: 'Chroma Cloud Connection' });

		new Setting(containerEl)
			.setName('API Token')
			.setDesc('Your Chroma Cloud API token (keep this secure)')
			.addText(text => text
				.setPlaceholder('chroma-token-...')
				.setValue(this.plugin.settings.token)
				.onChange(async (value) => {
					this.plugin.settings.token = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Tenant')
			.setDesc('Chroma Cloud tenant name')
			.addText(text => text
				.setPlaceholder('default_tenant')
				.setValue(this.plugin.settings.tenant)
				.onChange(async (value) => {
					this.plugin.settings.tenant = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Database')
			.setDesc('Chroma Cloud database name')
			.addText(text => text
				.setPlaceholder('default_database')
				.setValue(this.plugin.settings.database)
				.onChange(async (value) => {
					this.plugin.settings.database = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Collection')
			.setDesc('Collection name for this vault')
			.addText(text => text
				.setPlaceholder('obsidian_vault')
				.setValue(this.plugin.settings.collection)
				.onChange(async (value) => {
					this.plugin.settings.collection = value;
					await this.plugin.saveSettings();
				}));

		// Test Connection
		const testConnectionSetting = new Setting(containerEl)
			.setName('Test Connection')
			.setDesc('Verify connection to Chroma Cloud')
			.addButton(button => button
				.setButtonText('Test Connection')
				.setCta()
				.onClick(async () => {
					await this.testConnection();
				}));

		this.testConnectionStatus = testConnectionSetting.settingEl.createDiv('chroma-sync-test-connection');

		// Performance Section
		containerEl.createEl('h3', { text: 'Performance' });

		new Setting(containerEl)
			.setName('Batch Size')
			.setDesc('Number of documents to send in each batch')
			.addSlider(slider => slider
				.setLimits(10, 1000, 10)
				.setValue(this.plugin.settings.batchSize)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.batchSize = value;
					await this.plugin.saveSettings();
				}));

		// File Filtering Section
		containerEl.createEl('h3', { text: 'File Filtering' });

		new Setting(containerEl)
			.setName('Include Patterns')
			.setDesc('Glob patterns for files to include (one per line)')
			.addTextArea(text => text
				.setPlaceholder('**/*.md\n**/*.txt')
				.setValue(this.plugin.settings.includeGlobs.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.includeGlobs = value.split('\n').filter(line => line.trim());
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Exclude Patterns')
			.setDesc('Glob patterns for files to exclude (one per line)')
			.addTextArea(text => text
				.setPlaceholder(`**/${this.app.vault.configDir}/**\n**/node_modules/**`)
				.setValue(this.plugin.settings.excludeGlobs.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.excludeGlobs = value.split('\n').filter(line => line.trim());
					await this.plugin.saveSettings();
				}));

		// System Settings Section
		containerEl.createEl('h3', { text: 'System' });

		new Setting(containerEl)
			.setName('Python Path')
			.setDesc('Path to Python executable (python3, python, or full path)')
			.addText(text => text
				.setPlaceholder('python3')
				.setValue(this.plugin.settings.pythonPath)
				.onChange(async (value) => {
					this.plugin.settings.pythonPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Run on App Open')
			.setDesc('Automatically sync when Obsidian opens')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.runOnOpen)
				.onChange(async (value) => {
					this.plugin.settings.runOnOpen = value;
					await this.plugin.saveSettings();
				}));

		// Advanced Section
		containerEl.createEl('h3', { text: 'Advanced' });

		new Setting(containerEl)
			.setName('Token Header')
			.setDesc('HTTP header to use for authentication')
			.addDropdown(dropdown => dropdown
				.addOption('X-Chroma-Token', 'X-Chroma-Token')
				.addOption('Authorization', 'Authorization (Bearer)')
				.setValue(this.plugin.settings.tokenHeader)
				.onChange(async (value: 'X-Chroma-Token' | 'Authorization') => {
					this.plugin.settings.tokenHeader = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Log Level')
			.setDesc('Verbosity of logging output')
			.addDropdown(dropdown => dropdown
				.addOption('debug', 'Debug')
				.addOption('info', 'Info')
				.addOption('warn', 'Warning')
				.addOption('error', 'Error')
				.setValue(this.plugin.settings.logLevel)
				.onChange(async (value: 'debug' | 'info' | 'warn' | 'error') => {
					this.plugin.settings.logLevel = value;
					await this.plugin.saveSettings();
				}));

		// Sync Control Section
		containerEl.createEl('h3', { text: 'Sync Control' });

		new Setting(containerEl)
			.setName('Allow Resume')
			.setDesc('Allow resuming paused sync sessions after plugin reload')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.allowResume)
				.onChange(async (value) => {
					this.plugin.settings.allowResume = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Pause on Error')
			.setDesc('Automatically pause sync when errors occur instead of stopping')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pauseOnError)
				.onChange(async (value) => {
					this.plugin.settings.pauseOnError = value;
					await this.plugin.saveSettings();
				}));

		// Logs Section
		containerEl.createEl('h3', { text: 'Logs' });
		
		new Setting(containerEl)
			.setName('Plugin Logs')
			.setDesc('View recent plugin activity')
			.addButton(button => button
				.setButtonText('Open Logs')
				.onClick(async () => {
					await this.plugin.openLogs();
				}));
	}

	private async testConnection(): Promise<void> {
		this.testConnectionStatus.setText('Testing...');
		this.testConnectionStatus.removeClass('success', 'error');

		try {
			const success = await this.plugin.testConnection();
			if (success) {
				this.testConnectionStatus.setText('✓ Connection successful');
				this.testConnectionStatus.addClass('success');
				new Notice('Chroma Cloud connection successful!');
			} else {
				this.testConnectionStatus.setText('✗ Connection failed');
				this.testConnectionStatus.addClass('error');
				new Notice('Chroma Cloud connection failed. Check your settings and logs.');
			}
		} catch (error) {
			this.testConnectionStatus.setText('✗ Connection error');
			this.testConnectionStatus.addClass('error');
			new Notice(`Connection error: ${error.message}`);
		}
	}
}
