# Obsidian Hugo Export Plugin

A plugin for Obsidian.md that exports notes to Hugo-compatible markdown files, handling front matter, wikilinks, and image references.

## Features

- **Single & Batch Export**: Export the active note or multiple open notes at once
- **Front Matter Handling**: Automatically generates Hugo-compatible front matter (title, date)
- **Wikilink Conversion**: Transforms Obsidian wikilinks to Hugo-style markdown links
- **Image Processing**:
  - Finds images in common attachment locations
  - Copies images to Hugo's static directory
  - Updates image references in exported markdown
- **Code Block Preservation**: Safely processes content without modifying code blocks
- **Context Menu Integration**: Right-click on notes to export them
- **Customizable Paths**: Set your Hugo content and static directories

## Installation

1. Go to Obsidian's Settings → Community plugins
2. Click "Browse" and search for "Obsidian Hugo Export"
3. Install the plugin
4. Enable the plugin in your community plugins list

## Usage

1. **Set up paths** in plugin settings:
   - Hugo Posts Directory (default: `~/hugo-blog/content/posts`)
   - Hugo Static Images Directory (default: `~/hugo-blog/static/images`)

2. Export notes using:
   - **Command Palette**: 
     - "Export Active Note to Hugo"
     - "Export Open Notes to Hugo"
   - **Right-click context menu** on markdown files

## Configuration

Access settings via:
- Obsidian Settings → Community plugins → Hugo Export → Settings

Configure:
- Paths to your Hugo directories
- Debug mode (for troubleshooting)

## Troubleshooting

- Enable debug mode in settings to see detailed logs in the console
- Check that paths are correct and writable
- Images must be stored in standard locations (same folder as note, attachments folder, etc.)

## Support

For issues or feature requests, please open an issue on the GitHub repository.
