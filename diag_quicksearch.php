<?php
/*
 * diag_quicksearch.php
 *
 * part of pfSense (https://www.pfsense.org)
 * Copyright (c) 2015-2025 Rubicon Communications, LLC (Netgate)
 * All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

declare(strict_types=1);

// ---------- AUTH ----------
require_once('guiconfig.inc');
@include_once('authgui.inc'); // optional on some systems
if (session_status() !== PHP_SESSION_ACTIVE) { @session_start(); }
if (empty($_SESSION['Username'])) { http_response_code(401); exit; }

// ---------- HEADERS ----------
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

// ---------- SETTINGS ----------
$q                 = isset($_GET['q']) ? trim((string)$_GET['q']) : '';
$limit             = 50;

// Shared-memory cache sizes/keys
$ram_size          = 6 * 1024 * 1024;
$index_key         = 'qs_src_idx';
$index_ts_key      = 'qs_src_idx_ts';
$index_ttl         = 1800;  // seconds
$lock_key          = 'qs_build_lock';
$lock_ttl          = 20;    // seconds

// Synonyms cache (multilingual)
$syn_key           = 'qs_syn_map';
$syn_ts_key        = 'qs_syn_ts';
$syn_ttl           = 1800;  // seconds

// Scan limits for /usr/local/www
$max_files         = 10000; // max number of PHP files to index
$max_depth         = 12;    // recursion depth
$max_text_per_file = 300;   // per-file extracted strings cap
$max_index_size    = 50000; // overall index cap
$max_str_len       = 220;   // truncate long strings

// Extra sources caps
$max_pkg_xml_items   = 200; // /usr/local/pkg/*.xml
$max_menu_json_items = 400; // /usr/local/share/pfSense/menu.d/*.json

// Conservative directory excludes (prefix match). Keep packages included.
$exclude_dirs = [
  '/usr/local/www/vendor',
  '/usr/local/www/assets',
  '/usr/local/www/js',
  '/usr/local/www/css',
  '/usr/local/www/images',
  '/usr/local/www/img',
  '/usr/local/www/apple-touch',
  '/usr/local/www/widgets', // exclude widgets entirely
];

// ---------- SHM CACHE WRAPPER ----------
class QsCache {
  private $key;
  private $sem;
  private $shm;

  function __construct(string $ftokPath, string $proj = 'Q', int $size = 4194304) {
    $this->key = ftok($ftokPath, $proj);
    if ($this->key === -1) throw new RuntimeException('ftok failed');
    $this->sem = sem_get($this->key, 1, 0600, true);
    if ($this->sem === false) throw new RuntimeException('sem_get failed');
    $this->shm = shm_attach($this->key, $size, 0600);
    if ($this->shm === false) throw new RuntimeException('shm_attach failed');
  }

  function get(string $k) {
    sem_acquire($this->sem);
    $map = shm_has_var($this->shm, 1) ? shm_get_var($this->shm, 1) : [];
    $v   = $map[$k] ?? null;
    sem_release($this->sem);
    return $v;
  }

  function set(string $k, $v): void {
    sem_acquire($this->sem);
    $map = shm_has_var($this->shm, 1) ? shm_get_var($this->shm, 1) : [];
    if ($v === null) unset($map[$k]); else $map[$k] = $v;
    shm_put_var($this->shm, 1, $map);
    sem_release($this->sem);
  }
}

$cache = new QsCache('/usr/local/www/index.php', 'Q', $ram_size);

// ---------- ADMIN/UTILITY ENDPOINTS ----------

/*
 * Rebuild endpoint:
 * - Clears source index, synonyms and build lock.
 * - Frontend calls this before a forced re-search.
 */
if (isset($_GET['rebuild'])) {
  $cache->set($index_key, null);
  $cache->set($index_ts_key, null);
  $cache->set($lock_key, null);
  $cache->set($syn_key, null);
  $cache->set($syn_ts_key, null);
  echo json_encode(['ok' => true, 'rebuilt' => true]);
  exit;
}

/*
 * i18n strings endpoint for the JS widget:
 * - Returns a small set of UI labels translated to active GUI language.
 */
if (isset($_GET['i18n'])) {
  echo json_encode([
    'find'          => gettext('Find'),
    'no_results'    => gettext('No results...'),
    'request_error' => gettext('Request error'),
    'rebuild_tip'   => gettext('Rebuild index & repeat search'),
  ], JSON_UNESCAPED_UNICODE);
  exit;
}

// ---------- TEXT/UNICODE HELPERS ----------

/**
 * Normalize a UI text snippet: strip HTML, collapse whitespace, truncate.
 */
function norm_text(string $s, int $max = 220): string {
  $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
  $s = strip_tags($s);
  $s = preg_replace('/\s+/u', ' ', $s);
  $s = trim($s);
  if ($s === '') return '';
  if (mb_strlen($s) > $max) $s = mb_substr($s, 0, $max) . '…';
  return $s;
}

/**
 * Heuristic: looks like a meaningful text line (has letters and len>=3).
 */
function looks_meaningful(string $s): bool {
  return (mb_strlen($s) >= 3) && (bool)preg_match('/[\p{L}]/u', $s);
}

/**
 * Humanize a file name into a readable title (fallback).
 */
function prettify_filename(string $base): string {
  $t = preg_replace('~\.php$~i', '', $base);
  $t = str_replace('_', ' ', $t);
  $t = preg_replace('~\s+~', ' ', $t);
  $t = trim($t);
  return $t !== '' ? ucwords($t) : $base;
}

/**
 * Decide if a path should be suppressed from index and results (edit forms, widgets).
 */
function should_skip_path(string $path): bool {
  $lp = strtolower($path);
  if (strpos($lp, '/widgets/') !== false) return true; // any widgets folder
  $base = strtolower(basename($lp));
  if (strpos($base, 'edit') !== false) return true;    // *_edit.php, pkg_edit.php, etc.
  if (strpos($base, 'widget') !== false) return true;  // filenames containing "widget"
  return false;
}

/**
 * Localize a label to current GUI language:
 *  1) Try pfSense main domain.
 *  2) If path is a package (/pkg.php?xml=<pkg>.xml), try pfSense-pkg-<pkg>.
 */
function tr(string $s, string $path = ''): string {
  if ($s === '') return $s;
  // main pfSense domain
  $t = function_exists('dgettext') ? dgettext('pfSense', $s) : gettext($s);
  if ($t !== $s) return $t;

  // package domain guess (e.g., pfSense-pkg-filer)
  if ($path && preg_match('~^/pkg\.php\?xml=([a-z0-9_-]+)\.xml~i', $path, $m)) {
    $dom = 'pfSense-pkg-' . $m[1];
    if (function_exists('dgettext')) {
      $u = dgettext($dom, $s);
      if ($u !== $s) return $u;
    }
  }
  return $s; // fallback to original
}

/**
 * Translate a breadcrumb-like title token-by-token.
 * Supports separators "/", ":" with arbitrary surrounding spaces.
 * Each token is looked up via gettext (pfSense domain + optional package domain).
 */
function tr_title_smart(string $s, string $path = ''): string {
  if ($s === '') return $s;

  // Split and keep delimiters to reassemble original punctuation/spaces
  $parts = preg_split('/(\s*(?:\/|:)\s*)/u', $s, -1, PREG_SPLIT_DELIM_CAPTURE);
  if (!is_array($parts) || !$parts) {
    // Fallback: translate as a whole phrase
    return tr($s, $path);
  }

  // Even indexes are tokens, odd indexes are the captured separators
  for ($i = 0; $i < count($parts); $i += 2) {
    $tok = trim($parts[$i]);
    if ($tok !== '') {
      $parts[$i] = tr($tok, $path);
    }
  }
  return implode('', $parts);
}

// ---------- MULTILINGUAL NORMALIZATION ----------

/**
 * Normalize & lowercase (NFC where possible).
 */
function u_norm(string $s): string {
  if (class_exists('Normalizer')) {
    $s = Normalizer::normalize($s, Normalizer::FORM_C);
  }
  $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
  $s = preg_replace('/\s+/u', ' ', $s);
  return mb_strtolower(trim($s), 'UTF-8');
}

/**
 * Fold diacritics and normalize variant letters (e.g., ё->е, ß->ss).
 */
function u_fold(string $s): string {
  $s = u_norm($s);
  $s = str_replace('ё', 'е', $s);
  if (class_exists('Normalizer')) {
    $d = Normalizer::normalize($s, Normalizer::FORM_D);
    if ($d !== false) {
      $s = preg_replace('/\p{M}+/u', '', $d);
      $s = Normalizer::normalize($s, Normalizer::FORM_C) ?: $s;
    }
  }
  $s = str_replace('ß', 'ss', $s);
  return $s;
}

/**
 * Best-effort transliteration to Latin ASCII for cross-language matching.
 */
function u_translit_any_latin(string $s): string {
  if (function_exists('transliterator_transliterate')) {
    $t = @transliterator_transliterate('Any-Latin; Latin-ASCII', $s);
    if (is_string($t) && $t !== '') return $t;
  }
  $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
  return is_string($t) ? $t : $s;
}

/**
 * Tokenize into folded alphanumeric tokens.
 */
function u_tokens(string $s): array {
  $s = u_fold($s);
  $parts = preg_split('/[^\p{L}\p{N}]+/u', $s, -1, PREG_SPLIT_NO_EMPTY);
  return $parts ?: [];
}

/**
 * Very light Russian stemmer for UI matching (handles common endings).
 * Example: настройки ~ настройка -> "настройк".
 * If not Cyrillic or result too short, returns the original input.
 */
function ru_stem_light(string $s): string {
  if (!preg_match('/[А-Яа-яЁё]/u', $s)) return $s; // only for Cyrillic
  $w = $s;

  // Common 2–3 letter endings
  $w = preg_replace('/(ами|ями|ого|ему|ыми|ими|ией|иях|ях|ев|ёв|ов|ие|ые|ий|ый|ой|ая|яя|ую|ью|ам|ям|ах|ях|ки|ка|ок|ек)$/u', '', $w, 1);
  // One-letter endings
  $w = preg_replace('/[аеиоуыэюяйьъ]$/u', '', $w, 1);

  if (mb_strlen($w, 'UTF-8') >= 4) return $w;
  return $s;
}

/**
 * Load multilingual synonyms from disk:
 *  - /usr/local/share/pfSense/quicksearch/synonyms/*.json
 *  - Each file: { "phrase": ["syn1","syn2"] }
 *  - Keys and values are folded for matching.
 *  - Includes a small built-in fallback for common terms.
 */
function load_synonyms_from_disk(): array {
  $root = '/usr/local/share/pfSense/quicksearch/synonyms';
  $map = [];
  foreach ((array)glob($root . '/*.json') as $f) {
    $j = json_decode(@file_get_contents($f), true);
    if (!is_array($j)) continue;
    foreach ($j as $k => $arr) {
      $k = u_fold((string)$k);
      $arr = array_map('u_fold', (array)$arr);
      $map[$k] = array_values(array_unique(array_filter($arr, 'strlen')));
    }
  }
  // Minimal fallback to work out-of-the-box
  $fallback = [
    'файлер'             => ['filer','file manager'],
    'файловый менеджер'  => ['file manager','filer'],
    'диспетчер файлов'   => ['file manager','filer'],
    'настройка'          => ['settings','configuration','setup'],
    'настройки'          => ['settings','configuration'],
    'failihaldur'        => ['file manager','filer'],
    'failide haldus'     => ['file manager'],
    'fail'               => ['file'],
  ];
  foreach ($fallback as $k => $arr) {
    $kf = u_fold($k);
    $vf = array_map('u_fold', $arr);
    if (empty($map[$kf])) $map[$kf] = $vf;
  }
  return $map;
}

/**
 * Expand query terms with synonyms and transliteration tokens.
 */
function expand_query_terms(string $q, array $syn_map): array {
  $base  = u_tokens($q);
  $extra = [];

  // synonyms expansion
  foreach ($base as $t) {
    if (!empty($syn_map[$t])) $extra = array_merge($extra, (array)$syn_map[$t]);
  }

  // transliteration expansion
  $lat = u_translit_any_latin($q);
  if ($lat && $lat !== $q) {
    $extra = array_merge($extra, u_tokens($lat));
  }

  $all = array_values(array_unique(array_filter(array_merge($base, $extra), 'strlen')));
  return $all;
}

/**
 * Produce folded tokens for an indexed item.
 */
function item_tokens(array $it): array {
  $blob = implode(' ', array_filter([
    (string)($it['title'] ?? ''),
    (string)($it['page'] ?? ''),
    (string)($it['path'] ?? ''),
    is_array($it['keywords'] ?? null) ? implode(' ', $it['keywords']) : '',
  ]));
  return u_tokens($blob);
}

// ---------- PHP SOURCE PARSING (from /usr/local/www) ----------

/**
 * Resolve a human-readable title from PHP source (##|*NAME, $pgtitle, etc.)
 */
function derive_page_title_from_php(string $php_src, string $filename_base): string {
  if (preg_match('~^\s*##\|\*NAME\s*=\s*(.+)$~mi', $php_src, $m)) {
    $t = norm_text($m[1]); if ($t !== '') return $t;
  }
  if (preg_match('~^\s*##\|NAME\s*=\s*(.+)$~mi', $php_src, $m2)) {
    $t = norm_text($m2[1]); if ($t !== '') return $t;
  }

  $crumbs = [];

  if (preg_match_all('~\$pgtitle\s*=\s*array\s*\((.*?)\)\s*;~su', $php_src, $m)) {
    foreach ($m[1] as $in) {
      if (preg_match_all('~(?:gettext\s*\(\s*)?(["\'])(.*?)\1\s*\)?~su', $in, $mm)) {
        foreach ($mm[2] as $s) { $t = norm_text($s); if ($t !== '') $crumbs[] = $t; }
      }
    }
  }

  if (preg_match_all('~\$pgtitle\[\]\s*=\s*(?:gettext\s*\(\s*)?(["\'])(.*?)\1\s*\)?\s*;~su', $php_src, $m2)) {
    foreach ($m2[2] as $s) { $t = norm_text($s); if ($t !== '') $crumbs[] = $t; }
  }

  if (preg_match_all('~\$pgtitle\s*=\s*array_merge\s*\(\s*\$pgtitle\s*,\s*array\s*\((.*?)\)\s*\)\s*;~su', $php_src, $m3)) {
    foreach ($m3[1] as $in) {
      if (preg_match_all('~(?:gettext\s*\(\s*)?(["\'])(.*?)\1\s*\)?~su', $in, $mm)) {
        foreach ($mm[2] as $s) { $t = norm_text($s); if ($t !== '') $crumbs[] = $t; }
      }
    }
  }

  if (preg_match('~\$pgtitle\s*=\s*(?:gettext\s*\(\s*)?(["\'])(.*?)\1\s*\)?\s*;~su', $php_src, $m4)) {
    $t = norm_text($m4[2]); if ($t !== '') $crumbs[] = $t;
  }

  $u = []; foreach ($crumbs as $c) { $u[$c] = 1; } $crumbs = array_keys($u);
  if (!empty($crumbs)) return implode(' / ', $crumbs);

  return prettify_filename($filename_base);
}

/**
 * Extract likely UI strings from PHP (labels, headings, help, etc.)
 */
function extract_texts_from_php(string $php_src, int $cap = 300, int $maxlen = 220): array {
  $out = [];
  $add = function (string $t) use (&$out, $cap, $maxlen) {
    if (count($out) >= $cap) return;
    $t = norm_text($t, $maxlen);
    if ($t !== '' && looks_meaningful($t)) $out[] = $t;
  };

  if (preg_match_all('~gettext(?:_noop)?\s*\(\s*(["\'])(.*?)\1\s*\)~su', $php_src, $m))
    foreach ($m[2] as $s) $add($s);

  if (preg_match_all('~new\s+Form_[A-Za-z0-9_]+\s*\(\s*((?:(?!\)\s*;).)*)\)~su', $php_src, $m2))
    foreach ($m2[1] as $args)
      if (preg_match_all('~(["\'])(.*?)\1~su', $args, $mm))
        foreach ($mm[2] as $s) $add($s);

  if (preg_match_all('~->\s*setHelp\s*\(\s*(["\'])(.*?)\1\s*\)~su', $php_src, $m3))
    foreach ($m3[2] as $s) $add($s);

  if (preg_match_all('~<(h1|h2|legend|label|th|dt)[^>]*>(.*?)</\1>~siu', $php_src, $m4))
    foreach ($m4[2] as $s) $add($s);

  if (preg_match_all('~(?:title|label|help|description|header|caption)\s*[:=,\)]?\s*(?:\(|\[|,)?\s*(["\'])(.*?)\1~siu', $php_src, $m5))
    foreach ($m5[2] as $s) $add($s);

  $seen = []; $uniq = [];
  foreach ($out as $t) { if (!isset($seen[$t])) { $seen[$t] = 1; $uniq[] = $t; } }
  return $uniq;
}

/**
 * Recursively collect *.php under /usr/local/www (follows symlinks).
 */
function collect_php_files_recursive(string $root, int $max_files, int $max_depth, array $exclude_dirs): array {
  $root = rtrim($root, '/');
  $out  = [];
  try {
    $flags = FilesystemIterator::SKIP_DOTS | FilesystemIterator::FOLLOW_SYMLINKS;
    $inner = new RecursiveDirectoryIterator($root, $flags);

    $filter = new RecursiveCallbackFilterIterator($inner, function ($current) use ($exclude_dirs) {
      /** @var SplFileInfo $current */
      $p = $current->getPathname();
      foreach ($exclude_dirs as $pref) {
        if (strncmp($p, $pref, strlen($pref)) === 0) return false;
      }
      return true;
    });

    $it = new RecursiveIteratorIterator($filter, RecursiveIteratorIterator::SELF_FIRST);
    foreach ($it as $file) {
      if ($it->getDepth() > $max_depth) continue;
      /** @var SplFileInfo $file */
      if ($file->isDir()) continue;
      $path = $file->getPathname();
      if (substr($path, -4) !== '.php') continue;
      if (should_skip_path($path)) continue;
      $out[] = $path;
      if (count($out) >= $max_files) break;
    }
  } catch (Throwable $e) { /* ignore */ }

  sort($out, SORT_NATURAL | SORT_FLAG_CASE);
  return $out;
}

// ---------- EXTRA SOURCES (Packages & Menu) ----------

/**
 * Index package XML files (/usr/local/pkg/*.xml) into /pkg.php?xml=<name>.xml.
 */
function index_pkg_xml(int $cap = 200): array {
  $dir = '/usr/local/pkg';
  $out = [];
  foreach ((array)glob($dir . '/*.xml') as $xml) {
    if (count($out) >= $cap) break;
    $sx = @simplexml_load_file($xml);
    if (!$sx) continue;

    $base  = basename($xml, '.xml'); // e.g., "filer"
    $title = trim((string)($sx->menu->name ?? $sx->title ?? $sx->name ?? $base));
    if ($title === '') $title = $base;

    $descr = trim((string)($sx->descr ?? $sx->description ?? ''));
    $path  = "/pkg.php?xml={$base}.xml";

    // Base keywords plus package description (if any)
    $keywords = [$base];
    if ($descr !== '') $keywords[] = $descr;

    // Add localized tokens of the package title to help non-English queries
    $locTitle = tr_title_smart($title, $path);
    $keywords = array_values(array_filter(array_unique(array_merge($keywords, u_tokens($locTitle)))));

    $out[] = [
      'title'    => $title,
      'page'     => $title,
      'path'     => $path,
      'keywords' => $keywords,
    ];
  }
  return $out;
}

/**
 * Index menu JSON files (/usr/local/share/pfSense/menu.d/*.json).
 */
function index_menu_json(int $cap = 400): array {
  $dir = '/usr/local/share/pfSense/menu.d';
  $out = [];
  $walk = function ($node) use (&$out, &$walk, $cap) {
    if (count($out) >= $cap) return;
    if (!is_array($node)) return;

    $url = (string)($node['url'] ?? '');
    $txt = (string)($node['text'] ?? $node['name'] ?? $node['title'] ?? '');

    if ($url !== '') {
      // Build keywords: id/url/section + localized tokens of the text
      $locTxt  = tr_title_smart($txt, $url);
      $kwLocal = u_tokens($locTxt);
      $kws     = array_filter([(string)($node['id'] ?? ''), $url, (string)($node['section'] ?? '')]);
      $kws     = array_values(array_filter(array_unique(array_merge($kws, $kwLocal))));

      $out[] = [
        'title'    => $txt ?: $url,
        'page'     => $txt ?: prettify_filename(basename(parse_url($url, PHP_URL_PATH) ?: '')),
        'path'     => $url,
        'keywords' => $kws,
      ];
    }

    if (!empty($node['children']) && is_array($node['children'])) {
      foreach ($node['children'] as $ch) $walk($ch);
    }
  };

  foreach ((array)glob($dir . '/*.json') as $f) {
    $j = json_decode(@file_get_contents($f), true);
    if (!$j) continue;
    if (isset($j['children']) || isset($j['url'])) {
      $walk($j);
    } else {
      foreach ((array)$j as $root) $walk($root);
    }
    if (count($out) >= $cap) break;
  }

  return $out;
}

// ---------- INDEX BUILD (www + packages + menu) ----------

function build_source_index(
  int $max_files, int $per_file_cap, int $max_index, int $max_str_len,
  int $max_depth, array $exclude_dirs,
  int $max_pkg_xml_items, int $max_menu_json_items
): array {
  $files = collect_php_files_recursive('/usr/local/www', $max_files, $max_depth, $exclude_dirs);

  $out = [];
  foreach ($files as $fp) {
    if (should_skip_path($fp)) continue;
    $size = @filesize($fp); if ($size === false || $size <= 0) continue;
    if ($size > 1500000) continue;
    $src = @file_get_contents($fp); if (!is_string($src) || $src === '') continue;

    // Web path relative to /usr/local/www (e.g., /pfblockerng/pfblockerng_general.php)
    $prefix = '/usr/local/www';
    $rel = (strncmp($fp, $prefix.'/', strlen($prefix)+1) === 0) ? substr($fp, strlen($prefix)) : '/' . basename($fp);
    $path = $rel;

    $base = basename($fp);
    $pageTitle = derive_page_title_from_php($src, $base);
    $texts = extract_texts_from_php($src, $per_file_cap, $max_str_len);
    if (!$texts) $texts = [prettify_filename($base)];

    // Add localized (translated) tokens from the resolved page title
    $locPage   = tr_title_smart($pageTitle, $path);
    $locTokens = u_tokens($locPage);

    foreach ($texts as $t) {
      $out[] = [
        'id'       => count($out) + 1,
        'title'    => $t,
        'path'     => $path,
        'page'     => $pageTitle,
        'keywords' => $locTokens, // help matching non-English queries
      ];
      if (count($out) >= $max_index) break 2;
    }
  }

  // Add package XML items
  if (count($out) < $max_index) {
    $pkg = index_pkg_xml($max_pkg_xml_items);
    foreach ($pkg as $it) {
      if (count($out) >= $max_index) break;
      if (should_skip_path($it['path'] ?? '')) continue;
      $out[] = $it + ['id' => count($out) + 1];
    }
  }

  // Add menu JSON items
  if (count($out) < $max_index) {
    $menu = index_menu_json($max_menu_json_items);
    foreach ($menu as $it) {
      if (count($out) >= $max_index) break;
      if (should_skip_path($it['path'] ?? '')) continue;
      $out[] = $it + ['id' => count($out) + 1];
    }
  }

  return $out;
}

// ---------- SEARCH & RANK ----------

/**
 * Rank items using multilingual tokens:
 *  - Expand query via synonyms and transliteration.
 *  - Tokenize items (title/page/path/keywords).
 *  - Score by number of token hits, plus small bonus if path contains a term.
 *  - Fallbacks include substring match in localized title and light RU stemming.
 *  - Localize output names token-by-token (breadcrumb aware).
 */
function search_ranked(array $docs, string $q, int $limit, array $syn_map): array {
  $q = trim($q);
  if ($q === '') return [];

  $qterms = expand_query_terms($q, $syn_map);
  if (!$qterms) return [];

  $qset = array_flip($qterms);

  $cands = [];
  foreach ($docs as $it) {
    $path = (string)($it['path'] ?? '');
    if ($path === '' || should_skip_path($path)) continue;

    $iterms = item_tokens($it);
    if (!$iterms) continue;

    $hit = 0;
    foreach ($iterms as $t) if (isset($qset[$t])) $hit++;

    if ($hit <= 0) {
      // Fallbacks:
      // 1) substring in folded EN blob (title/page/path)
      // 2) substring in folded LOCALIZED page title
      // 3) substring by RU stem (настройка ~ настройки)
      $foldq   = u_fold($q);
      $foldtxt = u_fold(($it['title'] ?? '') . ' ' . ($it['page'] ?? '') . ' ' . $path);
      $foldloc = u_fold(tr_title_smart((string)($it['page'] ?? ''), $path));
      $ruStem  = ru_stem_light($foldq);

      if ($foldq !== '' && (strpos($foldtxt, $foldq) !== false || strpos($foldloc, $foldq) !== false)) {
        $hit = 1;
      } elseif ($ruStem !== $foldq && $ruStem !== '' &&
                (strpos($foldtxt, $ruStem) !== false || strpos($foldloc, $ruStem) !== false)) {
        $hit = 1;
      }
    }

    if ($hit > 0) {
      // Small bonus if any query term appears in the path
      $pbonus = 0.0;
      $fpath = u_fold($path);
      foreach ($qterms as $qt) {
        if ($qt !== '' && strpos($fpath, $qt) !== false) { $pbonus = 0.2; break; }
      }
      $score = (float)$hit + $pbonus;
      $cands[] = $it + ['_score' => $score];
    }
  }

  if (!$cands) return [];

  usort($cands, function ($a, $b) {
    if ($a['_score'] === $b['_score']) return strcmp((string)$a['title'], (string)$b['title']);
    return ($a['_score'] < $b['_score']) ? 1 : -1;
  });

  // Deduplicate by path and localize the label (token-by-token)
  $seenPath = []; $out = [];
  foreach ($cands as $it) {
    $path = (string)($it['path'] ?? '');
    if ($path === '' || isset($seenPath[$path])) continue;
    $seenPath[$path] = 1;

    $name = (string)($it['page'] ?? prettify_filename(basename($path)));
    $name = tr_title_smart($name, $path); // token-aware translation

    $out[] = [
      'id'      => count($out) + 1,
      'title'   => $name,
      'label'   => $name,
      'name'    => $name,
      'text'    => $name,
      'display' => $name,
      'path'    => $path,
    ];
    if (count($out) >= $limit) break;
  }

  return $out;
}

// ---------- MAIN FLOW ----------

if ($q === '') {
  echo json_encode(['items' => []]);
  exit;
}

// Load or rebuild source index (www + pkg XML + menu JSON)
$docs = $cache->get($index_key) ?: [];
$ts   = (int)($cache->get($index_ts_key) ?? 0);
$now  = time();

if (!is_array($docs) || !count($docs)) {
  $docs = build_source_index(
    $max_files, $max_text_per_file, $max_index_size, $max_str_len,
    $max_depth, $exclude_dirs, $max_pkg_xml_items, $max_menu_json_items
  );
  $cache->set($index_key, $docs);
  $cache->set($index_ts_key, $now);
} elseif (($now - $ts) > $index_ttl) {
  // TTL expired — rebuild under a short lock to avoid stampede
  $lu = (int)($cache->get($lock_key) ?? 0);
  if ($lu < $now) {
    $cache->set($lock_key, $now + $lock_ttl);
    $new = build_source_index(
      $max_files, $max_text_per_file, $max_index_size, $max_str_len,
      $max_depth, $exclude_dirs, $max_pkg_xml_items, $max_menu_json_items
    );
    if (is_array($new) && count($new)) {
      $docs = $new;
      $cache->set($index_key, $docs);
      $cache->set($index_ts_key, $now);
    }
    $cache->set($lock_key, null);
  }
}

// Load synonyms (from SHM if fresh; else from disk)
$syn_map = $cache->get($syn_key) ?: [];
$syn_ts  = (int)($cache->get($syn_ts_key) ?? 0);
if (!is_array($syn_map) || ($now - $syn_ts) > $syn_ttl) {
  $syn_map = load_synonyms_from_disk();
  $cache->set($syn_key, $syn_map);
  $cache->set($syn_ts_key, $now);
}

// Execute search
$items = search_ranked($docs, $q, $limit, $syn_map);

// ---------- DEBUG OUTPUTS ----------
if (!empty($_GET['debug'])) {
  if ($_GET['debug'] === 'scan') {
    $needle = strtolower((string)($_GET['q'] ?? 'pfblocker'));
    $sample = [];
    foreach ($docs as $d) {
      $p = strtolower((string)($d['path'] ?? ''));
      if ($needle !== '' && strpos($p, $needle) !== false) {
        $sample[] = $d;
        if (count($sample) >= 20) break;
      }
    }
    echo json_encode([
      'records_indexed' => is_array($docs) ? count($docs) : 0,
      'sample_matching' => $sample,
    ], JSON_UNESCAPED_UNICODE);
    exit;
  }

  echo json_encode([
    'items' => $items,
    'debug' => [
      'records_indexed' => is_array($docs) ? count($docs) : 0,
      'index_age_sec'   => $now - ($ts ?: $now),
      'synonyms_loaded' => count($syn_map),
    ],
  ], JSON_UNESCAPED_UNICODE);
  exit;
}

// ---------- NORMAL OUTPUT ----------
echo json_encode(['items' => $items], JSON_UNESCAPED_UNICODE);

