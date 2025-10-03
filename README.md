# cordify
Update 25/09/25
Live site: https://renmurry.github.io/cordify/

## Local development

Because PWAs and service workers require HTTP(s), use a simple static server rather than opening the HTML file directly.

On Windows PowerShell you can run a quick server in this folder using Python or Node.js:

- Python 3
	- `python -m http.server 5173`
	- Then open http://localhost:5173/

- Node (if installed)
	- `npx serve -l 5173 .`
	- Then open http://localhost:5173/

Service worker caches assets for offline use. To see updates:
- Do a hard refresh, or
- In DevTools > Application > Service Workers, click Unregister, then reload.

## Notes
- History is stored in localStorage (max ~1000 entries).
- Export to CSV/XLSX uses SheetJS via CDN; requires network on first load.
- The app works under GitHub Pages subpaths thanks to relative asset URLs and SW scope `./`.
