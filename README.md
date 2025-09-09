# pfSense QuickSearch (Inline)

A tiny, fast **global search** for the pfSense® web GUI.
It adds a compact **Find** box to the top navbar and a backend that performs a **full-text search across `/usr/local/www/**/*.php`** (including package pages like pfBlockerNG). Results show **human page names** and open the corresponding GUI page in one click.

> No external requests. No disk writes. Caches in RAM (SysV shared memory). Auth required.

---

## Features

* **Inline UI** in the fixed top navbar (always available, no modal).
* **Recursive indexing** of `/usr/local/www` and its subfolders.
* **Human titles** from pfSense page metadata (`##|*NAME=…`) or `$pgtitle`, with clean fallbacks.
* **Fast searches** with a ranked matcher and de-duplicated results.
* **Shared-memory cache** (SysV shm+sem) with automatic background refresh.
* **Safe by default**:

  * Works **only for authenticated users**.
  * **Offline** (reads local PHP sources only).
  * Excludes vendor/assets and **filters out editor and widget pages**
    (any filename containing `edit` or `widget`, plus the `/widgets/` directory).
* **Minimal, theme-friendly UI**: no layout shifts, fixed button width, dropdown results.

---

## What’s in the repo

```
/usr/local/www/diag_quicksearch.php     # backend: JSON search endpoint & indexer
/usr/local/www/js/quicksearch_inline.js # frontend: inline Find box + dropdown
```

---

## Compatibility

* pfSense® Plus / CE (tested with recent builds).
* Requires PHP with SysV IPC extensions (present on pfSense by default).

---

## Installation

### Option A — Manual (simple & explicit)

1. Copy files to the firewall:

   ```
   /usr/local/www/diag_quicksearch.php
   /usr/local/www/js/quicksearch_inline.js
   ```

2. Ensure the JS is loaded on every page. Add this line to **`/usr/local/www/head.inc`** inside `<head>` (anywhere after the CSS includes is fine):

   ```php
   <script src="/js/quicksearch_inline.js?v=<?=filemtime('/usr/local/www/js/quicksearch_inline.js')?>"></script>
   ```

3. Reload any GUI page. You should see a **Find** box in the top-right navbar.

### Option B — Package (if you built a `.pkg`)

```sh
pkg add /root/pfsense-quicksearch-<version>.pkg
```

The package installs both files and patches `head.inc` to inject the script.
To remove:

```sh
pkg delete pfsense-quicksearch
# If you installed manually, also remove the <script> line from head.inc
```

---

## Usage

1. Click the **Find** field (top-right), type a query (e.g. `pfblocker`, `reboot`, `gateways`).
2. Press **Enter** or click **Find**.
3. Pick a result from the dropdown to navigate.

**Tip:** Results are page-level (deduplicated by target path) and show the friendly NAME of a page when available.

---

## Endpoint / API

The backend is a simple JSON endpoint:

```
GET /diag_quicksearch.php?q=<query>
```

Responses:

```json
{
  "items": [
    { "id": 1, "title": "Diagnostics: Reboot System", "path": "/diag_reboot.php" },
    ...
  ]
}
```

### Extras

* **Rebuild index** (clear cache and rebuild on next request):

  ```
  /diag_quicksearch.php?rebuild=1
  ```
* **Debug counters**:

  ```
  /diag_quicksearch.php?q=<query>&debug=1
  ```
* **Scan sample** (show a sample of indexed docs whose path contains a needle):

  ```
  /diag_quicksearch.php?debug=scan&q=pfblocker
  ```

All endpoints require an authenticated GUI session.

---

## Configuration

Edit the **SETTINGS** section near the top of `diag_quicksearch.php` if you want to tune behavior:

* `index_ttl` – how long (seconds) to keep the in-RAM index before a background refresh.
* `max_files`, `max_depth` – recursion and indexing caps.
* `exclude_dirs` – conservative directory blacklist (vendor/assets/widgets/js/css, etc.).
* **Filtering**: `should_skip_path()` excludes any filename that contains `edit` or `widget` (case-insensitive) and anything under `/widgets/`. Adjust to your needs.

---

## How it works

* On first query, the backend scans `/usr/local/www/**/*.php`, extracts meaningful UI strings from each file (labels, headings, help, gettext, Form\_\* builders, etc.), and builds a compact in-RAM index (`SysV shm`).
* Subsequent requests use the cache. After `index_ttl` seconds the index refreshes in the background (with a lock to avoid stampedes).
* The inline JS calls the endpoint, renders a dropdown, and navigates on click.

---

## Troubleshooting

* **No Find box appears**
  Ensure the `<script src="/js/quicksearch_inline.js">` line was added to `head.inc` and the file exists at `/usr/local/www/js/quicksearch_inline.js`.

* **No results**
  Make sure you are **logged in**. Try reloading `/diag_quicksearch.php?rebuild=1`.

* **Alignment/theme issues**
  The UI uses Bootstrap navbar classes present in pfSense. If your custom theme shifts things, tweak the small CSS block at the top of `quicksearch_inline.js`.

* **PHP error**
  Check **Status → System Logs → System → General** and verify file permissions/ownership (`root:wheel`, 0644 is fine).

---

## Security & Privacy

* Works only for authenticated GUI users (checks `$_SESSION['Username']`).
* Reads local PHP sources, no external requests.
* No writes to disk; the index lives in shared memory.
* Returned JSON is limited to friendly titles + target paths under `/usr/local/www`.

---

## Roadmap

* Fix reported issues 

---

## Acknowledgements

* Built for pfSense® web GUI.
* Uses standard PHP SPL iterators and SysV IPC.

---

## License

Apache-2.0 (see `LICENSE` in this repository).
pfSense® is a registered trademark of Rubicon Communications, LLC (Netgate). This project is community-maintained and not affiliated with Netgate.
