// worker.js : Wasm 版の模型を Worker で回す (sim/wasm/harness.cpp の口を使う)
//
// 画面 (index.html) との受け渡し:
//   受け: {type: 'key', bytes: [..]}         打った字
//         LogicAnalyzer の制御 (soft-FPGA の sft-la-glue.js の setupLaWorker が送る):
//         freezeRing / thawRing / setLA{enabled} / setPostDelay{n} / clearTrigger /
//         setEdgeTrigger{word,bit,dir} / setValueTrigger{word,mask,cmp}
//   送り: {type: 'status', id, ...}           読み込みの進み。文言はページが言語に合わせて作る
//                                             (id: wasm / fetch / restore / running{size,tFetch,tRestore})
//         {type: 'ready', ringSize, ringWords}  LogicAnalyzer を組み立ててよい
//         {type: 'out', bytes: Uint8Array}    UART から出た字
//         {type: 'frame', laAck, head, frozen, trigFireHead, ringSnap}  ring の写し (setupLaWorker の frame)
//           frame には regs (レジスタの窓、2 語ずつの Uint32Array の ArrayBuffer)、regsFrozen (止まった時の値か)、
//           regsFire (トリガーが発火した時の写し。無ければ null)、regsCycle (regs を取った時のクロック数) も載せる。
//           head はいつも、最後に送った ring の写しの head (写しを送らない frame で先へ進めると、古い写しを
//           新しい head で読んでしまう)
//         {type: 'stats', cycle, rate}        クロック数と速さ [クロック/秒]
//   受け: {type: 'sampleMode', mode}           ring に書く時 (0 毎クロック、1 事象のあるクロックだけ)
//         {type: 'error', text}
import createSim from './sim.mjs';

const SLICE_MS = 30;        // 1 回に回す時間。この合間に打鍵と制御を受ける
const RUN_CYCLES = 2000;    // sim_run 1 回の上限 [クロック]
const STATS_MS = 1000;
const RUN_FRAME_MS = 100;   // 動いている間に ring とレジスタを写す間隔 (ring は 1 MB ほどある)

let sim = null;
let laAck = 0;      // 処理した LogicAnalyzer の制御の数
let laDirty = true; // 止めた ring でも、制御が来たら 1 度は写しを送る

const LA_CONTROL = {
    freezeRing: () => sim._sim_freeze_ring(),
    thawRing: () => sim._sim_thaw_ring(),
    setLA: (m) => sim._sim_set_la(m.enabled ? 1 : 0),
    setPostDelay: (m) => sim._sim_set_post_delay(m.n | 0),
    clearTrigger: () => sim._sim_clear_trigger(),
    setEdgeTrigger: (m) => sim._sim_set_edge_trigger(m.word, m.bit, m.dir),
    setValueTrigger: (m) => sim._sim_set_value_trigger(m.word, m.mask, m.cmp),
};

self.onmessage = (e) => {
    const m = e.data;
    if (!sim) return;
    if (m.type === 'key') {
        for (const b of m.bytes) sim._sim_send(b);
    } else if (m.type === 'sampleMode') {
        sim._sim_set_sample_mode(m.mode | 0);
    } else if (LA_CONTROL[m.type]) {
        LA_CONTROL[m.type](m);
        laAck++;
        laDirty = true;
    }
};

async function fetchGunzip(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function flushOut() {
    const len = sim._sim_out_len();
    if (len === 0) return;
    const ptr = sim._sim_out_ptr();
    self.postMessage({ type: 'out', bytes: sim.HEAPU8.slice(ptr, ptr + len) });
    sim._sim_out_clear();
}

// ring とレジスタの写しを送る。止めた (Hold・トリガー) ring は変わらないので、止まった直後と制御が来た時だけ写す。
// 動いている間は RUN_FRAME_MS ごとに写す (毎回写すと重い)
let wasFrozen = false;
let lastSnap = 0;
let snapHead = 0;   // 最後に送った ring の写しの head。写しを送らない frame もこの head を送る (写しと合わせる)
function readRegs() {
    const ptr = sim._sim_regs() >>> 2;
    return sim.HEAPU32.slice(ptr, ptr + sim._sim_reg_count() * 2).buffer;
}
// トリガーが発火した時の写し (無ければ null)
function readFireRegs() {
    const ptr = sim._sim_regs_fire() >>> 2;
    return ptr ? sim.HEAPU32.slice(ptr, ptr + sim._sim_reg_count() * 2).buffer : null;
}
function postFrame() {
    const frozen = !!sim._sim_ring_frozen();
    const now = performance.now();
    let ringSnap = new ArrayBuffer(0);
    let regs = null;
    let regsFire = null;
    if ((!frozen && now - lastSnap >= RUN_FRAME_MS) || (frozen && !wasFrozen) || laDirty) {
        const base = sim._get_ring_ptr() >>> 2;
        const n = sim._get_ring_size() * sim._get_ring_words();
        ringSnap = sim.HEAPU32.slice(base, base + n).buffer;
        regs = readRegs();
        regsFire = readFireRegs();
        snapHead = sim._get_head() >>> 0;
        laDirty = false;
        lastSnap = now;
    }
    wasFrozen = frozen;
    const transfer = [ringSnap, regs, regsFire].filter((b) => b);
    self.postMessage({
        type: 'frame', laAck, head: snapHead, frozen, regsCycle: sim._sim_regs_cycle(),
        trigFireHead: sim._sim_get_trig_fire_head(), ringSnap, regs, regsFire,
        regsFrozen: !!sim._sim_regs_frozen(),
    }, transfer);
}

async function main() {
    self.postMessage({ type: 'status', id: 'wasm' });
    sim = await createSim();
    self.postMessage({ type: 'ready', ringSize: sim._get_ring_size(), ringWords: sim._get_ring_words() });

    self.postMessage({ type: 'status', id: 'fetch' });
    let t0 = performance.now();
    sim.stateBytes = await fetchGunzip('state.gz');
    sim.stateOffset = 0;
    const tFetch = (performance.now() - t0) / 1000;

    self.postMessage({ type: 'status', id: 'restore' });
    t0 = performance.now();
    if (sim._sim_restore() !== 0) throw new Error('sim_restore failed');
    const size = sim.stateBytes.length;
    sim.stateBytes = null;
    const tRestore = (performance.now() - t0) / 1000;
    self.postMessage({ type: 'status', id: 'running', size, tFetch, tRestore });

    let lastCycle = sim._sim_cycle();
    let lastStats = performance.now();
    const slice = () => {
        const end = performance.now() + SLICE_MS;
        while (performance.now() < end) sim._sim_run(RUN_CYCLES);
        flushOut();
        postFrame();
        const now = performance.now();
        if (now - lastStats >= STATS_MS) {
            const cycle = sim._sim_cycle();
            self.postMessage({ type: 'stats', cycle, rate: ((cycle - lastCycle) * 1000) / (now - lastStats) });
            lastCycle = cycle;
            lastStats = now;
        }
        setTimeout(slice, 0);
    };
    // 保存した時点のプロンプト "# " は出力済みで、読み戻した模型からは出ない。画面に出しておく
    self.postMessage({ type: 'out', bytes: new TextEncoder().encode('# ') });
    slice();
}

main().catch((err) => self.postMessage({ type: 'error', text: String(err) }));
