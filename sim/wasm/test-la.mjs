// test-la.mjs : Logic Analyzer まわりの試験 (make wasm-test)
//
//   WEB=<web の場所> SIM_MJS=<sim.mjs> node sim/wasm/test-la.mjs <保存ファイル (.state.gz)>
//
// 1. rv-disasm.js が既知の符号を正しく読む (Zb*・特権・FP など、BusyBox に無い物)
// 2. 保存から ls を回し、ring を止めて、書き戻しの記録から組み立てた x レジスタがレジスタの窓と合う
//    (12 回、止める所を変えて)。最後のサンプルの書き込みは次の立ち上がりで入るので比べない
// 3. 止めた後に回しても、レジスタの写しは止めた時の物のまま
// 4. トリガーが発火した時の写しが、発火の前の書き込みと止まった時の写しに合う
// 5. 止めていた後の最初のサンプルに途切れの印が付く
// 6. 「事象のあるクロックだけ」で Hold しても、組み立てた値が窓と合う (写しが最後のサンプルより後でも)
// 7. 「事象のあるクロックだけ」の記録には、どのサンプルにも記録した訳があり、クロックを飛ばしている
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
globalThis.window = globalThis;
eval(readFileSync(process.env.WEB + '/rv-disasm.js', 'utf8'));
const { default: createSim } = await import(pathToFileURL(resolve(process.env.SIM_MJS)).href);
const sim = await createSim();
sim.stateBytes = gunzipSync(readFileSync(process.argv[2])); sim.stateOffset = 0;
if (sim._sim_restore() !== 0) throw new Error('restore');
const RS = sim._get_ring_size(), RW = sim._get_ring_words(), NR = sim._sim_reg_count();
console.log('ring', RS, 'x', RW, 'regs', NR);
let fails = 0;
// ring の [head - RS, upto) の書き込み (退役の書き戻しと 2 つ目の書き込み) から、レジスタごとの最後の値
const lastWrites = (ring, head, upto) => {
  const last = new Array(32).fill(null); let writes = 0;
  for (let s = Math.max(0, head - RS); s < upto; s++) {
    const b = (s & (RS - 1)) * RW;
    if (ring[b] & (1 << 13)) { last[ring[b + 9] & 31] = [ring[b + 6], ring[b + 7]]; writes++; }
    const r2 = ring[b + 9] >>> 27;
    if (r2) { last[r2] = [ring[b + 15], ring[b + 16]]; writes++; }
  }
  return { last, writes };
};
const matchRegs = (last, regs) => {
  let ok = 0; const bad = [];
  for (let r = 1; r < 32; r++) {
    if (!last[r]) continue;
    if (last[r][0] === regs[2 * r] && last[r][1] === regs[2 * r + 1]) ok++;
    else bad.push(`${RVDIS.ABI[r]} ring ${last[r][1].toString(16)}_${last[r][0].toString(16)} reg ${regs[2 * r + 1].toString(16)}_${regs[2 * r].toString(16)}`);
  }
  return { ok, bad };
};
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const KNOWN = [[0x28755513, 'orc.b a0,a0'], [0x6b855513, 'rev8 a0,a0'], [0x0045200f, 'cbo.zero (a0)'],
  [0x12000073, 'sfence.vma'], [0x30200073, 'mret'], [0x10200073, 'sret'], [0x10500073, 'wfi'],
  [0x18002573, 'csrr a0,satp'], [0x0ac59533, 'clmul a0,a1,a2'], [0x20c5a533, 'sh1add a0,a1,a2'],
  [0x40c5f533, 'andn a0,a1,a2'], [0x0805c53b, 'zext.h a0,a1'], [0x08c5853b, 'add.uw a0,a1,a2'],
  [0x28c59533, 'bset a0,a1,a2'], [0x60159513, 'ctz a0,a1'], [0x0ac5c533, 'min a0,a1,a2'],
  [0x14d02573, 'csrr a0,stimecmp'], [0x10079073, 'csrw sstatus,a5'], [0x00000073, 'ecall'],
  [0x0ff0000f, 'fence'], [0x0000100f, 'fence.i'], [0x02b50533, 'mul a0,a0,a1'], [0x02c5f553, 'fadd.d fa0,fa1,fa2'],
  [0x00b53027, 'fsd fa1,0(a0)'], [0x60c5d513, 'rori a0,a1,12'], [0x4885d513, 'bexti a0,a1,8'],
  [0x7131, 'addi sp,sp,-192'], [0x8082, 'ret'], [0x853e, 'mv a0,a5'], [0x2501, 'sext.w a0,a0'],
  [0x160736af, 'lr.d.aqrl a3,(a4)'], [0x00a02533, 'sgtz a0,a0']];
const badDis = KNOWN.filter(([i, want]) => RVDIS.disasm(i) !== want).map(([i, want]) => i.toString(16) + ' ' + want + ' got ' + RVDIS.disasm(i));
check(badDis.length === 0, `disassembler reads ${KNOWN.length} known encodings` + (badDis.length ? ': ' + badDis.join('; ') : ''));
const runUntilPrompt = (line) => {
  for (const c of Buffer.from(line + '\n')) sim._sim_send(c);
  let left = false;
  for (let i = 0; i < 2000; i++) { const st = sim._sim_run(100000); if (st === 0) left = true; if (st === 1 && left) return true; }
  return false;
};
const t0 = performance.now(), c0 = sim._sim_cycle();
check(runUntilPrompt('ls /'), 'ls / returns to the prompt');
const rate = (sim._sim_cycle() - c0) / ((performance.now() - t0) / 1000);
console.log('rate', Math.round(rate), 'cycles/s');
const out = Buffer.from(sim.HEAPU8.subarray(sim._sim_out_ptr(), sim._sim_out_ptr() + sim._sim_out_len())).toString();
check(/bin/.test(out) && /proc/.test(out), 'ls output has bin and proc');
// 走らせながら止め、窓と記録を比べる (何度か)
for (let trial = 0; trial < 12; trial++) {
  sim._sim_thaw_ring();
  for (const c of Buffer.from('echo hi\n')) sim._sim_send(c);
  sim._sim_run(30000 + trial * 7777);
  sim._sim_freeze_ring();
  const rp = sim._sim_regs() >>> 2;
  const regs = sim.HEAPU32.slice(rp, rp + NR * 2);
  check(sim._sim_regs_frozen() === 1, `trial ${trial}: regs snapshot is the frozen one`);
  sim._sim_run(5000);   // 止めた後に回しても、写しは変わらない
  const rp2 = sim._sim_regs() >>> 2;
  check(sim.HEAPU32.slice(rp2, rp2 + NR * 2).every((v, k) => v === regs[k]), `trial ${trial}: snapshot stays while frozen`);
  const rb = sim._get_ring_ptr() >>> 2, ring = sim.HEAPU32.slice(rb, rb + RS * RW), head = sim._get_head() >>> 0;
  // 最後のサンプルの書き込みは次の立ち上がりで入るので、窓にはまだ無い (ページは記録を優先する)
  const { last, writes } = lastWrites(ring, head, head - 1);
  const { ok, bad } = matchRegs(last, regs);
  check(sim._sim_regs_cycle() % 4294967296 === ring[((head - 1) & (RS - 1)) * RW + 14], `trial ${trial}: snapshot taken on the clock of the last sample`);
  check(bad.length === 0 && ok > 5, `trial ${trial}: ${writes} writebacks, ${ok} regs match the window` + (bad.length ? ' ' + bad.join('; ') : ''));
  check(regs[0] === 0 && regs[1] === 0, `trial ${trial}: x0 is 0`);
  const priv = regs[2 * 64] & 3, satp = regs[2 * 83 + 1].toString(16) + regs[2 * 83].toString(16).padStart(8, '0');
  console.log(`  priv=${'US?M'[priv]} sp=${regs[5].toString(16)}${regs[4].toString(16).padStart(8, '0')} satp=${satp} mtime=${regs[2 * 87]}`);
  check(satp.startsWith('8'), `trial ${trial}: satp mode is Sv39 (8)`);
}
// トリガーが発火した時の写し: 発火より前の最後の書き込みと合い、発火から止まるまで書いていなければ止まった時の写しと合う
{
  // Thaw の後 ls を 2 万クロック回してからトラップの立ち上がりで止める (発火の前にも書き込みがあるように)
  sim._sim_clear_trigger();
  sim._sim_thaw_ring();
  for (const c of Buffer.from('ls /\n')) sim._sim_send(c);
  sim._sim_run(20000);
  sim._sim_set_post_delay(3000);
  sim._sim_set_edge_trigger(0, 1, 0);   // トラップの立ち上がり
  check(sim._sim_regs_fire() === 0, 'no fire snapshot before the trigger');
  for (let i = 0; i < 200 && !sim._sim_trigger_hit(); i++) sim._sim_run(10000);
  check(sim._sim_trigger_hit() === 1, 'trap trigger fired and froze');
  const fp = sim._sim_regs_fire() >>> 2, fire = sim.HEAPU32.slice(fp, fp + NR * 2);
  const ep = sim._sim_regs() >>> 2, end = sim.HEAPU32.slice(ep, ep + NR * 2);
  const rb = sim._get_ring_ptr() >>> 2, ring = sim.HEAPU32.slice(rb, rb + RS * RW), head = sim._get_head() >>> 0;
  const fh = sim._sim_get_trig_fire_head();
  // 途切れの印は Thaw の所に 1 つだけ。ring から押し出されていれば、ring の頭から
  let segStart = Math.max(0, head - RS), marks = 0;
  for (let s = segStart; s < head; s++) if (ring[(s & (RS - 1)) * RW + 9] & (1 << 26)) { segStart = s; marks++; }
  check(marks <= 1 && segStart < fh, `at most one gap mark, before the trigger (${marks})`);
  let before = 0, untouched = 0; const bad = [];
  for (let r = 1; r < 32; r++) {
    let last = null, after = false;
    for (let s = segStart; s < head; s++) {
      const b = (s & (RS - 1)) * RW;
      if (!(ring[b] & (1 << 13)) || (ring[b + 9] & 31) !== r) continue;
      if (s < fh - 1) last = [ring[b + 6], ring[b + 7]];   // 発火のサンプル (fh - 1) で書いた値はまだ写しに無い
      else if (s <= head - 2) after = true;
    }
    if (last) {
      before++;
      if (last[0] !== fire[2 * r] || last[1] !== fire[2 * r + 1]) bad.push('before ' + RVDIS.ABI[r] + ` ring ${last[1].toString(16)}_${last[0].toString(16)} fire ${fire[2 * r + 1].toString(16)}_${fire[2 * r].toString(16)} head ${head} fh ${fh}`);
    }
    if (!after) {
      untouched++;
      if (fire[2 * r] !== end[2 * r] || fire[2 * r + 1] !== end[2 * r + 1]) bad.push('untouched ' + RVDIS.ABI[r]);
    }
  }
  check(bad.length === 0 && before > 10, `fire snapshot: ${before} regs match writes before the trigger, ${untouched} match the end` + (bad.length ? ' ' + bad.join(', ') : ''));
  sim._sim_clear_trigger();
  sim._sim_set_post_delay(0);
  check(sim._sim_regs_fire() === 0, 'fire snapshot dropped when the trigger is cleared');
}
// 途切れの印: 止めて回した後、Thaw した次のサンプルに付き、その次には付かない
{
  sim._sim_freeze_ring();
  sim._sim_run(1000);
  const h0 = sim._get_head() >>> 0;
  sim._sim_thaw_ring();
  sim._sim_run(10);
  const rb = sim._get_ring_ptr() >>> 2, ring = sim.HEAPU32.slice(rb, rb + RS * RW);
  const mark = (s) => (ring[(s & (RS - 1)) * RW + 9] >>> 26) & 1;
  check(mark(h0) === 1 && mark(h0 + 1) === 0 && mark(h0 - 1) === 0, 'gap mark on the first sample after a thaw only');
}
// 事象のあるクロックだけで Hold: 写しが最後のサンプルより後のクロックなら、その書き込みも含む
sim._sim_set_sample_mode(1);
for (let trial = 0; trial < 6; trial++) {
  sim._sim_thaw_ring();
  for (const c of Buffer.from('echo hi\n')) sim._sim_send(c);
  sim._sim_run(40000 + trial * 997);
  sim._sim_freeze_ring();
  const rp = sim._sim_regs() >>> 2, regs = sim.HEAPU32.slice(rp, rp + NR * 2);
  const rb = sim._get_ring_ptr() >>> 2, ring = sim.HEAPU32.slice(rb, rb + RS * RW), head = sim._get_head() >>> 0;
  const incl = sim._sim_regs_cycle() % 4294967296 !== ring[((head - 1) & (RS - 1)) * RW + 14];
  const { last, writes } = lastWrites(ring, head, incl ? head : head - 1);
  const { ok, bad } = matchRegs(last, regs);
  check(bad.length === 0 && ok > 5, `events mode hold ${trial}: ${writes} writes, ${ok} regs match (snapshot ${incl ? 'after' : 'on'} the last sample)` + (bad.length ? ' ' + bad.join('; ') : ''));
}
// 事象のあるクロックだけ
sim._sim_thaw_ring();
sim._sim_run(100000);
sim._sim_freeze_ring();
{
  const rb = sim._get_ring_ptr() >>> 2, ring = sim.HEAPU32.slice(rb, rb + RS * RW), head = sim._get_head() >>> 0;
  // 記録したサンプルはどれも、事象があるか、2 つ目の書き込みがあるか、遅い信号が前のサンプルから変わった
  const slow = (b) => [ring[b] & 0x07e0, ring[b + 9] & 0x03fc0fe0, ring[b + 13]].join(',');
  let n = 0, why = 0;
  for (let s = head - 2000; s < head; s++) {
    const b = (s & (RS - 1)) * RW, p = ((s - 1) & (RS - 1)) * RW;
    n++;
    if ((ring[b] & 0x1803) || (ring[b + 9] >>> 27) || slow(b) !== slow(p) || (ring[b + 9] & (1 << 26))) why++;
  }
  check(n === why, `sample mode 1: all ${n} recent samples have a reason to be recorded`);
  const c1 = ring[((head - 1) & (RS - 1)) * RW + 14], c0 = ring[((head - 2000) & (RS - 1)) * RW + 14];
  check(c1 - c0 > 2000, `sample mode 1 skips clocks: 2000 samples span ${c1 - c0} clocks`);
  const insns = [];
  for (let s = head - 8; s < head; s++) { const b = (s & (RS - 1)) * RW; if (ring[b] & 1) insns.push(ring[b + 1].toString(16) + ': ' + RVDIS.disasm(ring[b + 2], ring[b + 1])); }
  console.log('  ' + insns.join('\n  '));
}
console.log(fails ? `FAILED ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
