#!/usr/bin/env node
// vault-agent — Codex에게 Obsidian 위키의 "일부만" 맡긴다.
//
//   node vault-agent.mjs plan --seed "01_루틴/화.md" --message "턱걸이 5/5/4"   # 어떤 파일을 읽고 고칠지만 보여 준다
//   node vault-agent.mjs run  --seed ... --message ... [--dry-run] [--date YYYY-MM-DD]
//   node vault-agent.mjs undo                                                     # 마지막 run 반영을 되돌린다
//
// 네 가지 장치: ① 링크 그래프로 파일을 고르고 ② 고른 파일만 임시 폴더에 복사해 codex exec 를 샌드박스로 돌린 뒤
// ③ 허용 목록에 있는 파일만 위키로 돌려 쓰고 ④ 돌려 쓰기 직전 상태를 스냅샷으로 남긴다. 설정은 위키 루트의
// vault-agent.json, Codex 지시문은 거기 적힌 instructions 파일이다. 둘 다 `vault-agent.example.json` 과
// `instructions.example.md` 를 복사해 시작한다.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STATE_DIR = '.vault-agent';

// ---------------------------------------------------------------- 경로

export const rel = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

export function safeJoin(root, r) {
  const full = path.resolve(root, ...rel(r).split('/'));
  const back = path.relative(root, full);
  if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`위키 밖 경로: ${r}`);
  return full;
}

export function loadConfig(vault) {
  const file = path.join(vault, 'vault-agent.json');
  if (!existsSync(file)) throw new Error(`설정이 없습니다: ${file} (vault-agent.example.json 을 복사해 시작)`);
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['readableDirs', 'writableDirs', 'instructions']) {
    if (!cfg[key]) throw new Error(`vault-agent.json 에 ${key} 가 필요합니다`);
  }
  return {
    readOnly: [], alwaysRead: [], linkDepth: 1, recent: null, newNote: null, keywordDirs: cfg.writableDirs,
    ...cfg,
    readableDirs: cfg.readableDirs.map(rel), writableDirs: cfg.writableDirs.map(rel),
    readOnly: (cfg.readOnly ?? []).map(rel), alwaysRead: (cfg.alwaysRead ?? []).map(rel),
  };
}

const inDirs = (r, dirs) => dirs.some((d) => r === d || r.startsWith(`${d}/`));

// ---------------------------------------------------------------- 링크 그래프

export function wikiLinks(markdown) {
  const out = [];
  const re = /\[\[([^\]]+)]]/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

export function listNotes(vault, dirs) {
  const notes = [];
  const walk = (dir) => {
    const abs = safeJoin(vault, dir);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      const r = `${dir}/${name}`;
      if (statSync(safeJoin(vault, r)).isDirectory()) walk(r);
      else if (name.endsWith('.md')) notes.push(r);
    }
  };
  for (const d of dirs) walk(d);
  return notes;
}

// [[이름]] 을 readableDirs 안의 노트로 푼다. 경로가 있으면 그대로, 없으면 같은 이름의 노트를 찾는다.
export function resolveLink(target, notes) {
  const t = rel(target).replace(/\.md$/i, '');
  if (t.includes('/')) return notes.find((n) => n.replace(/\.md$/i, '') === t);
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  return notes.find((n) => norm(path.basename(n, '.md')) === norm(t));
}

export function selectFiles({ vault, cfg, seed, message, date }) {
  const notes = listNotes(vault, cfg.readableDirs);
  const read = new Set();
  const add = (r) => { if (r && existsSync(safeJoin(vault, r))) read.add(rel(r)); };

  for (const r of [...cfg.alwaysRead, ...cfg.readOnly]) add(r);
  add(seed);

  // 씨앗 노트에서 링크를 depth 만큼 따라간다.
  let frontier = seed ? [rel(seed)] : [];
  for (let depth = 0; depth < cfg.linkDepth && frontier.length; depth += 1) {
    const next = [];
    for (const r of frontier) {
      if (!existsSync(safeJoin(vault, r))) continue;
      for (const link of wikiLinks(readFileSync(safeJoin(vault, r), 'utf8'))) {
        const found = resolveLink(link, notes);
        if (found && !read.has(found)) { read.add(found); next.push(found); }
      }
    }
    frontier = next;
  }

  // 메시지에 이름이 나오는 노트(keywordDirs 안)도 읽고 고칠 수 있게 한다. 없는 이름으로 새 파일을 만들지는 않는다.
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  const text = norm(message ?? '');
  const keyword = text
    ? notes.filter((n) => inDirs(n, cfg.keywordDirs) && text.includes(norm(path.basename(n, '.md'))))
    : [];
  for (const r of keyword) read.add(r);

  // 최근 기록 N개 — 참고만 하고 고치지 않는다.
  const recent = new Set();
  if (cfg.recent?.dir) {
    for (const r of listNotes(vault, [rel(cfg.recent.dir)])
      .filter((n) => !date || path.basename(n) < date)
      .sort().reverse().slice(0, cfg.recent.limit ?? 3)) {
      read.add(r);
      recent.add(r);
    }
  }

  // 새로 만들 노트 (이미 그날 파일이 있으면 그것)
  let newNote = null;
  if (cfg.newNote && date) {
    const seedName = seed ? path.basename(seed, '.md').replace(/^\d+(?:-\d+)?\.\s*/, '') : '';
    newNote = rel(cfg.newNote.replace('{date}', date).replace('{seed}', seedName).replace(/[\\:*?"<>|]/g, '_'));
    const dir = path.dirname(newNote);
    const existing = listNotes(vault, [dir]).find((n) => path.basename(n).startsWith(`${date}`));
    newNote = existing ?? newNote;
    if (existing) read.add(existing);
  }

  const readOnly = new Set(cfg.readOnly);
  const write = new Set([...read].filter((r) => inDirs(r, cfg.writableDirs) && !readOnly.has(r) && !recent.has(r)));
  if (newNote && inDirs(newNote, cfg.writableDirs)) write.add(newNote);
  const sorted = (s) => [...s].sort();
  return { readRels: sorted(read), writeRels: sorted(write), newNote, keyword, notesTotal: notes.length };
}

// ---------------------------------------------------------------- 지시문

export function buildPrompt({ vault, cfg, sel, message, date }) {
  const instructions = readFileSync(safeJoin(vault, cfg.instructions), 'utf8').trim();
  const readOnlyList = sel.readRels.filter((r) => !sel.writeRels.includes(r));
  return `${instructions}

허용 수정 파일 (이 목록 밖은 찾지도 고치지도 않는다):
${sel.writeRels.map((r) => `- ${r}${r === sel.newNote && !existsSync(safeJoin(vault, r)) ? ' (새 파일)' : ''}`).join('\n')}

읽기 전용 참고 파일:
${readOnlyList.map((r) => `- ${r}`).join('\n')}

기준 날짜: ${date}
사용자 메시지:
${message}`;
}

// ---------------------------------------------------------------- 실행

function materialize(vault, workspace, sel) {
  for (const r of sel.readRels) {
    const target = safeJoin(workspace, r);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(safeJoin(vault, r)));
  }
  for (const r of sel.writeRels) mkdirSync(path.dirname(safeJoin(workspace, r)), { recursive: true });
}

function runCodex(workspace, prompt, outputPath) {
  const args = ['--ask-for-approval', 'never', 'exec', '--cd', workspace, '--skip-git-repo-check',
    '--sandbox', 'workspace-write', '--color', 'never', '--output-last-message', outputPath];
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', `& ${['codex', ...args].map((a) => `'${String(a).replace(/'/g, "''")}'`).join(' ')}`], { cwd: workspace, stdio: ['pipe', 'inherit', 'inherit'] })
      : spawn('codex', args, { cwd: workspace, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`codex exited ${code}`))));
    child.stdin.end(prompt);
  });
}

function changed(vault, workspace, sel) {
  const out = [];
  for (const r of sel.writeRels) {
    const next = safeJoin(workspace, r);
    if (!existsSync(next)) continue;
    const nextContent = readFileSync(next, 'utf8');
    const cur = safeJoin(vault, r);
    const existed = existsSync(cur);
    const current = existed ? readFileSync(cur, 'utf8') : null;
    if (current !== nextContent) out.push({ r, nextContent, existed, current, next });
  }
  return out;
}

function printDiff(vault, entries) {
  const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const e of entries) {
    const out = spawnSync('git', ['diff', '--no-index', '--color=never', '--', e.existed ? safeJoin(vault, e.r) : nul, e.next], { encoding: 'utf8' });
    process.stdout.write(`\n=== ${e.r}${e.existed ? '' : ' (새 파일)'}\n${out.stdout.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join('\n')}`);
  }
}

export function applyWrites(vault, entries) {
  if (!entries.length) return [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(vault, STATE_DIR, 'backup');
  rmSync(backupDir, { recursive: true, force: true });
  const manifest = [];
  for (const e of entries) {
    if (e.existed) {
      const b = safeJoin(backupDir, e.r);
      mkdirSync(path.dirname(b), { recursive: true });
      writeFileSync(b, e.current);
    }
    const target = safeJoin(vault, e.r);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, e.nextContent.endsWith('\n') ? e.nextContent : `${e.nextContent}\n`);
    manifest.push({ rel: e.r, existed: e.existed });
  }
  mkdirSync(path.join(vault, STATE_DIR), { recursive: true });
  writeFileSync(path.join(vault, STATE_DIR, 'last.json'), `${JSON.stringify({ at: stamp, changed: manifest }, null, 2)}\n`);
  return manifest.map((m) => m.rel);
}

export function undo(vault) {
  const file = path.join(vault, STATE_DIR, 'last.json');
  if (!existsSync(file)) return [];
  const { changed: entries } = JSON.parse(readFileSync(file, 'utf8'));
  for (const { rel: r, existed } of entries) {
    const target = safeJoin(vault, r);
    if (existed) writeFileSync(target, readFileSync(safeJoin(path.join(vault, STATE_DIR, 'backup'), r)));
    else rmSync(target, { force: true });
  }
  rmSync(file, { force: true });
  return entries.map((e) => e.rel);
}

// ---------------------------------------------------------------- CLI

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

async function main(argv) {
  const cmd = argv[0];
  const vault = path.resolve(arg(argv, '--vault') ?? process.cwd());
  if (cmd === 'undo') {
    const restored = undo(vault);
    console.log(restored.length ? `되돌림: ${restored.join(', ')}` : '되돌릴 반영이 없습니다.');
    return;
  }
  if (cmd !== 'plan' && cmd !== 'run') {
    console.error('usage: vault-agent.mjs plan|run --seed <노트> --message <문장> [--date YYYY-MM-DD] [--dry-run] [--vault <경로>] | undo');
    process.exit(2);
  }
  const cfg = loadConfig(vault);
  const seed = arg(argv, '--seed') ? rel(arg(argv, '--seed')) : undefined;
  const message = arg(argv, '--message') ?? '';
  const date = arg(argv, '--date') ?? today();
  if (seed && !existsSync(safeJoin(vault, seed))) throw new Error(`씨앗 노트가 없습니다: ${seed}`);
  const sel = selectFiles({ vault, cfg, seed, message, date });
  console.log(`노트 ${sel.notesTotal}개 중 읽기 ${sel.readRels.length}개, 수정 가능 ${sel.writeRels.length}개`);
  console.log(['읽기:', ...sel.readRels.map((r) => `  ${r}${sel.writeRels.includes(r) ? '' : '   (읽기 전용)'}`)].join('\n'));
  if (sel.newNote && !existsSync(safeJoin(vault, sel.newNote))) console.log(`새 파일: ${sel.newNote}`);
  if (cmd === 'plan') return;

  const workspace = mkdtempSync(path.join(tmpdir(), 'vault-agent-'));
  const outputPath = path.join(tmpdir(), `vault-agent-${process.pid}.md`);
  try {
    materialize(vault, workspace, sel);
    await runCodex(workspace, buildPrompt({ vault, cfg, sel, message, date }), outputPath);
    const reply = existsSync(outputPath) ? readFileSync(outputPath, 'utf8').trim() : '(답변 없음)';
    const entries = changed(vault, workspace, sel);
    if (argv.includes('--dry-run')) {
      printDiff(vault, entries);
      console.log(`\n(dry-run) 바뀔 파일 ${entries.length}개, 반영하지 않음`);
    } else {
      const applied = applyWrites(vault, entries);
      console.log(`반영: ${applied.length ? applied.join(', ') : '없음'} (되돌리기: node vault-agent.mjs undo)`);
    }
    console.log(`\n답변:\n${reply}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outputPath, { force: true });
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (import.meta.url === entry) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
