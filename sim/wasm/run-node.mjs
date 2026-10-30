// run-node.mjs : Wasm 版の模型を Node で回す。保存した状態から始め、プロンプトに合わせて行を打つ
//
//   node sim/wasm/run-node.mjs <保存ファイル (.state か .state.gz)> 'ls' 'cat /proc/cpuinfo' ...
//
// 模型 (sim.mjs) の場所は環境変数 SIM_MJS で渡す (make wasm-restore が build/<コア>/wasm/sim.mjs を渡す)。
//
// 打つ行が尽きた後のプロンプトで止まり、Wasm での模擬の速さ [クロック/秒] を出す。
// 行の渡し方は sim/main.cpp と同じ: 渡した行のエコーでプロンプトが一度消え、また出たら次の行
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const STOP_NONE = 0;
const STOP_PROMPT = 1;
const CHUNK = 200000;   // sim_run 1 回の上限 [クロック]
const MAX_CYCLES = 200e6;   // 読み戻してからの上限 (止まり損ねた時の保険)

const [statePath, ...lines] = process.argv.slice(2);
if (!statePath) {
    console.error('usage: node run-node.mjs <state file> [line ...]');
    process.exit(1);
}

if (!process.env.SIM_MJS) {
    console.error('run-node.mjs: SIM_MJS (the path of sim.mjs) is not set');
    process.exit(1);
}
const { default: createSim } = await import(pathToFileURL(resolve(process.env.SIM_MJS)).href);
const sim = await createSim();
const flushOut = () => {
    const len = sim._sim_out_len();
    if (len > 0) {
        process.stdout.write(Buffer.from(sim.HEAPU8.subarray(sim._sim_out_ptr(), sim._sim_out_ptr() + len)));
        sim._sim_out_clear();
    }
};

let t0 = performance.now();
const raw = readFileSync(statePath);
sim.stateBytes = statePath.endsWith('.gz') ? gunzipSync(raw) : raw;
sim.stateOffset = 0;
const tRead = (performance.now() - t0) / 1000;
if (sim._sim_restore() !== 0) process.exit(1);
sim.stateBytes = null;   // 読み終えたら手放す
console.error(`run-node: ${statePath} (${raw.length} bytes) read in ${tRead.toFixed(1)} s, ` +
              `restored at cycle ${sim._sim_cycle()} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const cycle0 = sim._sim_cycle();
t0 = performance.now();
let sentAny = false;
let leftPrompt = false;
let stop = sim._sim_run(0);   // 今の stop_code
for (;;) {
    if (stop === STOP_NONE) leftPrompt = true;
    if (stop !== STOP_NONE && stop !== STOP_PROMPT) break;
    if (stop === STOP_PROMPT && (!sentAny || leftPrompt)) {
        if (lines.length === 0) break;
        for (const ch of Buffer.from(lines.shift() + '\n')) sim._sim_send(ch);
        sentAny = true;
        leftPrompt = false;
    }
    if (sim._sim_cycle() - cycle0 > MAX_CYCLES) break;
    stop = sim._sim_run(CHUNK);
    flushOut();
}
flushOut();
const cycles = sim._sim_cycle() - cycle0;
const secs = (performance.now() - t0) / 1000;
console.error(`\nrun-node: stop_code=${stop}, cycle ${sim._sim_cycle()}, ${cycles} cycles in ${secs.toFixed(1)} s, ${Math.round(cycles / secs)} cycles/s`);
