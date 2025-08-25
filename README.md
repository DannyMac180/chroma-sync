# Obsidian Chroma Sync

An Obsidian desktop plugin that automatically syncs your vault to [Chroma Cloud](https://trychroma.com) for AI-powered search and retrieval. The plugin performs full ingestion on first run, then intelligently syncs only changes (adds, updates, deletes) on subsequent runs.

## ⚠️ Desktop Only

This plugin requires Node.js and Python to run the Chroma indexing process. It **only works on Obsidian Desktop** (Windows, macOS, Linux) and is not compatible with Obsidian Mobile.

## Features

- 🔄 **Automatic Sync**: Syncs your vault to Chroma Cloud on app startup and on-demand
- ⚡ **Delta Sync**: Only syncs changed files after the initial full sync
- 📄 **PDF Text Extraction**: Automatically extracts text from PDF files when PyPDF2 is available
- 🖼️ **Image OCR**: Extracts text from images using OCR when pytesseract and Pillow are installed
- 🔐 **Secure**: Your Chroma Cloud token is stored locally and never logged
- 🎯 **Configurable**: Filter which files to sync with glob patterns
- 📊 **Progress Tracking**: Real-time sync progress in the status bar
- 🛠️ **Developer Friendly**: Full TypeScript with comprehensive testing

## Prerequisites

### 1. Python 3.9+

The plugin requires Python 3.9 or later to be available on your system PATH:

**macOS/Linux:**
```bash
python3 --version  # Should show 3.9+
```

**Windows:**
```cmd
python --version   # Should show 3.9+
```

If you don't have Python installed:
- **macOS**: Install via [Homebrew](https://brew.sh): `brew install python`
- **Windows**: Download from [python.org](https://python.org) or install via Windows Store
- **Linux**: Use your package manager: `sudo apt install python3 python3-venv` (Ubuntu/Debian)

### 2. Chroma Cloud Account

You'll need:
- A [Chroma Cloud](https://trychroma.com) account
- Your API token
- Tenant and database names (or use defaults)

## Installation

### Option 1: Manual Installation (Current)

1. Download the latest release from [GitHub Releases](https://github.com/DannyMac180/chroma-sync/releases)
2. Extract the files to your vault's `.obsidian/plugins/chroma-sync/` directory
3. Enable the plugin in Obsidian Settings → Community Plugins

### Option 2: From Obsidian Community Plugins (Future)

*This plugin will be available in the official Community Plugins directory after review.*

## Setup

1. **Enable the Plugin**: Go to Settings → Community Plugins and enable "Chroma Sync"

2. **Configure Chroma Cloud**: Go to Settings → Chroma Sync and enter:
   - **API Token**: Your Chroma Cloud API token
   - **Tenant**: Your tenant name (default: `default_tenant`)
   - **Database**: Your database name (default: `default_database`) 
   - **Collection**: Collection name for this vault (default: `obsidian_vault`)

3. **Test Connection**: Click "Test Connection" to verify your settings

4. **Configure Sync Options** (optional):
   - **Include Patterns**: File patterns to sync (default: `**/*.md`)
   - **Exclude Patterns**: File patterns to ignore (default: `**/.obsidian/**`)
   - **Python Path**: Path to Python executable (default: `python3`)
   - **Run on App Open**: Auto-sync when Obsidian starts (default: enabled)

5. **Enable Content Extraction** (optional):
   - **PDF Text Extraction**: Install PyPDF2 for PDF content: `pip install PyPDF2`
   - **Image OCR**: Install OCR dependencies: `pip install Pillow pytesseract`
   - Note: These are optional features with graceful fallback if not available

## Content Extraction Features

### PDF Text Extraction

When PyPDF2 is installed, the plugin can extract text content from PDF files:

```bash
pip install PyPDF2
```

- PDF files with `requiresExtraction: true` in metadata will have their text extracted
- Placeholder `[PDF_CONTENT_PLACEHOLDER]` in notes will be replaced with extracted text
- Page-by-page extraction with error handling for corrupt pages
- Graceful fallback if PyPDF2 is not available

### Image OCR

When Pillow and pytesseract are installed, the plugin can extract text from images:

```bash
pip install Pillow pytesseract
```

**Additional Setup:**
- **macOS**: `brew install tesseract`
- **Ubuntu/Debian**: `sudo apt install tesseract-ocr`
- **Windows**: Download from [GitHub](https://github.com/UB-Mannheim/tesseract/wiki)

- Image files with `requiresOCR: true` in metadata will have their text extracted
- Placeholder `[IMAGE_OCR_PLACEHOLDER]` in notes will be replaced with OCR text
- Supports PNG, JPEG, GIF, BMP, TIFF, and WebP formats
- Graceful fallback if dependencies are not available

## Usage

### Automatic Sync

When enabled, the plugin will automatically sync your vault:
- **On startup**: After workspace is ready (non-blocking)
- **First run**: Performs complete vault ingestion
- **Subsequent runs**: Only syncs changed files

### Manual Sync

You can manually trigger a sync:
- **Ribbon Button**: Click the sync icon in the left sidebar
- **Command Palette**: Run "Sync vault to Chroma Cloud"
- **Hotkey**: Assign a custom hotkey in Settings → Hotkeys

### Monitoring

- **Status Bar**: Shows current sync status in the bottom bar
- **Progress**: Real-time progress updates during sync
- **Notices**: Success/error notifications
- **Logs**: View detailed logs via Settings → Chroma Sync → Open Logs

## File Filtering

The plugin uses glob patterns to determine which files to sync:

### Default Patterns

- **Include**: `**/*.md` (all Markdown files)
- **Exclude**: `**/.obsidian/**` (Obsidian config files)

### Custom Patterns

You can customize patterns in Settings → Chroma Sync:

**Include Examples:**
```
**/*.md           # All Markdown files
**/*.txt          # All text files  
notes/**/*.md     # Only Markdown in notes folder
daily/*.md        # Only daily notes
```

**Exclude Examples:**
```
**/.obsidian/**   # Obsidian config (recommended)
**/templates/**   # Template files
**/*private*      # Files with "private" in name
drafts/**         # Entire drafts folder
```

## Python Environment

The plugin automatically manages its Python environment:

1. **Virtual Environment**: Creates `.venv` in plugin data folder
2. **Dependencies**: Installs required packages (`chromadb`, `requests`)
3. **Isolation**: Keeps dependencies separate from your system Python

### Troubleshooting Python Issues

If Python setup fails:

1. **Check Python Version**:
   ```bash
   python3 --version  # macOS/Linux
   python --version   # Windows
   ```

2. **Manual venv Creation**:
   ```bash
   cd ~/.obsidian/plugins/chroma-sync/python
   python3 -m venv .venv
   source .venv/bin/activate  # macOS/Linux
   # .venv\Scripts\activate   # Windows
   pip install -r requirements.txt
   ```

3. **Custom Python Path**: Set full path in Settings → Chroma Sync → Python Path
   - macOS: `/usr/bin/python3` or `/opt/homebrew/bin/python3`
   - Windows: `C:\Python39\python.exe`
   - Linux: `/usr/bin/python3`

## Security

- **Token Storage**: Your Chroma Cloud token is stored in Obsidian's settings (local only)
- **No Logging**: Tokens are never written to logs or console
- **HTTPS**: All communication with Chroma Cloud uses HTTPS
- **Local Processing**: File content is processed locally before sending to Chroma

## Performance

- **Startup**: Sync is deferred until after workspace loads (non-blocking)
- **Delta Sync**: Only changed files are processed after first run
- **Batching**: Documents are sent in configurable batches (default: 100)
- **Hashing**: Uses SHA-256 to detect content changes efficiently

## Development

### Building from Source

1. **Clone Repository**:
   ```bash
   git clone https://github.com/DannyMac180/chroma-sync.git
   cd chroma-sync
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Build Plugin**:
   ```bash
   npm run build     # Production build
   npm run dev       # Development build (watch mode)
   ```

4. **Run Tests**:
   ```bash
   npm test          # Unit tests
   npm run typecheck # Type checking
   npm run lint      # Linting
   ```

### Project Structure

```
chroma-sync/
├── src/
│   ├── main.ts       # Plugin entry point
│   ├── settings.ts   # Settings UI and schema
│   ├── delta.ts      # File change detection
│   └── runner.ts     # Python integration
├── python/
│   ├── index_vault.py      # Chroma indexing script
│   ├── test_connection.py  # Connection testing
│   └── requirements.txt    # Python dependencies
├── tests/
│   └── delta.test.ts # Unit tests
├── manifest.json     # Plugin manifest
├── package.json      # NPM configuration
└── README.md
```

## Troubleshooting

### Common Issues

**"Python not found"**
- Ensure Python 3.9+ is installed and on PATH
- Try setting custom Python path in settings
- Check plugin logs for specific error

**"Connection failed"**
- Verify your Chroma Cloud token is correct
- Check tenant/database names
- Ensure internet connection
- Try "Test Connection" in settings

**"Sync failed"**
- Check plugin logs for details
- Verify Python environment is set up
- Try manual sync to see specific errors
- Check Chroma Cloud service status

**Large vault performance**
- Consider excluding non-essential files
- Adjust batch size in settings
- Monitor system resources during sync

### Getting Help

1. **Check Logs**: Settings → Chroma Sync → Open Logs
2. **GitHub Issues**: [Report issues](https://github.com/DannyMac180/chroma-sync/issues)
3. **Obsidian Forum**: Community support
4. **Documentation**: [Chroma Cloud docs](https://docs.trychroma.com)

## Roadmap

- [ ] **v0.2**: OCR support for images
- [ ] **v0.3**: Client-side embeddings option  
- [ ] **v0.4**: Real-time sync on file changes
- [ ] **v0.5**: Multiple collection support
- [ ] **v1.0**: Full feature parity and stability

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Obsidian](https://obsidian.md) for the amazing knowledge management platform
- [Chroma](https://trychroma.com) for the powerful vector database
- The Obsidian plugin development community

---

**⚠️ Important**: This plugin is for desktop use only and requires Python 3.9+. Make sure to test with a backup of your vault before first use.
