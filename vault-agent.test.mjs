import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyWrites, buildPrompt, loadConfig, resolveLink, selectFiles, undo, wikiLinks } from './vault-agent.mjs';

function fixture() {
  const vault = mkdtempSync(path.join(tmpdir(), 'vault-agent-test-'));
  const put = (r, text) => {
    mkdirSync(path.dirname(path.join(vault, r)), { recursive: true });
    writeFileSync(path.join(vault, r), text);
  };
  put('vault-agent.json', JSON.stringify({
    readableDirs: ['00_기준', '01_루틴', '02_기록', '03_종목'],
    writableDirs: ['02_기록', '03_종목', '00_기준'],
    readOnly: ['00_기준/제약.md'],
    alwaysRead: ['00_기준/상태.md'],
    linkDepth: 2,
    recent: { dir: '02_기록', limit: 2 },
    newNote: '02_기록/{date}_{seed}.md',
    instructions: 'instructions.md',
  }));
  put('instructions.md', '너는 이 위키를 관리한다.\n안 말한 숫자는 "미기록".');
  put('00_기준/제약.md', '머신 체스트프레스 제외');
  put('00_기준/상태.md', '다음 1회: 미정');
  put('00_기준/비밀.md', '체중 00kg (링크되지 않은 노트)');
  put('01_루틴/0. 주간.md', '| 화 | [[2. 화_Pull]] |');
  put('01_루틴/2. 화_Pull.md', '- [[턱걸이]]\n- [[랫풀다운|랫풀]]\n- [[03_종목/덤벨 컬]]');
  put('03_종목/턱걸이.md', '# 턱걸이\n[[시티드 로우]]');
  put('03_종목/랫풀다운.md', '# 랫풀다운');
  put('03_종목/덤벨 컬.md', '# 덤벨 컬');
  put('03_종목/시티드 로우.md', '# 시티드 로우');
  put('03_종목/해머 컬.md', '# 해머 컬');
  put('02_기록/2026-06-20_토.md', 'a');
  put('02_기록/2026-06-23_화.md', 'b');
  put('02_기록/2026-06-25_목.md', 'c');
  put('02_기록/2026-06-30_화.md', 'd');
  return vault;
}

test('wikiLinks and resolveLink handle aliases, anchors, paths and spacing', () => {
  assert.deepEqual(wikiLinks('[[턱걸이]] [[랫풀다운|랫풀]] [[03_종목/덤벨 컬#목표]]'), ['턱걸이', '랫풀다운', '03_종목/덤벨 컬']);
  const notes = ['03_종목/덤벨 컬.md', '03_종목/턱걸이.md'];
  assert.equal(resolveLink('덤벨컬', notes), '03_종목/덤벨 컬.md');
  assert.equal(resolveLink('03_종목/턱걸이', notes), '03_종목/턱걸이.md');
  assert.equal(resolveLink('없음', notes), undefined);
});

test('selectFiles follows the seed graph to the given depth, adds keyword notes, recent notes and a new note', () => {
  const vault = fixture();
  const cfg = loadConfig(vault);
  const sel = selectFiles({ vault, cfg, seed: '01_루틴/2. 화_Pull.md', message: '해머 컬 8kg 10회, 없는 운동 3세트', date: '2026-06-26' });
  assert.deepEqual(sel.readRels, [
    '00_기준/상태.md', '00_기준/제약.md',
    '01_루틴/2. 화_Pull.md',
    '02_기록/2026-06-23_화.md', '02_기록/2026-06-25_목.md',
    '03_종목/덤벨 컬.md', '03_종목/랫풀다운.md', '03_종목/시티드 로우.md', '03_종목/턱걸이.md', '03_종목/해머 컬.md',
  ]);
  assert.ok(!sel.readRels.includes('00_기준/비밀.md'), '링크되지 않은 노트는 읽지 않는다');
  assert.deepEqual(sel.writeRels, [
    '00_기준/상태.md',
    '02_기록/2026-06-26_화_Pull.md',
    '03_종목/덤벨 컬.md', '03_종목/랫풀다운.md', '03_종목/시티드 로우.md', '03_종목/턱걸이.md', '03_종목/해머 컬.md',
  ]);
  assert.ok(!sel.writeRels.includes('00_기준/제약.md'), '읽기 전용은 수정 목록에 없다');
  assert.ok(!sel.writeRels.includes('01_루틴/2. 화_Pull.md'), '루틴 폴더는 writableDirs 가 아니다');
  assert.ok(!sel.writeRels.includes('02_기록/2026-06-25_목.md'), '최근 기록은 참고만 한다');
  assert.equal(sel.newNote, '02_기록/2026-06-26_화_Pull.md');
  rmSync(vault, { recursive: true, force: true });
});

test('selectFiles reuses an existing note for the date instead of creating a second one', () => {
  const vault = fixture();
  const cfg = loadConfig(vault);
  const sel = selectFiles({ vault, cfg, seed: '01_루틴/2. 화_Pull.md', message: '', date: '2026-06-30' });
  assert.equal(sel.newNote, '02_기록/2026-06-30_화.md');
  rmSync(vault, { recursive: true, force: true });
});

test('buildPrompt lists allowed and read-only files after the instructions', () => {
  const vault = fixture();
  const cfg = loadConfig(vault);
  const sel = selectFiles({ vault, cfg, seed: '01_루틴/2. 화_Pull.md', message: '턱걸이 5회', date: '2026-06-26' });
  const p = buildPrompt({ vault, cfg, sel, message: '턱걸이 5회', date: '2026-06-26' });
  assert.ok(p.startsWith('너는 이 위키를 관리한다.'));
  assert.ok(p.includes('- 02_기록/2026-06-26_화_Pull.md (새 파일)'));
  assert.ok(p.includes('읽기 전용 참고 파일:\n- 00_기준/제약.md'));
  assert.ok(p.endsWith('사용자 메시지:\n턱걸이 5회'));
  rmSync(vault, { recursive: true, force: true });
});

test('applyWrites snapshots the previous content and undo restores it, deleting files it created', () => {
  const vault = fixture();
  const entries = [
    { r: '03_종목/턱걸이.md', existed: true, current: readFileSync(path.join(vault, '03_종목/턱걸이.md'), 'utf8'), nextContent: '# 턱걸이\n- 2026-06-26: 5회' },
    { r: '02_기록/2026-06-26_화_Pull.md', existed: false, current: null, nextContent: '# 새 기록' },
  ];
  assert.deepEqual(applyWrites(vault, entries), ['03_종목/턱걸이.md', '02_기록/2026-06-26_화_Pull.md']);
  assert.equal(readFileSync(path.join(vault, '03_종목/턱걸이.md'), 'utf8'), '# 턱걸이\n- 2026-06-26: 5회\n');
  assert.ok(existsSync(path.join(vault, '02_기록/2026-06-26_화_Pull.md')));
  assert.deepEqual(undo(vault), ['03_종목/턱걸이.md', '02_기록/2026-06-26_화_Pull.md']);
  assert.equal(readFileSync(path.join(vault, '03_종목/턱걸이.md'), 'utf8'), '# 턱걸이\n[[시티드 로우]]');
  assert.ok(!existsSync(path.join(vault, '02_기록/2026-06-26_화_Pull.md')));
  assert.deepEqual(undo(vault), []);
  rmSync(vault, { recursive: true, force: true });
});

test('paths outside the vault are refused', () => {
  const vault = fixture();
  const cfg = loadConfig(vault);
  assert.throws(() => selectFiles({ vault, cfg: { ...cfg, alwaysRead: ['../x.md'] }, seed: undefined, message: '', date: '2026-06-26' }), /위키 밖 경로/);
  rmSync(vault, { recursive: true, force: true });
});
