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

// SHM + caching
$ram_size          = 6 * 1024 * 1024;
$index_key         = 'qs_src_idx';
$index_ts_key      = 'qs_src_idx_ts';
$index_ttl         = 1800;  // seconds
$lock_key          = 'qs_build_lock';
$lock_ttl          = 20;    // seconds

// Scan limits
$max_files         = 10000; // cap number of files to index
$max_depth         = 12;    // recursion depth
$max_text_per_file = 300;   // per-file strings cap
$max_index_size    = 50000; // overall index cap
$max_str_len       = 220;   // truncate long strings

// Conservative directory excludes (prefix match). Keep packages included.
$exclude_dirs = [
  '/usr/local/www/vendor',
  '/usr/local/www/assets',
  '/usr/local/www/js',
  '/usr/local/www/css',
  '/usr/local/www/images',
  '/usr/local/www/img',
  '/usr/local/www/apple-touch',
  '/usr/local/www/widgets', // exclude widgets directory entirely
];

// ---------- SHM CACHE ----------
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

// ---------- ADMIN OPS ----------
if (isset($_GET['rebuild'])) {
  $cache->set($index_key, null);
  $cache->set($index_ts_key, null);
  $cache->set($lock_key, null);
  echo json_encode(['ok' => true, 'rebuilt' => true]);
  exit;
}

// ---------- HELPERS ----------
function norm_text(string $s, int $max = 220): string {
  $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
  $s = strip_tags($s);
  $s = preg_replace('/\s+/u', ' ', $s);
  $s = trim($s);
  if ($s === '') return '';
  if (mb_strlen($s) > $max) $s = mb_substr($s, 0, $max) . '…';
  return $s;
}

function looks_meaningful(string $s): bool {
  return (mb_strlen($s) >= 3) && (bool)preg_match('/[\p{L}]/u', $s);
}

function prettify_filename(string $base): string {
  $t = preg_replace('~\.php$~i', '', $base);
  $t = str_replace('_', ' ', $t);
  $t = preg_replace('~\s+~', ' ', $t);
  $t = trim($t);
  return $t !== '' ? ucwords($t) : $base;
}

// skip paths we do not want to show (files whose name contains "edit" or "widget")
function should_skip_path(string $path): bool {
  $lp = strtolower($path);
  if (strpos($lp, '/widgets/') !== false) return true;             // any widgets folder
  $base = strtolower(basename($lp));
  if (strpos($base, 'edit') !== false) return true;                 // *_edit.php, pkg_edit.php, etc.
  if (strpos($base, 'widget') !== false) return true;               // anything with "widget" in filename
  return false;
}

// Resolve human title from source (##|*NAME=..., $pgtitle..., fallback to filename)
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

// Pull likely UI strings from PHP source (labels, help, headings, etc.)
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

// Recursively collect *.php under /usr/local/www (follows symlinks)
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
      if (should_skip_path($path)) continue; // <---- skip unwanted files
      $out[] = $path;
      if (count($out) >= $max_files) break;
    }
  } catch (Throwable $e) { /* ignore */ }

  sort($out, SORT_NATURAL | SORT_FLAG_CASE);
  return $out;
}

// Build index: per-file snippets + path + resolved page title
function build_source_index(
  int $max_files, int $per_file_cap, int $max_index, int $max_str_len,
  int $max_depth, array $exclude_dirs
): array {
  $files = collect_php_files_recursive('/usr/local/www', $max_files, $max_depth, $exclude_dirs);

  $out = [];
  foreach ($files as $fp) {
    if (should_skip_path($fp)) continue; // double safety
    $size = @filesize($fp); if ($size === false || $size <= 0) continue;
    if ($size > 1500000) continue;
    $src = @file_get_contents($fp); if (!is_string($src) || $src === '') continue;

    // Web path relative to /usr/local/www (e.g. /pfblockerng/pfblockerng_general.php)
    $prefix = '/usr/local/www';
    $rel = (strncmp($fp, $prefix.'/', strlen($prefix)+1) === 0) ? substr($fp, strlen($prefix)) : '/' . basename($fp);
    $path = $rel;

    $base = basename($fp);
    $pageTitle = derive_page_title_from_php($src, $base);
    $texts = extract_texts_from_php($src, $per_file_cap, $max_str_len);
    if (!$texts) $texts = [prettify_filename($base)];

    foreach ($texts as $t) {
      $out[] = [
        'id'    => count($out) + 1,
        'title' => $t,
        'path'  => $path,
        'page'  => $pageTitle,
      ];
      if (count($out) >= $max_index) break 2;
    }
  }

  return $out;
}

// ---------- SEARCH ----------
function norm(string $s): string {
  $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
  $s = preg_replace('/\s+/u', ' ', $s);
  return mb_strtolower(trim($s));
}
function token_regex(string $t): string {
  $q = preg_quote($t, '/');
  return '/(?<![\pL\pN])' . $q . '(?![\pL\pN])/ui';
}

// Score using token boundary matches + substr fallbacks + tiny path bonus
function score_item(array $it, array $words, array $regexes, string $qnorm): float {
  $text = norm($it['title'] ?? '');
  $path = norm($it['path']  ?? '');
  if ($text === '') return 0.0;

  $hits = 0.0;
  $n = count($words);
  for ($i = 0; $i < $n; $i++) {
    $w  = $words[$i];
    $rx = $regexes[$i];
    if (@preg_match($rx, $text))       $hits += 1.0;
    elseif (strpos($text, $w) !== false) $hits += 0.4;
    if ($w !== '' && strpos($path, $w) !== false) $hits += 0.1;
  }
  if ($hits <= 0.0) return 0.0;

  $score = $hits;
  if (@preg_match(token_regex($qnorm), $text)) $score += 0.6;
  return $score;
}

// Dedup by path; expose NAME in several keys so any frontend shows it
function search_ranked(array $docs, string $q, int $limit = 50): array {
  $qnorm = norm($q); if ($qnorm === '') return [];
  $words   = array_values(array_filter(preg_split('/\s+/u', $qnorm)));
  $regexes = array_map('token_regex', $words);

  $cands = [];
  foreach ($docs as $it) {
    if (should_skip_path($it['path'] ?? '')) continue; // <---- filter at result stage too
    $s = score_item($it, $words, $regexes, $qnorm);
    if ($s > 0) $cands[] = $it + ['_score' => $s];
  }
  if (!$cands) return [];

  usort($cands, function ($a, $b) {
    if ($a['_score'] === $b['_score']) return strcmp($a['title'], $b['title']);
    return ($a['_score'] < $b['_score']) ? 1 : -1;
  });

  $seenPath = []; $out = [];
  foreach ($cands as $it) {
    $path = $it['path'] ?? '';
    if ($path === '' || isset($seenPath[$path])) continue;
    $seenPath[$path] = 1;

    $name = $it['page'] ?? prettify_filename(basename($path));
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

// ---------- MAIN ----------
if ($q === '') {
  echo json_encode(['items' => []]);
  exit;
}

$docs = $cache->get($index_key) ?: [];
$ts   = (int)($cache->get($index_ts_key) ?? 0);
$now  = time();

if (!is_array($docs) || !count($docs)) {
  $docs = build_source_index($max_files, $max_text_per_file, $max_index_size, $max_str_len, $max_depth, $exclude_dirs);
  $cache->set($index_key, $docs);
  $cache->set($index_ts_key, $now);
} elseif (($now - $ts) > $index_ttl) {
  $lu = (int)($cache->get($lock_key) ?? 0);
  if ($lu < $now) {
    $cache->set($lock_key, $now + $lock_ttl);
    $new = build_source_index($max_files, $max_text_per_file, $max_index_size, $max_str_len, $max_depth, $exclude_dirs);
    if (is_array($new) && count($new)) {
      $docs = $new;
      $cache->set($index_key, $docs);
      $cache->set($index_ts_key, $now);
    }
    $cache->set($lock_key, null);
  }
}

$items = search_ranked($docs, $q, $limit);

// Debug modes:
//   ?debug=1                       -> items + counters
//   ?debug=scan&q=pfblocker        -> sample entries whose path contains 'pfblocker'
if (!empty($_GET['debug'])) {
  if ($_GET['debug'] === 'scan') {
    $needle = strtolower((string)($_GET['q'] ?? 'pfblocker'));
    $sample = [];
    foreach ($docs as $d) {
      $p = strtolower($d['path'] ?? '');
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
    ],
  ], JSON_UNESCAPED_UNICODE);
  exit;
}

echo json_encode(['items' => $items], JSON_UNESCAPED_UNICODE);

